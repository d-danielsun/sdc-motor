// Worker da volta (1 min): consome webhook_events pendentes em ordem e aplica a máquina de estados.
import { normalizeAsaasEvent } from "../asaasPayload.js";
import { canTransition } from "../charges.js";
import type { Deps } from "../ports.js";
import { isTransient } from "../ports.js";
import { findChargeForPayment, receivePayment } from "../receive.js";
import type { ProcessStatus } from "../types.js";
import { backoff } from "./retry.js";

export async function processAsaasEvents(deps: Deps, o: { limit?: number } = {}): Promise<{ done: number; ignored: number; errors: number }> {
  const { repo, clock } = deps;
  const out = { done: 0, ignored: 0, errors: 0 };
  for (const stored of await repo.asaasEvents.pending(o.limit ?? 100, clock.now())) {
    try {
      const status = await applyEvent(deps, stored.payload);
      await repo.asaasEvents.mark(stored.id, status);
      if (status === "ignored") out.ignored++; else if (status === "error") out.errors++; else out.done++;
    } catch (e) {
      const attempts = stored.attempts + 1;
      const next = isTransient(e) ? backoff(attempts, clock.now()) : null;
      if (next) await repo.asaasEvents.mark(stored.id, "pending", { attempts, nextAttemptAt: next, error: (e as Error).message });
      else {
        await repo.asaasEvents.mark(stored.id, "error", { attempts, error: (e as Error).message });
        if (!isTransient(e)) {
          // erro definitivo já abriu exceção específica em receivePayment; aqui só garantimos rastro
          deps.log("evento asaas em erro", { eventId: stored.asaasEventId, error: (e as Error).message });
        } else {
          await repo.exceptions.open({ type: "payment_unmatched", refTable: "webhook_events", refId: stored.id, detail: { reason: "retries esgotados", error: (e as Error).message } });
        }
        out.errors++;
      }
    }
  }
  return out;
}

async function applyEvent(deps: Deps, payload: unknown): Promise<ProcessStatus> {
  const { repo } = deps;
  const ev = normalizeAsaasEvent(payload);
  if (!ev) return "ignored";
  const p = ev.payment;

  switch (ev.event) {
    case "PAYMENT_CONFIRMED": {
      const c = await findChargeForPayment(deps, p);
      if (!c) return "ignored";
      if (canTransition(c.status, "confirmed")) await repo.charges.setStatus(c.id, "confirmed", { asaasPaymentId: p.id });
      return "done";
    }
    case "PAYMENT_RECEIVED": {
      const r = await receivePayment(deps, p, "webhook");
      return r === "unmatched" ? "error" : "done";
    }
    case "PAYMENT_UPDATED": {
      const c = await findChargeForPayment(deps, p);
      if (!c) return "ignored";
      const changed = p.dueDate !== c.dueDate || p.value !== c.amount;
      if (changed && !(await repo.exceptions.hasOpen("amount_divergent", "charges", c.id))) {
        await repo.exceptions.open({ type: "amount_divergent", refTable: "charges", refId: c.id, detail: { reason: "cobrança alterada no Asaas fora do motor", dueDate: p.dueDate, value: p.value, expectedDueDate: c.dueDate, expectedValue: c.amount } });
      }
      return "done";
    }
    case "PAYMENT_DELETED":
    case "PAYMENT_BANK_SLIP_CANCELLED": {
      const c = await findChargeForPayment(deps, p);
      if (!c) return "ignored";
      if (canTransition(c.status, "cancelled")) await repo.charges.setStatus(c.id, "cancelled");
      return "done";
    }
    case "PAYMENT_RESTORED": {
      const c = await findChargeForPayment(deps, p);
      if (!c) return "ignored";
      if (c.status === "cancelled") await repo.charges.setStatus(c.id, "created");
      return "done";
    }
    case "PAYMENT_OVERDUE":
      return "done";
    case "PAYMENT_REFUNDED":
    case "PAYMENT_PARTIALLY_REFUNDED":
    case "PAYMENT_RECEIVED_IN_CASH_UNDONE": {
      const c = await findChargeForPayment(deps, p);
      if (!c) return "ignored";
      if (!(await repo.exceptions.hasOpen("reversal_pending", "charges", c.id))) {
        await repo.exceptions.open({ type: "reversal_pending", refTable: "charges", refId: c.id, detail: { event: ev.event, asaasPaymentId: p.id, status: p.status } });
      }
      return "done";
    }
    default:
      return "ignored";
  }
}
