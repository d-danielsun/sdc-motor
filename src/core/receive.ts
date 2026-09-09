// A volta: PAYMENT_RECEIVED → baixa na parcela exata. Um caminho só, usado pelo worker e pelo reconcile.
import { toCents } from "./money.js";
import type { Deps } from "./ports.js";
import { isTransient } from "./ports.js";
import type { AsaasPayment, Charge, DiffPolicy, Money } from "./types.js";
import { moveLineIdFromRef } from "./types.js";

export type Classification =
  | { ok: true; policy: DiffPolicy | null }
  | { ok: false; reason: "amount_divergent" | "writeoff_needed"; policy: DiffPolicy | null };

/** Compara o recebido com o esperado. juros/multa do próprio Asaas (originalValue == esperado) é classificado, não confundido com divergência. */
export function classifyReceipt(p: AsaasPayment, expected: Money, o: { toleranceCents: number; jurosMultaAuto: boolean }): Classification {
  const diff = toCents(p.value) - toCents(expected);
  const inCash = p.status === "RECEIVED_IN_CASH";
  if (Math.abs(diff) <= o.toleranceCents) return { ok: true, policy: inCash ? "in_cash" : null };
  if (diff > 0 && p.originalValue !== null && toCents(p.originalValue) === toCents(expected)) {
    return o.jurosMultaAuto ? { ok: true, policy: "juros_multa" } : { ok: false, reason: "writeoff_needed", policy: "juros_multa" };
  }
  return { ok: false, reason: "amount_divergent", policy: null };
}

export type ReceiveOutcome = "received" | "already" | "unmatched" | "divergent" | "writeoff_needed";

export async function findChargeForPayment(deps: Deps, p: AsaasPayment): Promise<Charge | null> {
  const byRef = p.externalReference ? await deps.repo.charges.getByExternalRef(p.externalReference) : null;
  return byRef ?? (await deps.repo.charges.getByAsaasPayment(p.id));
}

export async function receivePayment(deps: Deps, p: AsaasPayment, source: "webhook" | "reconcile" | "console", o: { acceptWriteoff?: boolean } = {}): Promise<ReceiveOutcome> {
  const { repo, odoo, clock, log } = deps;
  const charge = await findChargeForPayment(deps, p);
  if (!charge) {
    if (moveLineIdFromRef(p.externalReference) !== null || source === "webhook") {
      await repo.exceptions.open({ type: "payment_unmatched", refTable: "asaas_payments", detail: { asaasPaymentId: p.id, externalReference: p.externalReference, value: p.value, source } });
    }
    return "unmatched";
  }
  if (charge.status === "received" || charge.status === "settled" || (await repo.reconciliations.existsForCharge(charge.id))) return "already";

  const toleranceBrl = (await repo.config.get<string | number>("TOLERANCE_BRL")) ?? "0.01";
  const jurosMultaAuto = o.acceptWriteoff === true || (await repo.config.get<boolean>("JUROS_MULTA_AUTO")) === true;
  const cls = classifyReceipt(p, charge.amount, { toleranceCents: toCents(toleranceBrl), jurosMultaAuto });
  if (!cls.ok) {
    if (!(await repo.exceptions.hasOpen(cls.reason, "charges", charge.id))) {
      await repo.exceptions.open({ type: cls.reason, refTable: "charges", refId: charge.id, detail: { asaasPaymentId: p.id, received: p.value, expected: charge.amount, originalValue: p.originalValue, interestValue: p.interestValue, policy: cls.policy } });
    }
    return cls.reason === "amount_divergent" ? "divergent" : "writeoff_needed";
  }

  const paymentDate = p.paymentDate ?? p.clientPaymentDate ?? clock.today();
  let result;
  try {
    result = await odoo.registerPayment({ moveLineId: charge.odooMoveLineId, amount: p.value, paymentDate });
  } catch (e) {
    if (isTransient(e)) throw e;
    await repo.exceptions.open({ type: "payment_unmatched", refTable: "charges", refId: charge.id, detail: { stage: "odoo.registerPayment", error: String((e as Error).message), asaasPaymentId: p.id } });
    throw e;
  }
  await repo.reconciliations.insert({
    chargeId: charge.id, odooPaymentId: result.paymentId, amountReceived: p.value, amountExpected: charge.amount,
    netValue: p.netValue, diffPolicy: cls.policy, paymentDate, creditDate: p.creditDate,
  });
  await repo.charges.setStatus(charge.id, "received", { asaasPaymentId: p.id, nossoNumero: p.nossoNumero, asaasInvoiceNumber: p.invoiceNumber });
  log("baixa registrada", { chargeId: charge.id, moveLineId: charge.odooMoveLineId, odooPaymentId: result.paymentId, value: p.value, source });
  return "received";
}
