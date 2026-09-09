// Normalização tolerante do payload do Asaas: campo desconhecido é ignorado, campo faltando vira null.
// Uma exceção aqui derrubaria a fila do Asaas (15 falhas) — por isso nunca lançamos por forma.
import { moneyOrNull, money } from "./money.js";
import type { AsaasPayment, AsaasWebhookEvent } from "./types.js";

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (typeof v === "object" && v !== null ? (v as Raw) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

export function normalizeAsaasPayment(raw: unknown): AsaasPayment | null {
  const r = obj(raw);
  const id = str(r.id);
  const value = r.value;
  if (!id || (typeof value !== "number" && typeof value !== "string")) return null;
  const numOrNull = (v: unknown) => (typeof v === "number" || typeof v === "string" ? moneyOrNull(v as number | string) : null);
  return {
    id,
    customer: str(r.customer) ?? "",
    status: str(r.status) ?? "UNKNOWN",
    billingType: str(r.billingType) ?? "UNKNOWN",
    value: money(value as number | string),
    netValue: numOrNull(r.netValue),
    originalValue: numOrNull(r.originalValue),
    interestValue: numOrNull(r.interestValue),
    dueDate: str(r.dueDate) ?? "",
    paymentDate: str(r.paymentDate),
    clientPaymentDate: str(r.clientPaymentDate),
    creditDate: str(r.creditDate),
    externalReference: str(r.externalReference),
    bankSlipUrl: str(r.bankSlipUrl),
    invoiceUrl: str(r.invoiceUrl),
    invoiceNumber: str(r.invoiceNumber),
    nossoNumero: str(r.nossoNumero),
    deleted: r.deleted === true,
  };
}

export function normalizeAsaasEvent(raw: unknown): AsaasWebhookEvent | null {
  const r = obj(raw);
  const id = str(r.id);
  const event = str(r.event);
  const payment = normalizeAsaasPayment(r.payment);
  if (!id || !event || !payment) return null;
  return { id, event, dateCreated: str(r.dateCreated) ?? "", payment };
}
