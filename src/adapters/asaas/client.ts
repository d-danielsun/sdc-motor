// Asaas API v3 — header access_token (não é Bearer). Contrato: 02-SPEC.md §Contrato Asaas.
import { asaasId, normalizeAsaasPayment } from "../../core/asaasPayload.js";
import { toCents } from "../../core/money.js";
import type { AsaasClient, Repo } from "../../core/ports.js";
import type { AsaasCustomer, AsaasPayment, AsaasWebhook } from "../../core/types.js";
import { HttpError, USER_AGENT, audited, httpJson } from "../http.js";

export interface AsaasConfig { url: string; apiKey: string; fetchImpl?: typeof fetch; audit?: Repo["audit"] | null }

/** Eventos que o motor assina (S3). É o default do createWebhook e do job register-asaas-webhook. */
export const ASAAS_EVENTS = [
  "PAYMENT_CONFIRMED", "PAYMENT_RECEIVED", "PAYMENT_OVERDUE", "PAYMENT_UPDATED", "PAYMENT_DELETED", "PAYMENT_RESTORED",
  "PAYMENT_BANK_SLIP_CANCELLED", "PAYMENT_REFUNDED", "PAYMENT_PARTIALLY_REFUNDED", "PAYMENT_RECEIVED_IN_CASH_UNDONE",
] as const;

type Raw = Record<string, unknown>;
const asNum = (m: string) => toCents(m) / 100;
/** ids entram em paths: charset validado + encode, senão `pay_1/../webhooks/x` viraria outro endpoint. */
const idPath = (id: string): string => {
  if (!asaasId(id)) throw new HttpError("asaas", 400, null, `asaas: id inválido ${JSON.stringify(id).slice(0, 40)}`);
  return encodeURIComponent(id);
};

export class AsaasHttpClient implements AsaasClient {
  constructor(private readonly cfg: AsaasConfig) {
    const isSandbox = cfg.url.includes("sandbox");
    if (cfg.apiKey && ((isSandbox && !cfg.apiKey.startsWith("$aact_hmlg_")) || (!isSandbox && !cfg.apiKey.startsWith("$aact_prod_")))) {
      throw new Error(`ASAAS_API_KEY não bate com ASAAS_URL (${isSandbox ? "sandbox" : "produção"}) — falha fechada`);
    }
  }

