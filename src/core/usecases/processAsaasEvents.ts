// Worker da volta (1 min): consome os avisos do gateway reservados (tabela webhook_events), RELÊ a cobrança viva no
// gateway (o aviso é gatilho, não verdade — sem assinatura, qualquer um com o token forja um POST) e aplica a máquina de estados com transições atômicas.
import { type GatewayCharge, isReceivedStatus } from "../gateway.js";
import { fromStatesFor } from "../charges.js";
import { GATEWAY_EVENT_BATCH } from "../limits.js";
import type { Deps } from "../ports.js";
import { isTransient } from "../ports.js";
import { findChargeForPayment, receivePayment } from "../receive.js";
import type { ProcessStatus } from "../types.js";
import { backoff } from "./retry.js";

export async function processAsaasEvents(deps: Deps, o: { limit?: number } = {}): Promise<{ done: number; ignored: number; errors: number }> {
  const { repo, clock } = deps;
  const out = { done: 0, ignored: 0, errors: 0 };
  for (const stored of await repo.asaasEvents.pending(o.limit ?? GATEWAY_EVENT_BATCH, clock.now())) {
    const posse = { claimToken: stored.claimToken };
    // `touch` já diz se a reserva é nossa: seguir sem checar era gastar chamada externa (e, no
    // caminho do erro, abrir exceção) por um evento que já tem outro dono.
    if (!(await repo.asaasEvents.touch(stored.id, clock.now(), stored.claimToken))) {
      deps.log("reserva perdida antes de começar", { eventId: stored.id });
      continue;
    }
    try {
      const status = await applyEvent(deps, stored.payload, stored.id);
      const meu = await repo.asaasEvents.mark(stored.id, status, status === "error" ? { error: "processado com exceção — ver /api/v1/exceptions", ...posse } : posse);
      if (!meu) { deps.log("reserva perdida: não sobrescrevi o resultado do outro worker", { eventId: stored.asaasEventId, status }); continue; }
      if (status === "ignored") out.ignored++; else if (status === "error") out.errors++; else out.done++;
    } catch (e) {
      const attempts = stored.attempts + 1;
      const next = isTransient(e) ? backoff(attempts, clock.now()) : null;
      if (next) await repo.asaasEvents.mark(stored.id, "pending", { attempts, nextAttemptAt: next, error: (e as Error).message, ...posse });
      else {
        // Definitivo ou retries esgotados: fica em 'error' E vira exceção apontando pro evento — o "reprocessar" do console reenfileira.
        const meuAinda = await repo.asaasEvents.mark(stored.id, "error", { attempts, error: (e as Error).message, ...posse });
        if (!meuAinda) {
          // A reserva foi perdida enquanto este worker falhava: o novo dono JÁ concluiu o evento.
          // Sem esta guarda, o worker velho abria uma exceção sobre trabalho que deu certo e ainda
          // contava `errors`. Somado ao alerta de exceção travada, isso virava e-mail dizendo que
          // um pagamento não foi baixado quando ele foi. Achado do review adversarial do Codex.
          deps.log("reserva perdida no erro: não abri exceção sobre trabalho de outro worker", { eventId: stored.asaasEventId });
          continue;
        }
        await repo.exceptions.openOnce({ type: "payment_unmatched", refTable: "webhook_events", refId: stored.id, detail: { reason: isTransient(e) ? "retries esgotados" : "erro definitivo", event: stored.eventType, asaasPaymentId: stored.asaasPaymentId, error: (e as Error).message } });
        deps.log("evento do gateway em erro", { eventId: stored.asaasEventId, error: (e as Error).message });
        out.errors++;
      }
    }
  }
  return out;
}

/** Avisos que mexem em estado; `overdue` só é registrado, o resto é ignorado. */
const STATE_KINDS = new Set(["confirmed", "received", "updated", "deleted", "slip_cancelled", "restored", "reversal"]);

async function applyEvent(deps: Deps, payload: unknown, storedId: number): Promise<ProcessStatus> {
  const { repo, gateway } = deps;
  const ev = gateway.parseSettlementEvent(payload);
  if (!ev) return "ignored";
  if (!STATE_KINDS.has(ev.kind)) return ev.kind === "overdue" ? "done" : "ignored";

  // Fonte de verdade: a cobrança viva no gateway. Aviso forjado ou cobrança que sumiu → não muda nada.
  const p: GatewayCharge | null = await gateway.getCharge(ev.gatewayChargeId);
  if (!p) {
    await repo.exceptions.openOnce({ type: "payment_unmatched", refTable: "webhook_events", refId: storedId, detail: { reason: `pagamento do evento não existe no ${gateway.name === "asaas" ? "Asaas" : gateway.name} (evento forjado ou apagado)`, asaasPaymentId: ev.gatewayChargeId, event: ev.rawType } });
    return "error";
  }
  const found = await findChargeForPayment(deps, p);
  const charge = found === "conflict" ? null : found;

  switch (ev.kind) {
    case "confirmed": {
      if (!charge) return "ignored";
      if (p.status === "CONFIRMED") await repo.charges.transition(charge.id, fromStatesFor("confirmed"), "confirmed", { asaasPaymentId: p.id });
      return "done";
    }
    case "received": {
      const r = await receivePayment(deps, p, "webhook");
      if (r === "busy") throw Object.assign(new Error("cobrança em uso por outra execução"), { transient: true });   // volta pra fila
      if (r === "foreign") return "ignored";
      return r === "unmatched" || r === "wizard_failed" || r === "needs_review" ? "error" : "done";
    }
    case "updated": {
      if (!charge) return "ignored";
      if (p.dueDate !== charge.dueDate || p.value !== charge.amount) {
        await repo.exceptions.openOnce({ type: "amount_divergent", refTable: "charges", refId: charge.id, detail: { reason: `cobrança alterada no ${gateway.name === "asaas" ? "Asaas" : gateway.name} fora do motor`, asaasPaymentId: p.id, dueDate: p.dueDate, value: p.value, expectedDueDate: charge.dueDate, expectedValue: charge.amount } });
      }
      return "done";
    }
    case "deleted": {
      if (!charge) return "ignored";
      if (!p.deleted) { deps.log("aviso de exclusão de cobrança viva no gateway — ignorado", { asaasPaymentId: p.id, event: ev.rawType }); return "ignored"; }   // replay/forjado: o objeto vivo manda
      await repo.charges.transition(charge.id, fromStatesFor("cancelled"), "cancelled");
      return "done";
    }
    case "slip_cancelled": {
      if (!charge) return "ignored";
      if (!isReceivedStatus(p.status)) await repo.charges.transition(charge.id, fromStatesFor("cancelled"), "cancelled");
      return "done";
    }
    case "restored": {
      if (!charge) return "ignored";
      if (!p.deleted) await repo.charges.transition(charge.id, ["cancelled"], "created", { asaasPaymentId: p.id });
      return "done";
    }
    default: {   // reversal: estorno total/parcial, recebimento em dinheiro desfeito
      if (!charge) return "ignored";
      await repo.exceptions.openOnce({ type: "reversal_pending", refTable: "charges", refId: charge.id, detail: { event: ev.rawType, asaasPaymentId: p.id, status: p.status } });
      return "done";
    }
  }
}
