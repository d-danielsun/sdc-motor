// A volta: PAYMENT_RECEIVED → baixa na parcela exata. Um caminho só, usado pelo worker, pelo reconcile e pelo console.
// Regras (review 09/09): o pagamento tem que estar RECEBIDO no Asaas (objeto vivo), a parcela é lida por id no Odoo,
// residual diferente da cobrança é divergência, nada roda sem lock por cobrança, e conciliação + status é uma transação.
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

export type ReceiveOutcome = "received" | "already" | "unmatched" | "foreign" | "divergent" | "writeoff_needed" | "not_received" | "busy" | "wizard_failed" | "needs_review";
export const RECEIVED_STATUSES = ["RECEIVED", "RECEIVED_IN_CASH"] as const;

/** O id do pagamento (imutável) manda; externalReference (editável no Asaas) só entra quando ainda não há vínculo. Os dois discordando é conflito. */
export async function findChargeForPayment(deps: Deps, p: AsaasPayment): Promise<Charge | null | "conflict"> {
  const byId = await deps.repo.charges.getByAsaasPayment(p.id);
  const byRef = p.externalReference ? await deps.repo.charges.getByExternalRef(p.externalReference) : null;
  if (byId && byRef && byId.id !== byRef.id) return "conflict";
  return byId ?? byRef;
}

export async function receivePayment(deps: Deps, p: AsaasPayment, source: "webhook" | "reconcile" | "console", o: { acceptWriteoff?: boolean } = {}): Promise<ReceiveOutcome> {
  const { repo } = deps;
  if (p.deleted || !(RECEIVED_STATUSES as readonly string[]).includes(p.status)) return "not_received";
  const found = await findChargeForPayment(deps, p);
  if (found === "conflict") {
    await repo.exceptions.openOnce({ type: "payment_unmatched", refTable: "asaas_payments", detail: { reason: "id do pagamento e externalReference apontam para cobranças diferentes", asaasPaymentId: p.id, externalReference: p.externalReference, source } });
    return "unmatched";
  }
  if (!found) {
    if (moveLineIdFromRef(p.externalReference) === null) return "foreign";   // cobrança avulsa da SDC no mesmo Asaas: não é nossa
    await repo.exceptions.openOnce({ type: "payment_unmatched", refTable: "asaas_payments", detail: { asaasPaymentId: p.id, externalReference: p.externalReference, value: p.value, source } });
    return "unmatched";
  }
  const r = await repo.withLock(`charge:${found.id}`, () => receiveLocked(deps, p, found.externalRef, source, o));
  return r.ok ? r.value : "busy";
}

async function receiveLocked(deps: Deps, p: AsaasPayment, externalRef: string, source: string, o: { acceptWriteoff?: boolean }): Promise<ReceiveOutcome> {
  const { repo, odoo, clock, log } = deps;
  const charge = (await repo.charges.getByExternalRef(externalRef))!;   // releitura sob o lock
  if (charge.status === "exception" && source !== "console") return "needs_review";   // wizard falhou antes: só uma pessoa reabre

  // A referência não vence um pagamento já vinculado: outro pay_ com o mesmo externalReference é conflito, não baixa.
  if (charge.asaasPaymentId && charge.asaasPaymentId !== p.id) {
    await repo.exceptions.openOnce({ type: "payment_unmatched", refTable: "charges", refId: charge.id, detail: { reason: "segundo pagamento para a mesma parcela — cliente pagou duas vezes?", asaasPaymentId: p.id, linkedAsaasPaymentId: charge.asaasPaymentId, value: p.value, source } });
    return "unmatched";
  }
  if (charge.status === "received" || charge.status === "settled" || (await repo.reconciliations.existsForCharge(charge.id))) return "already";

  const toleranceBrl = (await repo.config.get<string | number>("TOLERANCE_BRL")) ?? "0.01";
  const toleranceCents = toCents(toleranceBrl);
  const jurosMultaAuto = o.acceptWriteoff === true || (await repo.config.get<boolean>("JUROS_MULTA_AUTO")) === true;
  const cls = classifyReceipt(p, charge.amount, { toleranceCents, jurosMultaAuto });
  if (!cls.ok) {
    await repo.exceptions.openOnce({ type: cls.reason, refTable: "charges", refId: charge.id, detail: { asaasPaymentId: p.id, received: p.value, expected: charge.amount, originalValue: p.originalValue, interestValue: p.interestValue, policy: cls.policy } });
    return cls.reason === "amount_divergent" ? "divergent" : "writeoff_needed";
  }
  const paymentDate = p.paymentDate ?? p.clientPaymentDate ?? clock.today();
  const recBase = { amountReceived: p.value, amountExpected: charge.amount, netValue: p.netValue, paymentDate, creditDate: p.creditDate };
  const patch = { asaasPaymentId: p.id, nossoNumero: p.nossoNumero, asaasInvoiceNumber: p.invoiceNumber };

  // A parcela exata, lida por id: sumiu → não é prova de nada; conciliada → só fecha do nosso lado; aberta → registra.
  const line = await odoo.getPaymentTermLine(charge.odooMoveLineId);
  if (!line) {
    await repo.exceptions.openOnce({ type: "payment_unmatched", refTable: "charges", refId: charge.id, detail: { stage: "pre-check odoo", reason: "a parcela não existe mais no Odoo (fatura resetada/re-postada?)", asaasPaymentId: p.id, moveLineId: charge.odooMoveLineId } });
    return "unmatched";
  }
  if (line.reconciled) {
    const ok = await repo.charges.markReceived(charge.id, { ...recBase, odooPaymentId: null, diffPolicy: "ja_baixada_no_odoo" }, patch);
    log("parcela já estava conciliada no Odoo — só fechei do lado do motor", { chargeId: charge.id, moveLineId: charge.odooMoveLineId, source });
    return ok ? "received" : "already";
  }
  if (Math.abs(toCents(line.amountResidual) - toCents(charge.amount)) > toleranceCents) {
    await repo.exceptions.openOnce({ type: "amount_divergent", refTable: "charges", refId: charge.id, detail: { stage: "pre-check odoo", reason: "residual da parcela no Odoo difere da cobrança (pagamento parcial, parcela alterada?)", residual: line.amountResidual, expected: charge.amount, asaasPaymentId: p.id } });
    return "divergent";
  }

  let result;
  try {
    result = await odoo.registerPayment({ moveLineId: charge.odooMoveLineId, amount: p.value, paymentDate });
  } catch (e) {
    if (isTransient(e)) throw e;   // rede/5xx: quem chamou re-tenta
    // Definitivo (ex.: wizard rodou mas a parcela não fechou): NÃO re-tentar às cegas — pode duplicar. Fica pra uma pessoa.
    await repo.charges.transition(charge.id, ["created", "confirmed", "cancelled"], "exception");
    await repo.exceptions.openOnce({ type: "payment_unmatched", refTable: "charges", refId: charge.id, detail: { stage: "odoo.registerPayment", error: (e as Error).message, asaasPaymentId: p.id, value: p.value, paymentDate } });
    return "wizard_failed";
  }
  const ok = await repo.charges.markReceived(charge.id, { ...recBase, odooPaymentId: result.paymentId, diffPolicy: cls.policy }, patch);
  log("baixa registrada", { chargeId: charge.id, moveLineId: charge.odooMoveLineId, odooPaymentId: result.paymentId, value: p.value, source });
  return ok ? "received" : "already";
}
