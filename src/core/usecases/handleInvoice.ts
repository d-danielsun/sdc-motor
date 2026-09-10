// A ida, por fatura: usada pela varredura (poll) e pelo push (webhook-odoo). Idempotente e sob lock por fatura.
// Review 09/09: adota boleto já existente no Asaas (crash/timeout entre criar e gravar), respeita o kill switch,
// cancela boleto órfão (parcela sumiu / fatura paga por fora / resetada), recria em fatura re-postada e
// nunca deixa uma falha permanente travar a varredura (vira exceção e segue).
import { OPEN_STATUSES } from "../charges.js";
import { ensureCustomer } from "../customers.js";
import { toCents } from "../money.js";
import type { Deps } from "../ports.js";
import { isTransient } from "../ports.js";
import type { Charge, OdooInvoice, OdooInvoiceLine } from "../types.js";
import { externalRefForLine } from "../types.js";

export interface InvoiceOutcome { invoiceId: number; created: number; cancelled: number; skipped: number; blocked: number; failed: number; busy: boolean }

export async function handleInvoice(deps: Deps, inv: OdooInvoice): Promise<InvoiceOutcome> {
  const out: InvoiceOutcome = { invoiceId: inv.id, created: 0, cancelled: 0, skipped: 0, blocked: 0, failed: 0, busy: false };
  if (inv.moveType !== "out_invoice") { out.skipped++; return out; }
  const r = await deps.repo.withLock(`invoice:${inv.id}`, () => handleLocked(deps, inv, out));
  if (!r.ok) out.busy = true;
  return out;
}

async function handleLocked(deps: Deps, inv: OdooInvoice, out: InvoiceOutcome): Promise<void> {
  const { repo, odoo } = deps;
  const existing = await repo.charges.listByMove(inv.id);

  if (inv.state === "cancel" || inv.state === "draft" || inv.paymentState === "reversed") {
    for (const c of existing) await cancelCharge(deps, c, inv, out, inv.state === "draft" ? "fatura voltou a rascunho" : "fatura cancelada/estornada");
    return;
  }
  if (inv.state !== "posted") { out.skipped++; return; }

  const allLines = await odoo.getPaymentTermLines(inv.id);
  const byLineId = new Map(allLines.map((l) => [l.id, l]));
  const total = allLines.length;

  // 1) cobranças abertas cuja parcela sumiu ou já foi conciliada por fora → boleto órfão: cancelar
  for (const c of existing) {
    if (!OPEN_STATUSES.includes(c.status)) continue;
    const line = byLineId.get(c.odooMoveLineId);
    if (!line) await cancelCharge(deps, c, inv, out, "a parcela não existe mais no Odoo");
    else if (line.reconciled) await cancelCharge(deps, c, inv, out, "parcela conciliada no Odoo por fora do motor (baixa manual?)");
  }

  if (!["not_paid", "partial"].includes(inv.paymentState)) { out.skipped++; return; }
  const idaEnabled = (await repo.config.get<boolean>("IDA_ENABLED")) === true;
  const cutoff = await repo.config.get<string | null>("GO_LIVE_CUTOFF_DATE");
  if (!idaEnabled || (cutoff && inv.invoiceDate && inv.invoiceDate < cutoff)) { out.skipped++; return; }

  const openLines = allLines.filter((l) => !l.reconciled);
  let customerId: string | null | undefined;   // resolvido uma vez por fatura
  for (const line of openLines) {
    const k = allLines.findIndex((l) => l.id === line.id) + 1;
    const charge = await repo.charges.getByMoveLine(line.id);
    if (charge && OPEN_STATUSES.includes(charge.status)) {
      // 2) parcela mudou de valor/vencimento depois do boleto → divergência (o boleto não é atualizado sozinho)
      if (toCents(line.amountResidual) !== toCents(charge.amount) || line.dateMaturity !== charge.dueDate) {
        await repo.exceptions.openOnce({ type: "amount_divergent", refTable: "charges", refId: charge.id, detail: { stage: "ida", reason: "parcela alterada no Odoo depois do boleto", residual: line.amountResidual, dateMaturity: line.dateMaturity, expected: charge.amount, expectedDueDate: charge.dueDate, asaasPaymentId: charge.asaasPaymentId } });
      }
      out.skipped++; continue;
    }
    if (charge && charge.status !== "cancelled" && charge.status !== "pending") { out.skipped++; continue; }   // received/exception: nada a criar
    try {
      if (customerId === undefined) customerId = (await ensureCustomer(deps, inv.partnerId))?.asaasCustomerId ?? null;
      if (!customerId) { out.blocked++; continue; }   // exceção já aberta em ensureCustomer; a varredura não para por isso
      const ref = externalRefForLine(line.id);
      // 3) idempotência pela fonte de verdade: boleto vivo com esta referência é adotado, não duplicado
      const payment = (await deps.asaas.findPaymentByExternalRef(ref)) ?? (await deps.asaas.createPayment({
        customer: customerId, value: line.amountResidual, dueDate: line.dateMaturity, externalReference: ref,
        description: `${inv.name} parcela ${k}/${total}`.slice(0, 500),
      }));
      const base = { odooMoveId: inv.id, odooMoveLineId: line.id, odooPartnerId: inv.partnerId, asaasPaymentId: payment.id, externalRef: ref, amount: line.amountResidual, dueDate: line.dateMaturity, bankSlipUrl: payment.bankSlipUrl, invoiceName: inv.name, nossoNumero: payment.nossoNumero, asaasInvoiceNumber: payment.invoiceNumber };
      if (charge) {   // 4) fatura re-postada: cobrança cancelada volta a viver com o boleto novo
        await repo.charges.transition(charge.id, ["cancelled", "pending"], "created", { asaasPaymentId: payment.id, bankSlipUrl: payment.bankSlipUrl, nossoNumero: payment.nossoNumero, asaasInvoiceNumber: payment.invoiceNumber });
      } else if (!(await repo.charges.insert({ ...base, status: "created" }))) {
        out.skipped++; continue;   // outra execução gravou primeiro (o lock torna isso raro); o boleto é o mesmo por externalReference
      }
      out.created++;
      deps.log("boleto criado", { invoice: inv.name, moveLineId: line.id, asaasPaymentId: payment.id, value: line.amountResidual, dueDate: line.dateMaturity });
    } catch (e) {
      if (isTransient(e)) throw e;
      out.failed++;
      await repo.exceptions.openOnce({ type: "charge_create_failed", refTable: "account.move.line", refId: line.id, detail: { odooId: inv.id, invoice: inv.name, moveLineId: line.id, error: (e as Error).message } });
    }
  }
}

