// A ida, por fatura: usada pela varredura (poll) e pelo push (webhook-odoo). Idempotente por parcela.
import { ensureCustomer } from "../customers.js";
import type { Deps } from "../ports.js";
import { isTransient } from "../ports.js";
import type { OdooInvoice } from "../types.js";
import { externalRefForLine } from "../types.js";
import { OPEN_STATUSES } from "../charges.js";

export interface InvoiceOutcome { invoiceId: number; created: number; cancelled: number; skipped: number; failed: number }

export async function handleInvoice(deps: Deps, inv: OdooInvoice): Promise<InvoiceOutcome> {
  const out: InvoiceOutcome = { invoiceId: inv.id, created: 0, cancelled: 0, skipped: 0, failed: 0 };
  if (inv.moveType !== "out_invoice") { out.skipped++; return out; }

  if (inv.state === "cancel" || inv.paymentState === "reversed") return cancelInvoiceCharges(deps, inv, out);
  if (inv.state !== "posted" || !["not_paid", "partial"].includes(inv.paymentState)) { out.skipped++; return out; }

  const cutoff = await deps.repo.config.get<string | null>("GO_LIVE_CUTOFF_DATE");
  if (cutoff && inv.invoiceDate && inv.invoiceDate < cutoff) { out.skipped++; return out; }

  const lines = await deps.odoo.getOpenPaymentTermLines(inv.id);
  const total = lines.length;
  for (const [i, line] of lines.entries()) {
    if (await deps.repo.charges.getByMoveLine(line.id)) { out.skipped++; continue; }
    try {
      const customer = await ensureCustomer(deps, inv.partnerId);
      if (!customer?.asaasCustomerId) { out.failed++; continue; } // exceção já aberta em ensureCustomer
      const payment = await deps.asaas.createPayment({
        customer: customer.asaasCustomerId, value: line.amountResidual, dueDate: line.dateMaturity,
        externalReference: externalRefForLine(line.id), description: `${inv.name} parcela ${i + 1}/${total}`.slice(0, 500),
      });
      await deps.repo.charges.insert({
        odooMoveId: inv.id, odooMoveLineId: line.id, odooPartnerId: inv.partnerId, asaasPaymentId: payment.id,
        externalRef: externalRefForLine(line.id), amount: line.amountResidual, dueDate: line.dateMaturity, status: "created",
        bankSlipUrl: payment.bankSlipUrl, invoiceName: inv.name, nossoNumero: payment.nossoNumero, asaasInvoiceNumber: payment.invoiceNumber,
      });
      out.created++;
      deps.log("boleto criado", { invoice: inv.name, moveLineId: line.id, asaasPaymentId: payment.id, value: line.amountResidual, dueDate: line.dateMaturity });
    } catch (e) {
      if (isTransient(e)) throw e;
      out.failed++;
      await deps.repo.exceptions.open({ type: "charge_create_failed", refTable: "account.move.line", refId: line.id, detail: { invoice: inv.name, error: (e as Error).message } });
    }
  }
  return out;
}

async function cancelInvoiceCharges(deps: Deps, inv: OdooInvoice, out: InvoiceOutcome): Promise<InvoiceOutcome> {
  for (const c of await deps.repo.charges.listByMove(inv.id)) {
    if (OPEN_STATUSES.includes(c.status) && c.asaasPaymentId) {
      await deps.asaas.deletePayment(c.asaasPaymentId);
      await deps.repo.charges.setStatus(c.id, "cancelled");
      out.cancelled++;
    } else if (c.status === "received" || c.status === "settled") {
      if (!(await deps.repo.exceptions.hasOpen("reversal_pending", "charges", c.id))) {
        await deps.repo.exceptions.open({ type: "reversal_pending", refTable: "charges", refId: c.id, detail: { invoice: inv.name, reason: "fatura cancelada/estornada no Odoo após o recebimento" } });
      }
    }
  }
  return out;
}
