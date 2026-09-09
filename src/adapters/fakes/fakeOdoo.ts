// Odoo em memória: o que o motor enxerga de uma base real, sem a base. Serve os testes até o S0.1/S0.3.
import { money, sub, toCents } from "../../core/money.js";
import type { OdooClient } from "../../core/ports.js";
import type { OdooInvoice, OdooInvoiceLine, OdooPartner, OdooPaymentResult } from "../../core/types.js";

export interface FakePayment { id: number; moveLineId: number; amount: string; paymentDate: string }

export class FakeOdoo implements OdooClient {
  partners = new Map<number, OdooPartner>();
  invoices = new Map<number, OdooInvoice>();
  lines = new Map<number, OdooInvoiceLine>();
  payments: FakePayment[] = [];
  private nextPaymentId = 1;
  private tick = 0;

  private stamp(): string { this.tick++; return new Date(Date.UTC(2026, 8, 9, 12, 0, this.tick)).toISOString(); }

  addPartner(p: Partial<OdooPartner> & { id: number; name: string }): OdooPartner {
    const partner: OdooPartner = { vat: null, email: null, phone: null, ...p };
    this.partners.set(p.id, partner);
    return partner;
  }
  addInvoice(i: { id: number; name: string; partnerId: number; invoiceDate?: string; lines: Array<{ id: number; dateMaturity: string; amount: string }>; state?: OdooInvoice["state"]; moveType?: string }): OdooInvoice {
    const total = i.lines.reduce((acc, l) => acc + toCents(l.amount), 0);
    const inv: OdooInvoice = {
      id: i.id, name: i.name, partnerId: i.partnerId, invoiceDate: i.invoiceDate ?? "2026-09-01",
      dueDate: i.lines[i.lines.length - 1]?.dateMaturity ?? null, amountResidual: money(total / 100),
      state: i.state ?? "posted", paymentState: "not_paid", moveType: i.moveType ?? "out_invoice", writeDate: this.stamp(),
    };
    this.invoices.set(inv.id, inv);
    for (const l of i.lines) this.lines.set(l.id, { id: l.id, moveId: inv.id, dateMaturity: l.dateMaturity, amountResidual: money(l.amount), reconciled: false });
    return inv;
  }
  cancelInvoice(id: number): void {
    const inv = this.invoices.get(id);
    if (inv) { inv.state = "cancel"; inv.writeDate = this.stamp(); }
  }

  async searchInvoices(q: { writeDateAfter?: string | null; invoiceDateFrom?: string | null }): Promise<OdooInvoice[]> {
    return [...this.invoices.values()]
      .filter((i) => i.moveType === "out_invoice" && (i.state === "posted" || i.state === "cancel"))
      .filter((i) => !q.writeDateAfter || i.writeDate > q.writeDateAfter)
      .filter((i) => !q.invoiceDateFrom || (i.invoiceDate ?? "") >= q.invoiceDateFrom)
      .sort((a, b) => a.writeDate.localeCompare(b.writeDate))
      .map((i) => ({ ...i }));
  }
  async getInvoice(id: number): Promise<OdooInvoice | null> { const i = this.invoices.get(id); return i ? { ...i } : null; }
  async getOpenPaymentTermLines(moveId: number): Promise<OdooInvoiceLine[]> {
    return [...this.lines.values()].filter((l) => l.moveId === moveId && !l.reconciled).sort((a, b) => a.dateMaturity.localeCompare(b.dateMaturity)).map((l) => ({ ...l }));
  }
  async getPartner(id: number): Promise<OdooPartner | null> { const p = this.partners.get(id); return p ? { ...p } : null; }
  async registerPayment(p: { moveLineId: number; amount: string; paymentDate: string }): Promise<OdooPaymentResult> {
    const line = this.lines.get(p.moveLineId);
    if (!line) throw new Error(`fake odoo: move line ${p.moveLineId} não existe`);
    if (line.reconciled) throw new Error(`fake odoo: move line ${p.moveLineId} já conciliada`);
    line.amountResidual = toCents(p.amount) >= toCents(line.amountResidual) ? "0.00" : sub(line.amountResidual, p.amount);
    line.reconciled = line.amountResidual === "0.00";
    const inv = this.invoices.get(line.moveId)!;
    inv.amountResidual = sub(inv.amountResidual, p.amount);
    const open = [...this.lines.values()].filter((l) => l.moveId === inv.id && !l.reconciled);
    inv.paymentState = open.length === 0 ? "in_payment" : "partial";
    inv.writeDate = this.stamp();
    const payment = { id: this.nextPaymentId++, moveLineId: p.moveLineId, amount: p.amount, paymentDate: p.paymentDate };
    this.payments.push(payment);
    return { paymentId: payment.id, paymentState: inv.paymentState };
  }
}
