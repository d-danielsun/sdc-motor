// Ações do console: tudo que uma pessoa do financeiro faz numa exceção. Cada uma reentra no fluxo normal.
import { CONSOLE_CONFIG_KEYS, EXC_TYPES, fail, type ActionResult, type ConsoleConfigKey, type HealthReport, type NotificationsProgress, type ConsoleQueries } from "../console.js";
import { ensureCustomer } from "../customers.js";
import { TOLERANCE_MAX_BRL } from "../limits.js";
import { toCents } from "../money.js";
import { FilaJaTemPendente, type Deps } from "../ports.js";
import { RECEIVED_STATUSES, receivePayment } from "../receive.js";
import { externalRefForPartner, type ExceptionType } from "../types.js";
import { handleInvoice } from "./handleInvoice.js";
import type { ReconcileSummary } from "./reconcileDaily.js";
import type { SyncSummary } from "./syncInvoices.js";
import { apiKeyAgeDays, type WatchdogSummary } from "./watchdog.js";

type OpenException = NonNullable<Awaited<ReturnType<Deps["repo"]["exceptions"]["get"]>>>;
async function openException(deps: Deps, id: number): Promise<{ ok: true; ex: OpenException } | { ok: false; error: ActionResult }> {
  const ex = await deps.repo.exceptions.get(id);
  if (!ex) return { ok: false, error: fail("not_found", "exceção não existe") };
  if (ex.status !== "open") return { ok: false, error: fail("invalid_state", `exceção já está ${ex.status}`) };
  return { ok: true, ex };
}

export async function resolveException(deps: Deps, id: number, by: string, status: "resolved" | "ignored" = "resolved"): Promise<ActionResult> {
  const r = await openException(deps, id);
  if (!r.ok) return r.error;
  await deps.repo.exceptions.setStatus(id, status, by);
  return { ok: true, action: status };
}

/** Reprocessar: o evento volta a 'pending' / a fatura é relida — o mesmo caminho de sempre, sem atalho. */
export async function reprocessException(deps: Deps, id: number, by: string): Promise<ActionResult> {
  const { repo, odoo } = deps;
  const r = await openException(deps, id);
  if (!r.ok) return r.error;
  const ex = r.ex;
  const d = (ex.detail ?? {}) as Record<string, unknown>;
  const byType: Partial<Record<ExceptionType, () => Promise<ActionResult>>> = {
    payment_unmatched: async () => {
      if (ex.refTable === "charges" && ex.refId !== null) {   // wizard falhou: reabre a cobrança e reenfileira o evento
        await repo.charges.transition(ex.refId, ["exception"], "created");
      }
      return requeueAsaasEvent(deps, ex.refTable === "webhook_events" ? ex.refId : null, d.asaasPaymentId);
    },
    amount_divergent: async () => requeueAsaasEvent(deps, null, d.asaasPaymentId),
    writeoff_needed: async () => requeueAsaasEvent(deps, null, d.asaasPaymentId),
    customer_missing_document: async () => {
      if (ex.refId === null) return fail("invalid_state", "exceção sem parceiro");
      const c = await ensureCustomer(deps, ex.refId);
      if (!c?.asaasCustomerId) return fail("invalid_state", "cliente continua sem CPF/CNPJ válido (ou inexistente) no Odoo");
      let created = 0, processed = 0;
      for (const inv of await odoo.searchInvoices({ partnerId: ex.refId, limit: 200 })) { processed++; created += (await handleInvoice(deps, inv)).created; }
      if (processed === 0) return fail("invalid_state", "cliente sincronizado, mas nenhuma fatura postada encontrada — a varredura pega as próximas");
      return { ok: true, action: "customer_synced", detail: { asaasCustomerId: c.asaasCustomerId, invoicesProcessed: processed, chargesCreated: created } };
    },
    charge_create_failed: async () => {
      if (ex.refTable === "odoo_events" && ex.refId !== null) {
        // `reset` levanta `FilaJaTemPendente` quando já existe outra notificação pendente da mesma
        // fatura (o índice único da 0008). Traduzir o erro sem tratar a resposta deixava o botão
        // "reprocessar" devolvendo 500 "internal error" para um estado perfeitamente explicável.
        try {
          await repo.odooEvents.reset(ex.refId);
        } catch (e) {
          if (e instanceof FilaJaTemPendente) return fail("invalid_state", "já existe uma notificação pendente desta fatura na fila — o worker vai processá-la; não precisa reenfileirar");
          throw e;
        }
        return { ok: true, action: "odoo_event_requeued" };
      }
      const moveId = typeof d.odooId === "number" ? d.odooId : null;
      const inv = moveId ? await odoo.getInvoice(moveId) : null;
      if (!inv) return fail("invalid_state", "não sei qual fatura reprocessar — a varredura (sync-invoices) tenta de novo sozinha");
      return { ok: true, action: "invoice_reprocessed", detail: await handleInvoice(deps, inv) };
    },
    queue_interrupted: async () => {
      const whId = await repo.config.get<string | null>("ASAAS_WEBHOOK_ID");
      if (!whId) return fail("config", "ASAAS_WEBHOOK_ID não configurado");
      await deps.asaas.updateWebhook(whId, { interrupted: false });
      return { ok: true, action: "webhook_reactivated" };
    },
  };
  const run = byType[ex.type];
  if (!run) return fail("invalid_state", `tipo ${ex.type} não tem reprocessamento automático — resolva manualmente`);
  const result = await run();
  if (result.ok) await repo.exceptions.setStatus(id, "resolved", by);
  return result;
}

