// Tipos e porta do Asaas — vivem no adaptador. O núcleo só conhece ChargeGateway (src/core/gateway.ts).
import type { Money } from "../../core/money.js";

export interface AsaasCustomer {
  id: string;
  name: string;
  cpfCnpj: string | null;
  email: string | null;
  externalReference: string | null;
  notificationDisabled: boolean;
}
export interface AsaasPayment {
  id: string;
  customer: string;
  status: string;               // PENDING | CONFIRMED | RECEIVED | RECEIVED_IN_CASH | OVERDUE | REFUNDED | ...
  billingType: string;
  value: Money;
  netValue: Money | null;
  originalValue: Money | null;  // preenchido quando value inclui juros/multa
  interestValue: Money | null;
  dueDate: string;
  paymentDate: string | null;
  clientPaymentDate: string | null;
  creditDate: string | null;
  /** Previsão de crédito. É por ela que o reconcile faz o segundo passe (`estimatedCreditDate[ge]`),
   *  porque boleto pago numa quinta e creditado na terça sai da janela de `paymentDate`. */
  estimatedCreditDate: string | null;
  externalReference: string | null;
  bankSlipUrl: string | null;
  invoiceUrl: string | null;
  invoiceNumber: string | null;
  nossoNumero: string | null;
  deleted: boolean;
}
export interface AsaasWebhookEvent {
  id: string;
  event: string;
  dateCreated: string;
  payment: AsaasPayment;
}
export interface AsaasWebhook {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  interrupted: boolean;
  penalizedRequestsCount: number;
  sendType: string;
  events: string[];
}

export interface AsaasClient {
  findCustomerByExternalRef(ref: string): Promise<AsaasCustomer | null>;
  /** Cliente que a SDC já tinha no Asaas (sem a nossa referência): adotar em vez de duplicar por CPF/CNPJ. */
  findCustomerByDocument(cpfCnpj: string): Promise<AsaasCustomer | null>;
  createCustomer(c: {
    name: string; cpfCnpj: string; email?: string | null; phone?: string | null;
    externalReference: string; notificationDisabled: boolean;
  }): Promise<AsaasCustomer>;
  updateCustomer(id: string, patch: { notificationDisabled?: boolean }): Promise<AsaasCustomer>;
  createPayment(p: {
    customer: string; value: Money; dueDate: string; externalReference: string; description: string;
  }): Promise<AsaasPayment>;
  getPayment(id: string): Promise<AsaasPayment | null>;
  /** Boleto vivo (não deletado) com este externalReference — idempotência da ida pela fonte de verdade. */
  findPaymentByExternalRef(ref: string): Promise<AsaasPayment | null>;
  deletePayment(id: string): Promise<void>;
  /** `creditDateFrom` usa `estimatedCreditDate[ge]`: boleto pago numa quinta e creditado na terça
   *  sai da janela de `paymentDate` quando finalmente vira RECEIVED. */
  listPayments(f: { status?: string; paymentDateFrom?: string; creditDateFrom?: string; externalReference?: string }): AsyncIterable<AsaasPayment>;
  getWebhook(id: string): Promise<AsaasWebhook | null>;
  listWebhooks(): Promise<AsaasWebhook[]>;
  createWebhook(w: { name: string; url: string; email: string; authToken: string; events: string[] }): Promise<AsaasWebhook>;
  updateWebhook(id: string, patch: { interrupted?: boolean; enabled?: boolean }): Promise<AsaasWebhook>;
}

