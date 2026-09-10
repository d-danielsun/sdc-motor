// Odoo em memória: o que o motor enxerga de uma base real, sem a base. Fala o formato de data do Odoo ("YYYY-MM-DD HH:MM:SS")
// pra que a suíte exercite a mesma forma que a API real devolve.
import { money, sub, toCents } from "../../core/money.js";
import type { OdooClient } from "../../core/ports.js";
import type { OdooInvoice, OdooInvoiceLine, OdooPartner, OdooPaymentResult } from "../../core/types.js";
import { fromOdooDatetime } from "../odoo/client.js";

export interface FakePayment { id: number; moveLineId: number; amount: string; paymentDate: string; ref: string | null }

export class FakeOdoo implements OdooClient {
  partners = new Map<number, OdooPartner>();
  invoices = new Map<number, OdooInvoice>();
  lines = new Map<number, OdooInvoiceLine>();
  payments: FakePayment[] = [];
  private nextPaymentId = 1;
  private tick = 0;

  /** write_date no formato do Odoo (UTC naive). Guardado normalizado, como o adaptador real faz. */
  stamp(): string { this.tick++; return fromOdooDatetime(`2026-09-09 12:00:${String(this.tick % 60).padStart(2, "0")}`); }

  addPartner(p: Partial<OdooPartner> & { id: number; name: string }): OdooPartner {
    const partner: OdooPartner = { vat: null, email: null, phone: null, ...p };
    this.partners.set(p.id, partner);
    return partner;
  }
  addInvoice(i: { id: number; name: string; partnerId: number; invoiceDate?: string; lines: Array<{ id: number; dateMaturity: string; amount: string }>; state?: OdooInvoice["state"]; moveType?: string; writeDate?: string }): OdooInvoice {
    const total = i.lines.reduce((acc, l) => acc + toCents(l.amount), 0);
    const inv: OdooInvoice = {
      id: i.id, name: i.name, partnerId: i.partnerId, invoiceDate: i.invoiceDate ?? "2026-09-01",
      dueDate: i.lines[i.lines.length - 1]?.dateMaturity ?? null, amountResidual: money(total / 100),
      state: i.state ?? "posted", paymentState: "not_paid", moveType: i.moveType ?? "out_invoice", writeDate: i.writeDate ? fromOdooDatetime(i.writeDate) : this.stamp(),
    };
    this.invoices.set(inv.id, inv);
    for (const l of i.lines) this.lines.set(l.id, { id: l.id, moveId: inv.id, dateMaturity: l.dateMaturity, amountResidual: money(l.amount), reconciled: false });
    return inv;
  }
  cancelInvoice(id: number): void { const inv = this.invoices.get(id); if (inv) { inv.state = "cancel"; inv.writeDate = this.stamp(); } }
  resetToDraft(id: number): void { const inv = this.invoices.get(id); if (inv) { inv.state = "draft"; inv.writeDate = this.stamp(); } }
  /** Re-postar depois do rascunho: mesmas linhas, ou linhas novas (ids diferentes) se a fatura foi refeita. */
  repost(id: number, newLines?: Array<{ id: number; dateMaturity: string; amount: string }>): void {
    const inv = this.invoices.get(id)!;
    if (newLines) {
      for (const [lid, l] of this.lines) if (l.moveId === id) this.lines.delete(lid);
      for (const l of newLines) this.lines.set(l.id, { id: l.id, moveId: id, dateMaturity: l.dateMaturity, amountResidual: money(l.amount), reconciled: false });
    }
    inv.state = "posted"; inv.paymentState = "not_paid"; inv.writeDate = this.stamp();
  }

  async searchInvoices(q: { after?: { writeDate: string; id: number } | null; invoiceDateFrom?: string | null; partnerId?: number | null; limit?: number }): Promise<OdooInvoice[]> {
    const after = q.after;
    return [...this.invoices.values()]
      .filter((i) => i.moveType === "out_invoice")
      .filter((i) => !after || i.writeDate.slice(0, 19) > after.writeDate.slice(0, 19) || (i.writeDate.slice(0, 19) === after.writeDate.slice(0, 19) && i.id > after.id))
      .filter((i) => !q.invoiceDateFrom || (i.invoiceDate ?? "") >= q.invoiceDateFrom)
      .filter((i) => !q.partnerId || i.partnerId === q.partnerId)
      .sort((a, b) => a.writeDate.localeCompare(b.writeDate) || a.id - b.id)
      .slice(0, q.limit ?? 200)
      .map((i) => ({ ...i }));
  }
  async searchInvoicesInSecond(q: { second: string; afterId: number; invoiceDateFrom?: string | null; limit?: number }): Promise<OdooInvoice[]> {
    const sec = q.second.slice(0, 19);
    return [...this.invoices.values()]
      .filter((i) => i.moveType === "out_invoice" && i.writeDate.slice(0, 19) === sec && i.id > q.afterId)
      .filter((i) => !q.invoiceDateFrom || (i.invoiceDate ?? "") >= q.invoiceDateFrom)
      .sort((a, b) => a.id - b.id).slice(0, q.limit ?? 200).map((i) => ({ ...i }));
  }
  async getInvoice(id: number): Promise<OdooInvoice | null> { const i = this.invoices.get(id); return i ? { ...i } : null; }
  async getPaymentTermLines(moveId: number): Promise<OdooInvoiceLine[]> {
    return [...this.lines.values()].filter((l) => l.moveId === moveId).sort((a, b) => a.dateMaturity.localeCompare(b.dateMaturity) || a.id - b.id).map((l) => ({ ...l }));
  }
  async getOpenPaymentTermLines(moveId: number): Promise<OdooInvoiceLine[]> { return (await this.getPaymentTermLines(moveId)).filter((l) => !l.reconciled); }
  async getPaymentTermLine(lineId: number): Promise<OdooInvoiceLine | null> { const l = this.lines.get(lineId); return l ? { ...l } : null; }
  async getPartner(id: number): Promise<OdooPartner | null> { const p = this.partners.get(id); return p ? { ...p } : null; }
  async registerPayment(p: { moveLineId: number; amount: string; paymentDate: string; ref?: string }): Promise<OdooPaymentResult> {
    const line = this.lines.get(p.moveLineId);
    if (!line) throw new Error(`fake odoo: move line ${p.moveLineId} não existe`);
    const stray = p.ref ? this.payments.find((x) => x.ref === p.ref) : undefined;
    if (stray) { if (line.reconciled) return { paymentId: stray.id, paymentState: this.invoices.get(line.moveId)!.paymentState }; throw Object.assign(new Error(`fake odoo: pagamento #${stray.id} já existe com ref ${p.ref} e a parcela continua aberta`), { transient: false }); }
    if (line.reconciled) throw new Error(`fake odoo: move line ${p.moveLineId} já conciliada`);
    line.amountResidual = toCents(p.amount) >= toCents(line.amountResidual) ? "0.00" : sub(line.amountResidual, p.amount);
    line.reconciled = line.amountResidual === "0.00";
    const inv = this.invoices.get(line.moveId)!;
    inv.amountResidual = sub(inv.amountResidual, p.amount);
    const open = [...this.lines.values()].filter((l) => l.moveId === inv.id && !l.reconciled);
    inv.paymentState = open.length === 0 ? "in_payment" : "partial";
    inv.writeDate = this.stamp();
    const payment = { id: this.nextPaymentId++, moveLineId: p.moveLineId, amount: p.amount, paymentDate: p.paymentDate, ref: p.ref ?? null };
    this.payments.push(payment);
    return { paymentId: payment.id, paymentState: inv.paymentState };
  }
}
