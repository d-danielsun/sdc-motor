import type { Money } from "./money.js";
export type { Money };

export type ChargeStatus =
  | "pending" | "created" | "confirmed" | "received" | "settled" | "cancelled" | "refunded" | "exception";
export type ProcessStatus = "pending" | "processing" | "done" | "error" | "ignored";
export type ExceptionType =
  | "customer_missing_document" | "charge_create_failed" | "payment_unmatched" | "amount_divergent"
  | "reversal_pending" | "queue_interrupted" | "stale_heartbeat" | "api_key_expiring"
  | "writeoff_needed" | "webhook_penalized" | "integration_error";
export type DiffPolicy = "juros_multa" | "in_cash" | "writeoff_financeiro" | "exception" | "ja_baixada_no_odoo";
export type AuditDirection = "odoo_out" | "asaas_out" | "asaas_in" | "odoo_in" | "console";

// ── Odoo (o que o motor precisa saber de uma fatura) ─────────────────────────
export interface OdooInvoice {
  id: number;
  name: string;
  partnerId: number;
  invoiceDate: string | null;   // YYYY-MM-DD
  dueDate: string | null;
  amountResidual: Money;
  state: "draft" | "posted" | "cancel";
  paymentState: string;         // not_paid | partial | paid | in_payment | reversed | invoicing_legacy
  moveType: string;             // out_invoice | out_refund | ...
  writeDate: string;            // ISO
}
export interface OdooInvoiceLine {
  id: number;
  moveId: number;
  dateMaturity: string;         // YYYY-MM-DD
  amountResidual: Money;
  reconciled: boolean;
}
export interface OdooPartner {
  id: number;
  name: string;
  vat: string | null;
  email: string | null;
  phone: string | null;
}
export interface OdooPaymentResult {
  paymentId: number | null;
  paymentState: string | null;
}

// ── Asaas ────────────────────────────────────────────────────────────────────
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

// ── Estado do motor ──────────────────────────────────────────────────────────
export interface Charge {
  id: number;
  odooMoveId: number;
  odooMoveLineId: number;
  odooPartnerId: number;
  asaasPaymentId: string | null;
  externalRef: string;
  amount: Money;
  dueDate: string;
  status: ChargeStatus;
  bankSlipUrl: string | null;
  invoiceName: string | null;
  nossoNumero: string | null;
  asaasInvoiceNumber: string | null;
}
export interface CustomerMap {
  id: number;
  odooPartnerId: number;
  asaasCustomerId: string | null;
  cpfCnpj: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  syncStatus: "pending" | "synced" | "error" | "blocked_no_document";
  lastError: string | null;
}
export interface StoredAsaasEvent {
  id: number;
  asaasEventId: string;
  eventType: string;
  asaasPaymentId: string | null;
  payload: unknown;
  attempts: number;
}
export interface StoredOdooEvent {
  id: number;
  odooModel: string;
  odooId: number;
  odooAction: string | null;
  attempts: number;
}

export const externalRefForLine = (moveLineId: number): string => `odoo:move_line:${moveLineId}`;
export const externalRefForPartner = (partnerId: number): string => `odoo:partner:${partnerId}`;
export const moveLineIdFromRef = (ref: string | null): number | null => {
  const m = ref?.match(/^odoo:move_line:(\d+)$/);
  return m ? Number(m[1]) : null;
};
