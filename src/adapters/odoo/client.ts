// Odoo JSON-2 (/json/2/<model>/<method>) — Authorization: bearer <api key>; body = parâmetros nomeados; `ids` p/ métodos de registro.
// Datas: o Odoo fala "YYYY-MM-DD HH:MM:SS" (UTC, sem fuso); aqui dentro tudo vira ISO e volta no formato dele na saída.
// Mecânica da baixa (account.payment.register) é CONFIRMADA NO SPIKE S0.3 — até lá, este arquivo é o desenho.
import { WIZARD_TIMEOUT_MS } from "../../core/limits.js";
import { money, toCents } from "../../core/money.js";
import type { OdooClient, Repo } from "../../core/ports.js";
import type { OdooInvoice, OdooInvoiceLine, OdooPartner, OdooPaymentResult } from "../../core/types.js";
import { HttpError, USER_AGENT, audited, httpJson } from "../http.js";

export interface OdooConfig { url: string; db?: string | null; apiKey: string; fetchImpl?: typeof fetch; audit?: Repo["audit"] | null }

type Raw = Record<string, unknown>;
const m2oId = (v: unknown): number => (Array.isArray(v) ? Number(v[0]) : typeof v === "number" ? v : 0);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
/** "2026-09-09 13:00:00" (UTC naive do Odoo) → "2026-09-09T13:00:00.000Z"; ISO já formatado passa direto. */
export const fromOdooDatetime = (v: unknown): string => {
  const s = String(v ?? "");
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z)?$/);
  return m ? `${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4).padEnd(4, "0") : ".000"}Z` : s;
};
export const toOdooDatetime = (iso: string): string => new Date(iso).toISOString().slice(0, 19).replace("T", " ");

const INVOICE_FIELDS = ["id", "name", "partner_id", "invoice_date", "invoice_date_due", "amount_residual", "state", "payment_state", "move_type", "write_date"];
const LINE_FIELDS = ["id", "move_id", "date_maturity", "amount_residual", "reconciled"];
/** Campo do account.payment que guarda a referência: `memo` no Odoo 18+ (era `ref`). SDC = saas~19. Confirmar no S0.3. */
export const PAYMENT_REF_FIELD = "memo";

export class OdooJson2Client implements OdooClient {
  private readonly url: string;
  constructor(private readonly cfg: OdooConfig) { this.url = cfg.url.replace(/\/+$/, ""); }

  async call<T = unknown>(model: string, method: string, body: Raw, timeoutMs?: number): Promise<T> {
    const path = `/json/2/${model}/${method}`;
    const headers: Record<string, string> = { Authorization: `bearer ${this.cfg.apiKey}`, "Content-Type": "application/json; charset=utf-8", "User-Agent": USER_AGENT };
    if (this.cfg.db) headers["X-Odoo-Database"] = this.cfg.db;
    const r = await audited(this.cfg.audit, "odoo_out", `${model}.${method}`, Object.keys(body), () =>
      httpJson("odoo", `${this.url}${path}`, { method: "POST", headers, body: JSON.stringify(body), fetchImpl: this.cfg.fetchImpl, timeoutMs }));
    if (r.status >= 400) throw new HttpError("odoo", r.status, r.body);
    if (r.body === null || typeof r.body !== "object") throw new HttpError("odoo", 502, r.body, `odoo: ${model}.${method} devolveu ${typeof r.body}, esperava objeto/lista`);
    return r.body as T;
  }
  private rows(v: unknown, what: string): Raw[] {
    if (!Array.isArray(v)) throw new HttpError("odoo", 502, v, `odoo: ${what} não devolveu lista`);
    return v as Raw[];
  }
  private async searchRead(model: string, domain: unknown[], fields: string[], extra: Raw = {}): Promise<Raw[]> {
    return this.rows(await this.call<unknown>(model, "search_read", { domain, fields, ...extra }), `${model}.search_read`);
  }
  private invoice(r: Raw): OdooInvoice {
    return {
      id: Number(r.id), name: String(r.name ?? ""), partnerId: m2oId(r.partner_id),
      invoiceDate: strOrNull(r.invoice_date), dueDate: strOrNull(r.invoice_date_due),
      amountResidual: money(Number(r.amount_residual ?? 0)), state: (r.state as OdooInvoice["state"]) ?? "draft",
      paymentState: String(r.payment_state ?? ""), moveType: String(r.move_type ?? ""), writeDate: fromOdooDatetime(r.write_date),
    };
  }
  private line(r: Raw): OdooInvoiceLine {
    return { id: Number(r.id), moveId: m2oId(r.move_id), dateMaturity: String(r.date_maturity ?? ""), amountResidual: money(Number(r.amount_residual ?? 0)), reconciled: r.reconciled === true };
  }

