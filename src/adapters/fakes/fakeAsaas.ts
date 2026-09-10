// Asaas em memória, com o comportamento que importa: ids, status, eventos de webhook e fila interrompível.
import { money } from "../../core/money.js";
import type { AsaasClient } from "../../core/ports.js";
import type { AsaasCustomer, AsaasPayment, AsaasWebhook, AsaasWebhookEvent } from "../../core/types.js";

export class FakeAsaas implements AsaasClient {
  customers = new Map<string, AsaasCustomer>();
  payments = new Map<string, AsaasPayment>();
  webhooks = new Map<string, AsaasWebhook>();
  deleted: string[] = [];
  private n = 0;
  private next(prefix: string): string { this.n++; return `${prefix}_fake_${String(this.n).padStart(4, "0")}`; }

  async findCustomerByExternalRef(ref: string): Promise<AsaasCustomer | null> {
    return [...this.customers.values()].find((c) => c.externalReference === ref) ?? null;
  }
  async findCustomerByDocument(cpfCnpj: string): Promise<AsaasCustomer | null> {
    return [...this.customers.values()].find((c) => c.cpfCnpj === cpfCnpj) ?? null;
  }
  async createCustomer(c: Parameters<AsaasClient["createCustomer"]>[0]): Promise<AsaasCustomer> {
    if (!/^\d{11}$|^\d{14}$/.test(c.cpfCnpj)) throw new Error("fake asaas: cpfCnpj inválido");
    const cust: AsaasCustomer = { id: this.next("cus"), name: c.name, cpfCnpj: c.cpfCnpj, email: c.email ?? null, externalReference: c.externalReference, notificationDisabled: c.notificationDisabled };
    this.customers.set(cust.id, cust);
    return cust;
  }
  async updateCustomer(id: string, patch: { notificationDisabled?: boolean }): Promise<AsaasCustomer> {
    const c = this.customers.get(id);
    if (!c) throw new Error("fake asaas: cliente inexistente");
    Object.assign(c, patch);
    return c;
  }
  async createPayment(p: Parameters<AsaasClient["createPayment"]>[0]): Promise<AsaasPayment> {
    if (!this.customers.has(p.customer)) throw new Error("fake asaas: customer inexistente");
    const id = this.next("pay");
    const pay: AsaasPayment = {
      id, customer: p.customer, status: "PENDING", billingType: "BOLETO", value: money(p.value), netValue: null, originalValue: null, interestValue: null,
      dueDate: p.dueDate, paymentDate: null, clientPaymentDate: null, creditDate: null, externalReference: p.externalReference,
      bankSlipUrl: `https://sandbox.asaas.com/b/pdf/${id}`, invoiceUrl: `https://sandbox.asaas.com/i/${id}`, invoiceNumber: String(10_000 + this.n), nossoNumero: String(20_000 + this.n), deleted: false,
    };
    this.payments.set(id, pay);
    return { ...pay };
  }
  async getPayment(id: string): Promise<AsaasPayment | null> { const p = this.payments.get(id); return p ? { ...p } : null; }
  async findPaymentByExternalRef(ref: string): Promise<AsaasPayment | null> {
    return [...this.payments.values()].filter((p) => p.externalReference === ref && !p.deleted).map((p) => ({ ...p }))[0] ?? null;
  }
  async deletePayment(id: string): Promise<void> {
    const p = this.payments.get(id);
    if (!p) return;
    if (p.status === "RECEIVED" || p.status === "RECEIVED_IN_CASH") throw new Error("fake asaas: não é possível apagar cobrança recebida");
    p.deleted = true; this.deleted.push(id);
  }
  async *listPayments(f: { status?: string; paymentDateFrom?: string; externalReference?: string }): AsyncIterable<AsaasPayment> {
    for (const p of this.payments.values()) {
      if (f.status && p.status !== f.status) continue;
      if (f.paymentDateFrom && (p.paymentDate ?? "") < f.paymentDateFrom) continue;
      if (f.externalReference && p.externalReference !== f.externalReference) continue;
      yield { ...p };
    }
  }
  async getWebhook(id: string): Promise<AsaasWebhook | null> { const w = this.webhooks.get(id); return w ? { ...w } : null; }
  async listWebhooks(): Promise<AsaasWebhook[]> { return [...this.webhooks.values()].map((w) => ({ ...w })); }
  async createWebhook(w: Parameters<AsaasClient["createWebhook"]>[0]): Promise<AsaasWebhook> {
    const wh: AsaasWebhook = { id: this.next("wh"), name: w.name, url: w.url, enabled: true, interrupted: false, penalizedRequestsCount: 0, sendType: "SEQUENTIALLY", events: w.events };
    this.webhooks.set(wh.id, wh);
    return { ...wh };
  }
  async updateWebhook(id: string, patch: { interrupted?: boolean; enabled?: boolean }): Promise<AsaasWebhook> {
    const w = this.webhooks.get(id);
    if (!w) throw new Error("fake asaas: webhook inexistente");
    Object.assign(w, patch);
    return { ...w };
  }

  // ── helpers de teste: o que o Asaas faria sozinho ────────────────────────
  /** Liquida: status RECEIVED (ou RECEIVED_IN_CASH) e devolve o evento de webhook correspondente. */
  confirm(id: string, o: { value?: string; interest?: string; paymentDate?: string; inCash?: boolean } = {}): AsaasWebhookEvent {
    const p = this.payments.get(id);
    if (!p) throw new Error("fake asaas: payment inexistente");
    const date = o.paymentDate ?? "2026-09-10";
    if (o.interest) { p.originalValue = p.value; p.interestValue = money(o.interest); p.value = money((Number(p.value) + Number(o.interest)).toFixed(2)); }
    if (o.value) p.value = money(o.value);
    p.status = o.inCash ? "RECEIVED_IN_CASH" : "RECEIVED";
    p.paymentDate = date; p.clientPaymentDate = date; p.creditDate = date;
    p.netValue = money((Number(p.value) - 1.99).toFixed(2));
    return this.event("PAYMENT_RECEIVED", p);
  }
  /** Muda o estado do pagamento no "Asaas" (o worker relê o objeto vivo, então o evento sozinho não basta). */
  setStatus(id: string, status: string, patch: Partial<AsaasPayment> = {}): AsaasPayment {
    const p = this.payments.get(id);
    if (!p) throw new Error("fake asaas: payment inexistente");
    Object.assign(p, patch, { status });
    return { ...p };
  }
  event(event: string, p: AsaasPayment): AsaasWebhookEvent {
    return { id: this.next("evt"), event, dateCreated: "2026-09-10 10:00:00", payment: { ...p } };
  }
  interrupt(webhookId: string, penalized = 15): void {
    const w = this.webhooks.get(webhookId)!;
    w.interrupted = true; w.penalizedRequestsCount += penalized;
  }
}