async function requeueAsaasEvent(deps: Deps, eventId: number | null, asaasPaymentId: unknown): Promise<ActionResult> {
  const { repo } = deps;
  const ev = eventId !== null ? { id: eventId } : typeof asaasPaymentId === "string" ? await repo.asaasEvents.findByPayment(asaasPaymentId, "PAYMENT_RECEIVED") : null;
  if (!ev) return fail("invalid_state", "evento do Asaas não encontrado — o reconcile-daily pega pelo próprio Asaas");
  await repo.asaasEvents.reset(ev.id);
  return { ok: true, action: "asaas_event_requeued", detail: { eventId: ev.id } };
}

/** Q3 na prática: o financeiro aceita juros/multa deste pagamento e a baixa acontece pelo valor recebido — se ele ainda está recebido. */
export async function acceptWriteoff(deps: Deps, id: number, by: string): Promise<ActionResult> {
  const r = await openException(deps, id);
  if (!r.ok) return r.error;
  if (r.ex.type !== "writeoff_needed") return fail("invalid_state", "só vale para writeoff_needed");
  const paymentId = (r.ex.detail as { asaasPaymentId?: string } | null)?.asaasPaymentId;
  const p = paymentId ? await deps.asaas.getPayment(paymentId) : null;
  if (!p) return fail("upstream", "pagamento não encontrado no Asaas");
  if (p.deleted || !(RECEIVED_STATUSES as readonly string[]).includes(p.status)) return fail("invalid_state", `pagamento não está mais recebido no Asaas (status ${p.status}${p.deleted ? ", apagado" : ""})`);
  const outcome = await receivePayment(deps, p, "console", { acceptWriteoff: true });
  if (outcome === "busy") return fail("busy", "cobrança em uso por outra execução — tente de novo");
  if (outcome !== "received" && outcome !== "already") return fail("invalid_state", `baixa não aconteceu: ${outcome}`);
  await deps.repo.exceptions.setStatus(id, "resolved", by);
  return { ok: true, action: "writeoff_accepted", detail: { outcome } };
}

/** Gate R3: liga a régua para os clientes existentes E como política para os próximos. */
/**
 * Liga a régua do Asaas para os clientes já sincronizados.
 *
 * Isto era uma requisição HTTP que ia até o fim: uma chamada ao Asaas por cliente, em série,
 * dentro do request. Com base grande, o request morre no timeout do proxy no meio do caminho, e
 * ninguém sabe quantos clientes já foram — reexecutar chamava tudo de novo.
 *
 * Agora é um trabalho em segundo plano, retomável por construção: só chama o Asaas para quem
 * ainda está com `notificationDisabled = true`, e grava progresso em `NOTIFICATIONS_PROGRESS`
 * a cada cliente. Retomar é simplesmente rodar de novo.
 */