  private async req<T = Raw>(method: string, path: string, body?: unknown, allow404 = false): Promise<T | null> {
    const r = await audited(this.cfg.audit, "asaas_out", `${method} ${path.split("?")[0]!.replace(/\/[^/]+$/, "/:id")}`, body ? Object.keys(body as Raw) : undefined, () =>
      httpJson("asaas", `${this.cfg.url}${path}`, {
        method, fetchImpl: this.cfg.fetchImpl,
        headers: { access_token: this.cfg.apiKey, "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
    if (r.status === 404 && allow404) return null;
    if (r.status >= 400) throw new HttpError("asaas", r.status, r.body);
    if (r.body === null || typeof r.body !== "object") throw new HttpError("asaas", 502, r.body, `asaas: ${method} ${path} devolveu ${typeof r.body}`);
    return r.body as T;
  }

  private customer(r: Raw): AsaasCustomer {
    const id = asaasId(r.id);
    if (!id) throw new HttpError("asaas", 502, r, "asaas: objeto customer sem id válido");
    return { id, name: String(r.name ?? ""), cpfCnpj: (r.cpfCnpj as string) ?? null, email: (r.email as string) ?? null, externalReference: (r.externalReference as string) ?? null, notificationDisabled: r.notificationDisabled === true };
  }
  private payment(r: Raw): AsaasPayment {
    const p = normalizeAsaasPayment(r);
    if (!p) throw new HttpError("asaas", 502, r, "asaas: objeto payment sem id/value válidos");
    return p;
  }
  private webhook(r: Raw): AsaasWebhook {
    const id = asaasId(r.id);
    if (!id) throw new HttpError("asaas", 502, r, "asaas: objeto webhook sem id válido");
    return { id, name: String(r.name ?? ""), url: String(r.url ?? ""), enabled: r.enabled === true, interrupted: r.interrupted === true, penalizedRequestsCount: Number(r.penalizedRequestsCount ?? 0), sendType: String(r.sendType ?? ""), events: Array.isArray(r.events) ? (r.events as string[]) : [] };
  }
  private list<T>(r: { data?: unknown; hasMore?: unknown } | null, map: (x: Raw) => T): { items: T[]; hasMore: boolean } {
    if (!r || !Array.isArray(r.data)) throw new HttpError("asaas", 502, r, "asaas: listagem sem `data`");
    return { items: (r.data as Raw[]).map(map), hasMore: r.hasMore === true };
  }

  async findCustomerByExternalRef(ref: string): Promise<AsaasCustomer | null> {
    const r = await this.req<{ data: Raw[] }>("GET", `/customers?externalReference=${encodeURIComponent(ref)}&limit=1`);
    return this.list(r, (x) => this.customer(x)).items[0] ?? null;
  }
  async findCustomerByDocument(cpfCnpj: string): Promise<AsaasCustomer | null> {
    if (!/^\d{11}$|^\d{14}$/.test(cpfCnpj)) return null;
    const r = await this.req<{ data: Raw[] }>("GET", `/customers?cpfCnpj=${cpfCnpj}&limit=1`);
    return this.list(r, (x) => this.customer(x)).items[0] ?? null;
  }
  async createCustomer(c: Parameters<AsaasClient["createCustomer"]>[0]): Promise<AsaasCustomer> {
    const r = await this.req<Raw>("POST", "/customers", { name: c.name, cpfCnpj: c.cpfCnpj, email: c.email ?? undefined, mobilePhone: c.phone ?? undefined, externalReference: c.externalReference, notificationDisabled: c.notificationDisabled });
    return this.customer(r!);
  }
  async updateCustomer(id: string, patch: { notificationDisabled?: boolean }): Promise<AsaasCustomer> {
    return this.customer((await this.req<Raw>("PUT", `/customers/${idPath(id)}`, patch))!);
  }
  async createPayment(p: Parameters<AsaasClient["createPayment"]>[0]): Promise<AsaasPayment> {
    const r = await this.req<Raw>("POST", "/payments", { customer: p.customer, billingType: "BOLETO", value: asNum(p.value), dueDate: p.dueDate, externalReference: p.externalReference, description: p.description });
    return this.payment(r!);
  }
  async getPayment(id: string): Promise<AsaasPayment | null> {
    const r = await this.req<Raw>("GET", `/payments/${idPath(id)}`, undefined, true);
    return r ? this.payment(r) : null;
  }
  async findPaymentByExternalRef(ref: string): Promise<AsaasPayment | null> {
    for await (const p of this.listPayments({ externalReference: ref })) if (!p.deleted) return p;
    return null;
  }
  async deletePayment(id: string): Promise<void> {
    const r = await this.req<Raw>("DELETE", `/payments/${idPath(id)}`, undefined, true);   // já apagado = ok
    if (r && r.deleted !== true) throw new HttpError("asaas", 502, r, "asaas: DELETE não confirmou deleted=true");
  }
  async *listPayments(f: { status?: string; paymentDateFrom?: string; creditDateFrom?: string; externalReference?: string }): AsyncIterable<AsaasPayment> {
    const q = new URLSearchParams({ limit: "100" });
    if (f.status) q.set("status", f.status);
    if (f.paymentDateFrom) q.set("paymentDate[ge]", f.paymentDateFrom);
    if (f.creditDateFrom) q.set("estimatedCreditDate[ge]", f.creditDateFrom);
    if (f.externalReference) q.set("externalReference", f.externalReference);
    for (let offset = 0; ; offset += 100) {
      q.set("offset", String(offset));
      const page = this.list(await this.req<{ data: Raw[]; hasMore: boolean }>("GET", `/payments?${q}`), (x) => this.payment(x));
      yield* page.items;
      if (!page.hasMore || page.items.length === 0) return;
    }
  }
  async getWebhook(id: string): Promise<AsaasWebhook | null> {
    const r = await this.req<Raw>("GET", `/webhooks/${idPath(id)}`, undefined, true);
    return r ? this.webhook(r) : null;
  }
  async listWebhooks(): Promise<AsaasWebhook[]> {
    return this.list(await this.req<{ data: Raw[] }>("GET", "/webhooks"), (x) => this.webhook(x)).items;
  }
  async createWebhook(w: Parameters<AsaasClient["createWebhook"]>[0]): Promise<AsaasWebhook> {
    const r = await this.req<Raw>("POST", "/webhooks", { ...w, events: w.events.length ? w.events : [...ASAAS_EVENTS], enabled: true, interrupted: false, apiVersion: 3, sendType: "SEQUENTIALLY" });
    return this.webhook(r!);
  }
  async updateWebhook(id: string, patch: { interrupted?: boolean; enabled?: boolean }): Promise<AsaasWebhook> {
    return this.webhook((await this.req<Raw>("PUT", `/webhooks/${idPath(id)}`, patch))!);
  }
  /** Só existe no sandbox: liquida a cobrança (pula direto pra RECEIVED). */
  async sandboxConfirm(paymentId: string): Promise<void> {
    await this.req("POST", `/sandbox/payment/${idPath(paymentId)}/confirm`, {});
  }
}
