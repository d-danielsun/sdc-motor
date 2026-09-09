// Asaas API v3 — header access_token (não é Bearer). Contrato: 02-SPEC.md §Contrato Asaas.
import { normalizeAsaasPayment } from "../../core/asaasPayload.js";
import { toCents } from "../../core/money.js";
import type { AsaasClient, Repo } from "../../core/ports.js";
import type { AsaasCustomer, AsaasPayment, AsaasWebhook } from "../../core/types.js";
import { HttpError, httpJson } from "../http.js";

export interface AsaasConfig { url: string; apiKey: string; fetchImpl?: typeof fetch; audit?: Repo["audit"] | null; userAgent?: string }

export const ASAAS_EVENTS = [
  "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "PAYMENT_UPDATED", "PAYMENT_DELETED", "PAYMENT_RESTORED",
  "PAYMENT_BANK_SLIP_CANCELLED", "PAYMENT_REFUNDED", "PAYMENT_PARTIALLY_REFUNDED", "PAYMENT_RECEIVED_IN_CASH_UNDONE",
] as const;

type Raw = Record<string, unknown>;
const asNum = (m: string) => toCents(m) / 100;

export class AsaasHttpClient implements AsaasClient {
  constructor(private readonly cfg: AsaasConfig) {
    const isSandbox = cfg.url.includes("sandbox");
    if (cfg.apiKey && ((isSandbox && !cfg.apiKey.startsWith("$aact_hmlg_")) || (!isSandbox && !cfg.apiKey.startsWith("$aact_prod_")))) {
      throw new Error(`ASAAS_API_KEY não bate com ASAAS_URL (${isSandbox ? "sandbox" : "produção"}) — falha fechada`);
    }
  }

  private async req<T = Raw>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    const url = `${this.cfg.url}${path}`;
    const r = await httpJson("asaas", url, {
      method, fetchImpl: this.cfg.fetchImpl,
      headers: { access_token: this.cfg.apiKey, "Content-Type": "application/json", "User-Agent": this.cfg.userAgent ?? "sdc-motor/0.1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await this.cfg.audit?.log({ direction: "asaas_out", endpoint: `${method} ${path.split("?")[0]}`, responseStatus: r.status, durationMs: r.durationMs, requestSummary: body ? Object.keys(body as Raw) : undefined });
    if (r.status === 404 && allow404) return null;
    if (r.status >= 400) throw new HttpError("asaas", r.status, r.body);
    return r.body as T;
  }

  private customer(r: Raw): AsaasCustomer {
    return { id: String(r.id), name: String(r.name ?? ""), cpfCnpj: (r.cpfCnpj as string) ?? null, email: (r.email as string) ?? null, externalReference: (r.externalReference as string) ?? null, notificationDisabled: r.notificationDisabled === true };
  }
  private payment(r: Raw): AsaasPayment {
    const p = normalizeAsaasPayment(r);
    if (!p) throw new HttpError("asaas", 502, r, "asaas: objeto payment sem id/value");
    return p;
  }
  private webhook(r: Raw): AsaasWebhook {
    return { id: String(r.id), name: String(r.name ?? ""), url: String(r.url ?? ""), enabled: r.enabled === true, interrupted: r.interrupted === true, penalizedRequestsCount: Number(r.penalizedRequestsCount ?? 0), sendType: String(r.sendType ?? ""), events: Array.isArray(r.events) ? (r.events as string[]) : [] };
  }

  async findCustomerByExternalRef(ref: string): Promise<AsaasCustomer | null> {
    const r = await this.req<{ data: Raw[] }>("GET", `/customers?externalReference=${encodeURIComponent(ref)}&limit=1`);
    const first = r?.data?.[0];
    return first ? this.customer(first) : null;
  }
  async createCustomer(c: Parameters<AsaasClient["createCustomer"]>[0]): Promise<AsaasCustomer> {
    const r = await this.req<Raw>("POST", "/customers", { name: c.name, cpfCnpj: c.cpfCnpj, email: c.email ?? undefined, mobilePhone: c.phone ?? undefined, externalReference: c.externalReference, notificationDisabled: c.notificationDisabled });
    return this.customer(r!);
  }
  async updateCustomer(id: string, patch: { notificationDisabled?: boolean }): Promise<AsaasCustomer> {
    return this.customer((await this.req<Raw>("PUT", `/customers/${id}`, patch))!);
  }
  async createPayment(p: Parameters<AsaasClient["createPayment"]>[0]): Promise<AsaasPayment> {
    const r = await this.req<Raw>("POST", "/payments", { customer: p.customer, billingType: "BOLETO", value: asNum(p.value), dueDate: p.dueDate, externalReference: p.externalReference, description: p.description });
    return this.payment(r!);
  }
  async getPayment(id: string): Promise<AsaasPayment | null> {
    const r = await this.req<Raw>("GET", `/payments/${id}`, undefined, true);
    return r ? this.payment(r) : null;
  }
  async deletePayment(id: string): Promise<void> {
    await this.req("DELETE", `/payments/${id}`);
  }
  async *listPayments(f: { status?: string; paymentDateFrom?: string; externalReference?: string }): AsyncIterable<AsaasPayment> {
    const q = new URLSearchParams({ limit: "100" });
    if (f.status) q.set("status", f.status);
    if (f.paymentDateFrom) q.set("paymentDate[ge]", f.paymentDateFrom);
    if (f.externalReference) q.set("externalReference", f.externalReference);
    for (let offset = 0; ; offset += 100) {
      q.set("offset", String(offset));
      const r = await this.req<{ data: Raw[]; hasMore: boolean }>("GET", `/payments?${q}`);
      for (const row of r?.data ?? []) yield this.payment(row);
      if (!r?.hasMore) return;
    }
  }
  async getWebhook(id: string): Promise<AsaasWebhook | null> {
    const r = await this.req<Raw>("GET", `/webhooks/${id}`, undefined, true);
    return r ? this.webhook(r) : null;
  }
  async listWebhooks(): Promise<AsaasWebhook[]> {
    const r = await this.req<{ data: Raw[] }>("GET", "/webhooks");
    return (r?.data ?? []).map((w) => this.webhook(w));
  }
  async createWebhook(w: Parameters<AsaasClient["createWebhook"]>[0]): Promise<AsaasWebhook> {
    const r = await this.req<Raw>("POST", "/webhooks", { ...w, enabled: true, interrupted: false, apiVersion: 3, sendType: "SEQUENTIALLY" });
    return this.webhook(r!);
  }
  async updateWebhook(id: string, patch: { interrupted?: boolean; enabled?: boolean }): Promise<AsaasWebhook> {
    return this.webhook((await this.req<Raw>("PUT", `/webhooks/${id}`, patch))!);
  }
  /** Só existe no sandbox: liquida a cobrança (pula direto pra RECEIVED). */
  async sandboxConfirm(paymentId: string): Promise<void> {
    await this.req("POST", `/sandbox/payment/${paymentId}/confirm`, {});
  }
}