export async function enableCustomerNotifications(deps: Deps): Promise<NotificationsProgress> {
  const { repo, asaas, clock, log } = deps;
  await repo.config.set("NOTIFICATIONS_ENABLED", true);   // política para os PRÓXIMOS clientes
  const pendentes = (await repo.customers.listSynced()).filter((c) => c.asaasCustomerId);
  const p: NotificationsProgress = { total: pendentes.length, updated: 0, failed: 0, at: clock.now().toISOString(), ok: false };
  await repo.config.set("NOTIFICATIONS_PROGRESS", p);

  for (const c of pendentes) {
    try {
      // Quem já está com notificação ligada não é rechamado: é o que faz retomar ser barato.
      const atual = await asaas.findCustomerByExternalRef(externalRefForPartner(c.odooPartnerId));
      if (atual && atual.notificationDisabled === false) { p.updated++; continue; }
      await asaas.updateCustomer(c.asaasCustomerId!, { notificationDisabled: false });
      p.updated++;
    } catch (e) {
      p.failed++;
      log("falha ao ligar notificações", { partner: c.odooPartnerId, error: (e as Error).message });
    }
    p.at = clock.now().toISOString();
    await repo.config.set("NOTIFICATIONS_PROGRESS", p).catch(() => undefined);   // progresso não derruba o trabalho
  }
  p.ok = p.failed === 0;
  p.at = clock.now().toISOString();
  await repo.config.set("NOTIFICATIONS_PROGRESS", p);
  log("enable-notifications", { ...p });
  return p;
}

/**
 * Reenfileira, em lote, os eventos em `error` das exceções ABERTAS de um tipo.
 *
 * O caso real: o Odoo ficou fora por duas horas, cinquenta eventos esgotaram os retries e viraram
 * `error`, cada um com sua exceção. Resolver isso um clique por vez é o tipo de trabalho que
 * ninguém faz — e evento em `error` não volta sozinho.
 *
 * A exceção NÃO é resolvida aqui. Quem resolve é o worker ao processar com sucesso, ou uma pessoa
 * que olhou. Marcar como resolvida antes de o trabalho acontecer é mentir para a próxima pessoa.
 */
export async function requeueAllByType(deps: Deps, tipo: string): Promise<ActionResult> {
  const { repo } = deps;
  if (!(EXC_TYPES as readonly string[]).includes(tipo)) return fail("invalid_input", `tipo de exceção inválido: ${tipo}`);
  let requeued = 0, skipped = 0;
  for (const ex of await repo.exceptions.listOpenWithEvent(tipo as ExceptionType)) {
    const fila = ex.refTable === "webhook_events" ? repo.asaasEvents : repo.odooEvents;
    try {
      // Só o que está em `error`: evento em `pending` ou `processing` já está sendo cuidado, e
      // mexer nele reenfileiraria trabalho em voo.
      const voltou = await fila.requeueFromError(ex.refId);
      if (voltou) requeued++; else skipped++;
    } catch (e) {
      // Só a colisão do índice parcial vira `ignored`, e na fila CERTA — a versão anterior
      // escrevia sempre em `odoo_events`, e como as duas tabelas têm sequência própria começando
      // em 1, isso marcava como ignorada uma notificação sem relação nenhuma, cujo boleto então
      // nunca era emitido. Achado do verificador da #15.
      skipped++;
      if (e instanceof FilaJaTemPendente) {
        await fila.mark(ex.refId, "ignored", { error: `não reenfileirado: ${e.message}` }).catch(() => undefined);
      } else {
        deps.log("requeue-all: evento não reenfileirado", { excecaoId: ex.id, fila: ex.refTable, eventoId: ex.refId, error: (e as Error).message });
      }
    }
  }
  return { ok: true, action: "requeued", detail: { requeued, skipped } };
}

