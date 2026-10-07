// Porta neutra do gateway de cobrança. O núcleo fala só com isto; Asaas e Itaú são adaptadores.
//
// Vocabulário: os códigos de status (`PENDING`, `CONFIRMED`, `RECEIVED`, `RECEIVED_IN_CASH`, …) foram
// herdados do primeiro adaptador e viraram o vocabulário NEUTRO da porta — trocá-los agora mudaria
// regra de dinheiro sem ganho. Um adaptador novo (Itaú) traduz o status do banco para este conjunto.
import type { Money } from "./money.js";

/** Status neutro de uma cobrança no gateway. Adaptador que recebe algo fora disto devolve o código cru. */
export type GatewayChargeStatus =
  | "PENDING" | "CONFIRMED" | "RECEIVED" | "RECEIVED_IN_CASH" | "OVERDUE" | "REFUNDED" | "UNKNOWN";

/** Status que contam como dinheiro recebido — os únicos que podem virar baixa. */
export const RECEIVED_STATUSES = ["RECEIVED", "RECEIVED_IN_CASH"] as const;
export const isReceivedStatus = (s: string): boolean => (RECEIVED_STATUSES as readonly string[]).includes(s);

export interface GatewayCustomer {
  id: string;
  name: string;
  cpfCnpj: string | null;
  email: string | null;
  externalReference: string | null;
  notificationDisabled: boolean;
}

/** Cobrança como o gateway a vê agora (objeto vivo, nunca o payload de um aviso). */
export interface GatewayCharge {
  id: string;
  customer: string;
  status: string;               // GatewayChargeStatus (string para não perder código desconhecido)
  billingType: string;
  value: Money;
  netValue: Money | null;
  originalValue: Money | null;  // preenchido quando value inclui juros/multa
  interestValue: Money | null;
  dueDate: string;
  paymentDate: string | null;
  clientPaymentDate: string | null;
  creditDate: string | null;
  /** Previsão de crédito: segundo passe do reconcile (boleto pago numa quinta, creditado na terça). */
  estimatedCreditDate: string | null;
  externalReference: string | null;
  bankSlipUrl: string | null;
  invoiceUrl: string | null;
  invoiceNumber: string | null;
  nossoNumero: string | null;
  deleted: boolean;
}

/** Tipo normalizado de um aviso do gateway. O adaptador traduz o nome do evento dele para isto. */
export type SettlementEventKind =
  | "confirmed" | "received" | "updated" | "deleted" | "slip_cancelled" | "restored" | "reversal" | "overdue" | "other";

/** Aviso de liquidação/mudança normalizado. É GATILHO, não verdade: o núcleo sempre relê a cobrança viva. */
export interface SettlementEvent {
  eventId: string;
  kind: SettlementEventKind;
  /** Nome cru do evento no gateway — vai para o detalhe das exceções. */
  rawType: string;
  gatewayChargeId: string;
  externalReference: string | null;
  status: string;
  grossValue: Money;
  netValue: Money | null;
  paymentDate: string | null;
  creditDate: string | null;
}

/** Fila de avisos do gateway (ex.: webhook que o provedor interrompe depois de N falhas). */
export interface GatewayEventQueue {
  id: string;
  enabled: boolean;
  interrupted: boolean;
  penalizedRequestsCount: number;
}

export interface ChargeGateway {
  /** Prefixo do memo de baixa no Odoo: `<name>:<id da cobrança>` (Asaas: `asaas:<pay_id>`, formato existente). */
  readonly name: string;

  findCustomerByExternalRef(ref: string): Promise<GatewayCustomer | null>;
  /** Cliente que já existia no gateway sem a nossa referência: adotar em vez de duplicar. */
  findCustomerByDocument(cpfCnpj: string): Promise<GatewayCustomer | null>;
  createCustomer(c: {
    name: string; cpfCnpj: string; email?: string | null; phone?: string | null;
    externalReference: string; notificationDisabled: boolean;
  }): Promise<GatewayCustomer>;
  updateCustomer(id: string, patch: { notificationDisabled?: boolean }): Promise<GatewayCustomer>;

  createCharge(p: { customer: string; value: Money; dueDate: string; externalReference: string; description: string }): Promise<GatewayCharge>;
  getCharge(id: string): Promise<GatewayCharge | null>;
  /** Cobrança viva (não cancelada) com este externalReference — idempotência da ida pela fonte de verdade. */
  findChargeByExternalRef(ref: string): Promise<GatewayCharge | null>;
  cancelCharge(id: string): Promise<void>;
  /** Cobranças por status e janela (`paymentDateFrom` = pagamento; `creditDateFrom` = previsão de crédito). */
  listCharges(f: { status?: string; paymentDateFrom?: string; creditDateFrom?: string; externalReference?: string }): AsyncIterable<GatewayCharge>;

  /** Traduz o payload GUARDADO de um aviso. Nunca lança: payload estranho → null (ignorado). */
  parseSettlementEvent(payload: unknown): SettlementEvent | null;
  getEventQueue(id: string): Promise<GatewayEventQueue | null>;
  /** Pede ao gateway para retomar a fila de avisos interrompida. */
  resumeEventQueue(id: string): Promise<void>;
}

/** Operação que o gateway ainda não suporta porque depende de informação que o banco não deu. */
export class GatewayNotReady extends Error {
  readonly code = "gateway_not_ready";
  constructor(motivo: string) { super(motivo); this.name = "GatewayNotReady"; }
}