  async searchInvoices(q: { after?: { writeDate: string; id: number } | null; invoiceDateFrom?: string | null; partnerId?: number | null; limit?: number }): Promise<OdooInvoice[]> {
    const domain: unknown[] = [["move_type", "=", "out_invoice"], ["state", "in", ["posted", "cancel", "draft"]]];
    if (q.after) {
      // O JSON-2 devolve write_date truncado a segundos, mas o banco compara com microssegundos: o segundo é um BALDE.
      const wd = toOdooDatetime(q.after.writeDate), next = toOdooDatetime(new Date(new Date(q.after.writeDate).getTime() + 1000).toISOString());
      domain.push("|", ["write_date", ">=", next], "&", ["write_date", ">=", wd], ["id", ">", q.after.id]);
    }
    if (q.invoiceDateFrom) domain.push(["invoice_date", ">=", q.invoiceDateFrom]);
    if (q.partnerId) domain.push(["partner_id", "=", q.partnerId]);
    const rows = await this.searchRead("account.move", domain, INVOICE_FIELDS, { order: "write_date asc, id asc", limit: q.limit ?? 200 });
    return rows.map((r) => this.invoice(r));
  }
  async searchInvoicesInSecond(q: { second: string; afterId: number; invoiceDateFrom?: string | null; limit?: number }): Promise<OdooInvoice[]> {
    const wd = toOdooDatetime(q.second), next = toOdooDatetime(new Date(new Date(q.second).getTime() + 1000).toISOString());
    const domain: unknown[] = [["move_type", "=", "out_invoice"], ["state", "in", ["posted", "cancel", "draft"]], ["write_date", ">=", wd], ["write_date", "<", next], ["id", ">", q.afterId]];
    if (q.invoiceDateFrom) domain.push(["invoice_date", ">=", q.invoiceDateFrom]);
    const rows = await this.searchRead("account.move", domain, INVOICE_FIELDS, { order: "id asc", limit: q.limit ?? 200 });
    return rows.map((r) => this.invoice(r));
  }
  async getInvoice(id: number): Promise<OdooInvoice | null> {
    const rows = await this.searchRead("account.move", [["id", "=", id]], INVOICE_FIELDS, { limit: 1 });
    return rows[0] ? this.invoice(rows[0]) : null;
  }
  async getPaymentTermLines(moveId: number): Promise<OdooInvoiceLine[]> {
    const rows = await this.searchRead("account.move.line", [["move_id", "=", moveId], ["display_type", "=", "payment_term"]], LINE_FIELDS, { order: "date_maturity asc, id asc" });
    return rows.map((r) => this.line(r));
  }
  async getOpenPaymentTermLines(moveId: number): Promise<OdooInvoiceLine[]> {
    return (await this.getPaymentTermLines(moveId)).filter((l) => !l.reconciled);
  }
  async getPaymentTermLine(lineId: number): Promise<OdooInvoiceLine | null> {
    const rows = await this.searchRead("account.move.line", [["id", "=", lineId]], LINE_FIELDS, { limit: 1 });
    return rows[0] ? this.line(rows[0]) : null;
  }
  async getPartner(id: number): Promise<OdooPartner | null> {
    const rows = await this.searchRead("res.partner", [["id", "=", id]], ["id", "name", "vat", "email", "phone", "mobile"], { limit: 1 });
    const r = rows[0];
    return r ? { id: Number(r.id), name: String(r.name ?? ""), vat: strOrNull(r.vat), email: strOrNull(r.email), phone: strOrNull(r.mobile) ?? strOrNull(r.phone) } : null;
  }
  /** Wizard de baixa com chave de idempotência (`memo` = ref) + VERIFICAÇÃO por residual antes×depois.
   *  Se já existe pagamento com esta ref no Odoo (retry após timeout, reprocesso após 409), ele é adotado ou o motor recusa — nunca duplica.
   *  Nome do campo (memo em 18+/ref antes), campos exigidos e tratamento de diferença se confirmam no spike S0.3 (issue #2). */
  async registerPayment(p: { moveLineId: number; amount: string; paymentDate: string; ref: string }): Promise<OdooPaymentResult> {
    const before = await this.getPaymentTermLine(p.moveLineId);
    if (!before) throw new HttpError("odoo", 409, null, `odoo: parcela ${p.moveLineId} não existe`);
    const stray = await this.findPaymentByRef(p.ref);
    if (stray) {
      if (before.reconciled) return { paymentId: stray.id, paymentState: null };   // o retry chegou depois de o Odoo terminar: adota
      throw new HttpError("odoo", 409, { paymentId: stray.id, state: stray.state }, `odoo: já existe o pagamento #${stray.id} (${stray.state}) com ref ${p.ref}, mas a parcela ${p.moveLineId} continua aberta — conciliar manualmente, não re-rodar o wizard`);
    }
    const context = { active_model: "account.move.line", active_ids: [p.moveLineId] };
    const created = await this.call<unknown>("account.payment.register", "create", { context, vals_list: [{ amount: Number(p.amount), payment_date: p.paymentDate, communication: p.ref }] });
    const wizardId = Array.isArray(created) ? created[0] : created;
    if (typeof wizardId !== "number") throw new HttpError("odoo", 502, created, "odoo: create do wizard não devolveu id numérico");
    const action = await this.call<Raw>("account.payment.register", "action_create_payments", { ids: [wizardId], context }, WIZARD_TIMEOUT_MS);
    const paymentId = typeof action.res_id === "number" ? action.res_id : (await this.findPaymentByRef(p.ref))?.id ?? null;
    const after = await this.getPaymentTermLine(p.moveLineId);
    if (!after) throw new HttpError("odoo", 409, { paymentId }, `odoo: parcela ${p.moveLineId} sumiu depois do wizard (pagamento #${paymentId ?? "?"})`);
    const applied = toCents(before.amountResidual) - toCents(after.amountResidual);
    if (!after.reconciled && applied < toCents(p.amount) - 1) {
      throw new HttpError("odoo", 409, { paymentId, before: before.amountResidual, after: after.amountResidual }, `odoo: wizard rodou (pagamento #${paymentId ?? "?"}) mas o residual da parcela ${p.moveLineId} caiu ${money(applied / 100)} em vez de ${p.amount} — baixa NÃO confirmada`);
    }
    const move = (await this.searchRead("account.move", [["id", "=", after.moveId]], ["payment_state"], { limit: 1 }))[0];
    return { paymentId, paymentState: move ? String(move.payment_state) : null };
  }
  /** Pagamento já criado com esta ref (chave de idempotência). */
  async findPaymentByRef(ref: string): Promise<{ id: number; state: string } | null> {
    const rows = await this.searchRead("account.payment", [[PAYMENT_REF_FIELD, "=", ref]], ["id", "state"], { limit: 1 });
    return rows[0] ? { id: Number(rows[0].id), state: String(rows[0].state ?? "") } : null;
  }
}
