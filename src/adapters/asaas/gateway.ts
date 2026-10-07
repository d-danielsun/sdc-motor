// AsaasGateway: a porta neutra embrulhando o AsaasClient, sem mudar comportamento.
// Os tipos do Asaas já têm o formato da porta (o vocabulário neutro nasceu deles), então a
// tradução é quase identidade — o que muda é o nome das operações e o aviso normalizado.
//
// Delegação é feita chamando o client a cada operação (nunca guardando referência ao método):
// os testes sobrescrevem métodos do fake (`w.deps.asaas.getPayment = …`) e isso tem que valer.
import type { ChargeGateway, GatewayCharge, GatewayCustomer, GatewayEventQueue, SettlementEvent, SettlementEventKind } from "../../core/gateway.js";
import { normalizeAsaasEvent } from "./payload.js";
import type { AsaasClient } from "./types.js";

const KIND: Record<string, SettlementEventKind> = {
  PAYMENT_CONFIRMED: "confirmed",
  PAYMENT_RECEIVED: "received",
  PAYMENT_UPDATED: "updated",
  PAYMENT_DELETED: "deleted",
  PAYMENT_BANK_SLIP_CANCELLED: "slip_cancelled",
  PAYMENT_RESTORED: "restored",
  PAYMENT_REFUNDED: "reversal",
  PAYMENT_PARTIALLY_REFUNDED: "reversal",
  PAYMENT_RECEIVED_IN_CASH_UNDONE: "reversal",
  PAYMENT_OVERDUE: "overdue",
};

export class AsaasGateway implements ChargeGateway {
  readonly name = "asaas";
  constructor(readonly client: AsaasClient) {}

  findCustomerByExternalRef(ref: string): Promise<GatewayCustomer | null> { return this.client.findCustomerByExternalRef(ref); }
  findCustomerByDocument(cpfCnpj: string): Promise<GatewayCustomer | null> { return this.client.findCustomerByDocument(cpfCnpj); }
  createCustomer(c: Parameters<ChargeGateway["createCustomer"]>[0]): Promise<GatewayCustomer> { return this.client.createCustomer(c); }
  updateCustomer(id: string, patch: { notificationDisabled?: boolean }): Promise<GatewayCustomer> { return this.client.updateCustomer(id, patch); }

  createCharge(p: Parameters<ChargeGateway["createCharge"]>[0]): Promise<GatewayCharge> { return this.client.createPayment(p); }
  getCharge(id: string): Promise<GatewayCharge | null> { return this.client.getPayment(id); }
  findChargeByExternalRef(ref: string): Promise<GatewayCharge | null> { return this.client.findPaymentByExternalRef(ref); }
  cancelCharge(id: string): Promise<void> { return this.client.deletePayment(id); }
  listCharges(f: Parameters<ChargeGateway["listCharges"]>[0]): AsyncIterable<GatewayCharge> { return this.client.listPayments(f); }

  parseSettlementEvent(payload: unknown): SettlementEvent | null {
    const ev = normalizeAsaasEvent(payload);
    if (!ev) return null;
    const p = ev.payment;
    return {
      eventId: ev.id, kind: KIND[ev.event] ?? "other", rawType: ev.event,
      gatewayChargeId: p.id, externalReference: p.externalReference, status: p.status,
      grossValue: p.value, netValue: p.netValue, paymentDate: p.paymentDate, creditDate: p.creditDate,
    };
  }
  async getEventQueue(id: string): Promise<GatewayEventQueue | null> {
    const w = await this.client.getWebhook(id);
    return w ? { id: w.id, enabled: w.enabled, interrupted: w.interrupted, penalizedRequestsCount: w.penalizedRequestsCount } : null;
  }
  async resumeEventQueue(id: string): Promise<void> { await this.client.updateWebhook(id, { interrupted: false }); }
}
