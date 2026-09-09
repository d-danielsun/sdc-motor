// Odoo JSON-2 (/json/2/<model>/<method>) — Authorization: bearer <api key>; body = parâmetros nomeados; `ids` p/ métodos de registro.
// Mecânica da baixa (account.payment.register) é CONFIRMADA NO SPIKE S0.3 — até lá, este arquivo é o desenho.
import { money } from "../../core/money.js";
import type { OdooClient, Repo } from "../../core/ports.js";
import type { OdooInvoice, OdooInvoiceLine, OdooPartner, OdooPaymentResult } from "../../core/types.js";
import { HttpError, httpJson } from "../http.js";

export interface OdooConfig { url: string; db?: string | null; apiKey: string; fetchImpl?: typeof fetch; audit?: Repo["audit"] | null; userAgent?: string }

type Raw = Record<string, unknown>;
const m2oId = (v: unknown): number => (Array.isArray(v) ? Number(v[0]) : typeof v === "number" ? v : 0);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export class OdooJson2Client implements OdooClient {
  constructor(private readonly cfg: OdooConfig) {}

  async call<T = unknown>(model: string, method: string, body: Raw): Promise<T> {
    const path = `/json/2/${model}/${method}`;
    const headers: Record<string, string> = { Authorization: `bearer ${this.cfg.apiKey}`, "Content-Type": "application/json; charset=utf-8", "User-Agent": this.cfg.userAgent ?? "sdc-motor/0.1" };
    if (this.cfg.db) headers["X-Odoo-Database"] = this.cfg.db;
    const r = await httpJson("odoo", `${this.cfg.url}${path}`, { method: "POST", headers, body: JSON.stringify(body), fetchImpl: this.cfg.fetchImpl });
    await this.cfg.audit?.log({ direction: "odoo_out", endpoint: `${model}.${method}`, responseStatus: r.status, durationMs: r.durationMs, requestSummary: Object.keys(body) });
    if (r.status >= 400) throw new HttpError("odoo", r.status, r.body);
    return r.body as T;
  }

  private searchRead<T = Raw>(model: string, domain: unknown[], fields: string[], extra: Raw = {}): Promise<T[]> {
    return this.call<T[]>(model, "search_read", { domain, fields, ...extra });
  }
  private invoice(r: Raw): OdooInvoice {
    return {
      id: Number(r.id), name: String(r.name ?? ""), partnerId: m2oId(r.partner_id),
      invoiceDate: strOrNull(r.invoice_date), dueDate: strOrNull(r.invoice_date_due),
      amountResidual: money(Number(r.amount_residual ?? 0)), state: (r.state as OdooInvoice["state"]) ?? "draft",
      paymentState: String(r.payment_state ?? ""), moveType: String(r.move_type ?? ""), writeDate: String(r.write_date ?? ""),
    };
  }
  static readonly INVOICE_FIELDS = ["id", "name", "partner_id", "invoice_date", "invoice_date_due", "amount_residual", "state", "payment_state", "move_type", "write_date"];

  async searchInvoices(q: { writeDateAfter?: string | null; invoiceDateFrom?: string | null }): Promise<OdooInvoice[]> {
    const domain: unknown[] = [["move_type", "=", "out_invoice"], ["state", "in", ["posted", "cancel"]]];
    if (q.writeDateAfter) domain.push(["write_date", ">", q.writeDateAfter]);
    if (q.invoiceDateFrom) domain.push(["invoice_date", ">=", q.invoiceDateFrom]);
    const rows = await this.searchRead("account.move", domain, OdooJson2Client.INVOICE_FIELDS, { order: "write_date asc", limit: 500 });
    return rows.map((r) => this.invoice(r));
  }
  async getInvoice(id: number): Promise<OdooInvoice | null> {
    const rows = await this.searchRead("account.move", [["id", "=", id]], OdooJson2Client.INVOICE_FIELDS, { limit: 1 });
    return rows[0] ? this.invoice(rows[0]) : null;
  }
  async getOpenPaymentTermLines(moveId: number): Promise<OdooInvoiceLine[]> {
    const rows = await this.searchRead("account.move.line", [["move_id", "=", moveId], ["display_type", "=", "payment_term"], ["reconciled", "=", false]], ["id", "move_id", "date_maturity", "amount_residual", "reconciled"], { order: "date_maturity asc" });
    return rows.map((r) => ({ id: Number(r.id), moveId: m2oId(r.move_id), dateMaturity: String(r.date_maturity ?? ""), amountResidual: money(Number(r.amount_residual ?? 0)), reconciled: r.reconciled === true }));
  }
  async getPartner(id: number): Promise<OdooPartner | null> {
    const rows = await this.searchRead("res.partner", [["id", "=", id]], ["id", "name", "vat", "email", "phone", "mobile"], { limit: 1 });
    const r = rows[0];
    return r ? { id: Number(r.id), name: String(r.name ?? ""), vat: strOrNull(r.vat), email: strOrNull(r.email), phone: strOrNull(r.mobile) ?? strOrNull(r.phone) } : null;
  }
  /** Wizard de baixa em 2 chamadas (shape a confirmar no S0.3: journal_id / payment_method_line_id podem ser exigidos). */
  async registerPayment(p: { moveLineId: number; amount: string; paymentDate: string }): Promise<OdooPaymentResult> {
    const context = { active_model: "account.move.line", active_ids: [p.moveLineId] };
    const ids = await this.call<number[] | number>("account.payment.register", "create", { context, vals_list: [{ amount: Number(p.amount), payment_date: p.paymentDate }] });
    const wizardId = Array.isArray(ids) ? ids[0] : ids;
    const action = await this.call<Raw>("account.payment.register", "action_create_payments", { ids: [wizardId], context });
    const paymentId = typeof action?.res_id === "number" ? action.res_id : null;
    const line = await this.searchRead("account.move.line", [["id", "=", p.moveLineId]], ["reconciled", "move_id"], { limit: 1 });
    const move = line[0] ? await this.searchRead("account.move", [["id", "=", m2oId(line[0].move_id)]], ["payment_state"], { limit: 1 }) : [];
    return { paymentId, paymentState: move[0] ? String(move[0].payment_state) : null };
  }
}
