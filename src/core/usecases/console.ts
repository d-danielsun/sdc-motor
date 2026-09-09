// Ações do console: tudo que uma pessoa do financeiro faz numa exceção. Cada uma reentra no fluxo normal.
import { ensureCustomer } from "../customers.js";
import type { Deps } from "../ports.js";
import { receivePayment } from "../receive.js";
import type { ExceptionType } from "../types.js";
import { handleInvoice } from "./handleInvoice.js";
import { CONSOLE_CONFIG_KEYS, type ConsoleConfigKey } from "../console.js";

export type ActionResult = { ok: true; action: string; detail?: unknown } | { ok: false; error: string };

export async function resolveException(deps: Deps, id: number, by: string, status: "resolved" | "ignored" = "resolved"): Promise<ActionResult> {
  const ex = await deps.repo.exceptions.get(id);
  if (!ex) return { ok: false, error: "exceção não existe" };
  await deps.repo.exceptions.setStatus(id, status, by);
  return { ok: true, action: status };
}

/** Reprocessar: o evento volta a 'pending' / a fatura é relida — o mesmo caminho de sempre, sem atalho. */
export async function reprocessException(deps: Deps, id: number, by: string): Promise<ActionResult> {
  const { repo, odoo } = deps;
  const ex = await repo.exceptions.get(id);
  if (!ex) return { ok: false, error: "exceção não existe" };
  const d = (ex.detail ?? {}) as Record<string, unknown>;
  const byType: Partial<Record<ExceptionType, () => Promise<ActionResult>>> = {
    payment_unmatched: async () => requeueAsaasEvent(deps, ex.refTable === "webhook_events" ? ex.refId : null, d.asaasPaymentId),
    amount_divergent: async () => requeueAsaasEvent(deps, null, d.asaasPaymentId),
    writeoff_needed: async () => requeueAsaasEvent(deps, null, d.asaasPaymentId),
    customer_missing_document: async () => {
      if (ex.refId === null) return { ok: false, error: "sem partner" };
      const c = await ensureCustomer(deps, ex.refId);
      if (!c?.asaasCustomerId) return { ok: false, error: "cliente continua sem CPF/CNPJ válido no Odoo" };
      let created = 0;
      for (const inv of await odoo.searchInvoices({})) if (inv.partnerId === ex.refId) created += (await handleInvoice(deps, inv)).created;
      return { ok: true, action: "customer_synced", detail: { asaasCustomerId: c.asaasCustomerId, chargesCreated: created } };
    },
    charge_create_failed: async () => {
      if (ex.refTable === "odoo_events" && ex.refId !== null) { await repo.odooEvents.reset(ex.refId); return { ok: true, action: "odoo_event_requeued" }; }
      const moveId = typeof d.odooId === "number" ? d.odooId : null;
      const inv = moveId ? await odoo.getInvoice(moveId) : null;
      if (!inv) return { ok: false, error: "não sei qual fatura reprocessar — use a varredura (sync-invoices)" };
      return { ok: true, action: "invoice_reprocessed", detail: await handleInvoice(deps, inv) };
    },
    queue_interrupted: async () => {
      const whId = await repo.config.get<string | null>("ASAAS_WEBHOOK_ID");
      if (!whId) return { ok: false, error: "ASAAS_WEBHOOK_ID não configurado" };
      await deps.asaas.updateWebhook(whId, { interrupted: false });
      return { ok: true, action: "webhook_reactivated" };
    },
  };
  const run = byType[ex.type];
  if (!run) return { ok: false, error: `tipo ${ex.type} não tem reprocessamento automático — resolva manualmente` };
  const r = await run();
  if (r.ok) await repo.exceptions.setStatus(id, "resolved", by);
  return r;
}

async function requeueAsaasEvent(deps: Deps, eventId: number | null, asaasPaymentId: unknown): Promise<ActionResult> {
  const { repo } = deps;
  const ev = eventId !== null ? { id: eventId } : typeof asaasPaymentId === "string" ? await repo.asaasEvents.findByPayment(asaasPaymentId, "PAYMENT_RECEIVED") : null;
  if (!ev) return { ok: false, error: "evento do Asaas não encontrado — o reconcile-daily pega pelo próprio Asaas" };
  await repo.asaasEvents.reset(ev.id);
  return { ok: true, action: "asaas_event_requeued", detail: { eventId: ev.id } };
}

/** Q3 na prática: o financeiro aceita juros/multa deste pagamento e a baixa acontece pelo valor recebido. */
export async function acceptWriteoff(deps: Deps, id: number, by: string): Promise<ActionResult> {
  const ex = await deps.repo.exceptions.get(id);
  if (!ex || ex.type !== "writeoff_needed") return { ok: false, error: "só vale para writeoff_needed" };
  const paymentId = (ex.detail as { asaasPaymentId?: string } | null)?.asaasPaymentId;
  const p = paymentId ? await deps.asaas.getPayment(paymentId) : null;
  if (!p) return { ok: false, error: "pagamento não encontrado no Asaas" };
  const r = await receivePayment(deps, p, "console", { acceptWriteoff: true });
  if (r !== "received" && r !== "already") return { ok: false, error: `baixa não aconteceu: ${r}` };
  await deps.repo.exceptions.setStatus(id, "resolved", by);
  return { ok: true, action: "writeoff_accepted", detail: { outcome: r } };
}

/** Gate R3: liga as notificações (régua) de todos os clientes sincronizados. */
export async function enableCustomerNotifications(deps: Deps): Promise<{ updated: number; failed: number }> {
  let updated = 0, failed = 0;
  for (const c of await deps.repo.customers.listSynced()) {
    try { await deps.asaas.updateCustomer(c.asaasCustomerId!, { notificationDisabled: false }); updated++; }
    catch (e) { failed++; deps.log("falha ao ligar notificações", { partner: c.odooPartnerId, error: (e as Error).message }); }
  }
  return { updated, failed };
}

export async function setConsoleConfig(deps: Deps, key: string, value: unknown): Promise<ActionResult> {
  if (!(CONSOLE_CONFIG_KEYS as readonly string[]).includes(key)) return { ok: false, error: `chave não editável: ${key}` };
  const k = key as ConsoleConfigKey;
  const valid = (k === "IDA_ENABLED" || k === "JUROS_MULTA_AUTO") ? typeof value === "boolean"
    : k === "TOLERANCE_BRL" ? (typeof value === "string" || typeof value === "number") && /^\d+(\.\d{1,2})?$/.test(String(value))
    : value === null || (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
  if (!valid) return { ok: false, error: `valor inválido para ${k}` };
  await deps.repo.config.set(k, k === "TOLERANCE_BRL" ? String(value) : value);
  return { ok: true, action: "config_set", detail: { key: k, value } };
}