async function cancelCharge(deps: Deps, c: Charge, inv: OdooInvoice, out: InvoiceOutcome, reason: string): Promise<void> {
  const { repo, asaas } = deps;
  if (c.status === "received" || c.status === "settled") {
    await repo.exceptions.openOnce({ type: "reversal_pending", refTable: "charges", refId: c.id, detail: { invoice: inv.name, reason: `${reason} — mas o boleto já foi pago` } });
    return;
  }
  if (!OPEN_STATUSES.includes(c.status) || !c.asaasPaymentId) return;
  try {
    const live = await asaas.getPayment(c.asaasPaymentId);
    if (live && !live.deleted) {
      if (live.status === "RECEIVED" || live.status === "RECEIVED_IN_CASH" || live.status === "CONFIRMED") {
        await repo.exceptions.openOnce({ type: "reversal_pending", refTable: "charges", refId: c.id, detail: { invoice: inv.name, reason: `${reason} — mas o boleto já está ${live.status} no Asaas` } });
        return;
      }
      await asaas.deletePayment(c.asaasPaymentId);
    }
    await repo.charges.transition(c.id, ["created", "confirmed"], "cancelled");
    out.cancelled++;
    deps.log("boleto cancelado", { invoice: inv.name, chargeId: c.id, asaasPaymentId: c.asaasPaymentId, reason });
  } catch (e) {
    if (isTransient(e)) throw e;
    out.failed++;
    await repo.exceptions.openOnce({ type: "charge_create_failed", refTable: "charges", refId: c.id, detail: { stage: "cancelamento", odooId: inv.id, invoice: inv.name, reason, error: (e as Error).message } });
  }
}

export type { OdooInvoiceLine };