const validators: Record<ConsoleConfigKey, (v: unknown) => boolean> = {
  IDA_ENABLED: (v) => typeof v === "boolean",
  JUROS_MULTA_AUTO: (v) => typeof v === "boolean",
  TOLERANCE_BRL: (v) => (typeof v === "string" || typeof v === "number") && /^\d+(\.\d{1,2})?$/.test(String(v)) && toCents(String(v)) <= toCents(TOLERANCE_MAX_BRL),
  GO_LIVE_CUTOFF_DATE: (v) => v === null || (typeof v === "string" && isIsoDate(v)),
  RECONCILE_LOOKBACK_DAYS: (v) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 30,
};
export const isIsoDate = (v: string): boolean => { if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false; const d = new Date(`${v}T00:00:00Z`); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; };

export async function setConsoleConfig(deps: Deps, key: string, value: unknown): Promise<ActionResult> {
  if (!(CONSOLE_CONFIG_KEYS as readonly string[]).includes(key)) return fail("invalid_input", `chave não editável: ${key}`);
  const k = key as ConsoleConfigKey;
  if (!validators[k](value)) return fail("invalid_input", `valor inválido para ${k}`);
  // Ligar a ida sem data de corte emitiria boleto pro histórico inteiro do Odoo na primeira varredura (red team).
  if (k === "IDA_ENABLED" && value === true && !(await deps.repo.config.get<string | null>("GO_LIVE_CUTOFF_DATE"))) return fail("invalid_state", "defina GO_LIVE_CUTOFF_DATE antes de ligar IDA_ENABLED");
  if (k === "GO_LIVE_CUTOFF_DATE" && value === null && (await deps.repo.config.get<boolean>("IDA_ENABLED")) === true) return fail("invalid_state", "desligue IDA_ENABLED antes de remover a data de corte");
  await deps.repo.config.set(k, k === "TOLERANCE_BRL" ? String(value) : value);
  return { ok: true, action: "config_set", detail: { key: k, value } };
}

export async function healthReport(deps: Deps, queries: ConsoleQueries): Promise<HealthReport> {
  const { repo, asaas, clock } = deps;
  const whId = await repo.config.get<string | null>("ASAAS_WEBHOOK_ID");
  let wh: { interrupted: boolean; penalizedRequestsCount: number } | null = null;
  try { wh = whId ? await asaas.getWebhook(whId) : null; } catch { wh = null; }
  const keyCreated = await repo.config.get<string | null>("ODOO_API_KEY_CREATED_AT");
  return {
    idaEnabled: (await repo.config.get<boolean>("IDA_ENABLED")) === true,
    notificationsEnabled: (await repo.config.get<boolean>("NOTIFICATIONS_ENABLED")) === true,
    openCharges: await repo.charges.countOpen(), openExceptionsByType: await repo.exceptions.countOpenByType(),
    lastAsaasEventAt: (await repo.asaasEvents.lastReceivedAt())?.toISOString() ?? null, lastOdooEventAt: await queries.lastOdooEventAt(),
    // Tipado por job: quem grava é o próprio caso de uso, então o tipo é o dele. `app_config` é
    // jsonb, então o cast é inevitável — mas fica num lugar só, e não espalhado pela UI.
    lastSync: await repo.config.get<SyncSummary>("SYNC_LAST"),
    lastReconcile: await repo.config.get<ReconcileSummary>("RECONCILE_LAST"),
    lastWatchdog: await repo.config.get<WatchdogSummary>("WATCHDOG_LAST"),
    notificationsProgress: await repo.config.get<NotificationsProgress>("NOTIFICATIONS_PROGRESS"),
    webhook: { id: whId, interrupted: wh?.interrupted ?? null, penalizedRequestsCount: wh?.penalizedRequestsCount ?? null },
    odooApiKeyAgeDays: keyCreated ? apiKeyAgeDays(keyCreated, clock.now()) : null,
  };
}
