// Worker da volta (1 min): consome webhook_events reservados, RELÊ o pagamento no Asaas (o webhook é gatilho,
// não verdade — sem assinatura, qualquer um com o token forja um POST) e aplica a máquina de estados com transições atômicas.
import { normalizeAsaasEvent } from "../asaasPayload.js";
import { fromStatesFor } from "../charges.js";
import { ASAAS_EVENT_BATCH } from "../limits.js";
import type { Deps } from "../ports.js";
import { isTransient } from "../ports.js";
import { findChargeForPayment, receivePayment } from "../receive.js";
import type { AsaasPayment, ProcessStatus } from "../types.js";
import { backoff } from "./retry.js";

export async function processAsaasEvents(deps: Deps, o: { limit?: number } = {}): Promise<{ done: number; ignored: number; errors: number }> {
  const { repo, clock } = deps;
  const out = { done: 0, ignored: 0, errors: 0 };
  for (const stored of await repo.asaasEvents.pending(o.limit ?? ASAAS_EVENT_BATCH, clock.now())) {
    await repo.asaasEvents.touch(stored.id, clock.now());
    try {
      const status = await applyEvent(deps, stored.payload, stored.id);
      await repo.asaasEvents.mark(stored.id, status, status === "error" ? { error: "processado com exceção — ver /api/v1/exceptions" } : {});
      if (status === "ignored") out.ignored++; else if (status === "error") out.errors++; else out.done++;
    } catch (e) {
      const attempts = stored.attempts + 1;
      const next = isTransient(e) ? backoff(attempts, clock.now()) : null;
      if (next) await repo.asaasEvents.mark(stored.id, "pending", { attempts, nextAttemptAt: next, error: (e as Error).message });
      else {
        // Definitivo ou retries esgotados: fica em 'error' E vira exceção apontando pro evento — o "reprocessar" do console reenfileira.
        await repo.asaasEvents.mark(stored.id, "error", { attempts, error: (e as Error).message });
        await repo.exceptions.openOnce({ type: "payment_unmatched", refTable: "webhook_events", refId: stored.id, detail: { reason: isTransient(e) ? "retries esgotados" : "erro definitivo", event: stored.eventType, asaasPaymentId: stored.asaasPaymentId, error: (e as Error).message } });
        deps.log("evento asaas em erro", { eventId: stored.asaasEventId, error: (e as Error).message });
        out.errors++;
      }
    }
  }
  return out;
}

const STATE_EVENTS = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_UPDATED", "PAYMENT_DELETED", "PAYMENT_BANK_SLIP_CANCELLED", "PAYMENT_RESTORED", "PAYMENT_REFUNDED", "PAYMENT_PARTIALLY_REFUNDED", "PAYMENT_RECEIVED_IN_CASH_UNDONE"]);

async function applyEvent(deps: Deps, payload: unknown, storedId: number): Promise<ProcessStatus> {
  const { repo, asaas } = deps;
  const ev = normalizeAsaasEvent(payload);
  if (!ev) return "ignored";
  if (!STATE_EVENTS.has(ev.event)) return ev.event === "PAYMENT_OVERDUE" ? "done" : "ignored";

  // Fonte de verdade: o objeto vivo no Asaas. Evento forjado ou pagamento que sumiu → não muda nada.
  const p: AsaasPayment | null = await asaas.getPayment(ev.payment.id);
  if (!p) {
    await repo.exceptions.openOnce({ type: "payment_unmatched", refTable: "webhook_events", refId: storedId, detail: { reason: "pagamento do evento não existe no Asaas (evento forjado ou apagado)", asaasPaymentId: ev.payment.id, event: ev.event } });
    return "error";
  }
  const found = await findChargeForPayment(deps, p);
  const charge = found === "conflict" ? null : found;

  switch (ev.event) {
    case "PAYMENT_CONFIRMED": {
      if (!charge) return "ignored";
      if (p.status === "CONFIRMED") await repo.charges.transition(charge.id, fromStatesFor("confirmed"), "confirmed", { asaasPaymentId: p.id });
      return "done";
    }
    case "PAYMENT_RECEIVED": {
      const r = await receivePayment(deps, p, "webhook");
      if (r === "busy") throw Object.assign(new Error("cobrança em uso por outra execução"), { transient: true });   // volta pra fila
      if (r === "foreign") return "ignored";
      return r === "unmatched" || r === "wizard_failed" || r === "needs_review" ? "error" : "done";
    }
    case "PAYMENT_UPDATED": {
      if (!charge) return "ignored";
      if (p.dueDate !== charge.dueDate || p.value !== charge.amount) {
        await repo.exceptions.openOnce({ type: "amount_divergent", refTable: "charges", refId: charge.id, detail: { reason: "cobrança alterada no Asaas fora do motor", asaasPaymentId: p.id, dueDate: p.dueDate, value: p.value, expectedDueDate: charge.dueDate, expectedValue: charge.amount } });
      }
      return "done";
    }
    case "PAYMENT_DELETED":
    case "PAYMENT_BANK_SLIP_CANCELLED": {
      if (!charge) return "ignored";
      if (p.deleted || p.status !== "RECEIVED") await repo.charges.transition(charge.id, fromStatesFor("cancelled"), "cancelled");
      return "done";
    }
    case "PAYMENT_RESTORED": {
      if (!charge) return "ignored";
      if (!p.deleted) await repo.charges.transition(charge.id, ["cancelled"], "created", { asaasPaymentId: p.id });
      return "done";
    }
    default: {   // REFUNDED / PARTIALLY_REFUNDED / RECEIVED_IN_CASH_UNDONE
      if (!charge) return "ignored";
      await repo.exceptions.openOnce({ type: "reversal_pending", refTable: "charges", refId: charge.id, detail: { event: ev.event, asaasPaymentId: p.id, status: p.status } });
      return "done";
    }
  }
}
