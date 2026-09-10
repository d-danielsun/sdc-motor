// Normalização tolerante do payload do Asaas: campo desconhecido é ignorado, campo faltando vira null,
// valor inválido vira null. NUNCA lança — uma exceção aqui derrubaria a fila do Asaas (15 falhas).
import { ASAAS_ID_RE } from "./limits.js";
import { safeMoney } from "./money.js";
import type { AsaasPayment, AsaasWebhookEvent } from "./types.js";

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Raw) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
/** ids do Asaas entram em paths de API — só o charset conhecido passa. */
export const asaasId = (v: unknown): string | null => { const s = str(v); return s && ASAAS_ID_RE.test(s) ? s : null; };

export function normalizeAsaasPayment(raw: unknown): AsaasPayment | null {
  const r = obj(raw);
  const id = asaasId(r.id);
  const value = safeMoney(r.value);
  if (!id || value === null) return null;
  return {
    id,
    customer: asaasId(r.customer) ?? "",
    status: str(r.status) ?? "UNKNOWN",
    billingType: str(r.billingType) ?? "UNKNOWN",
    value,
    netValue: safeMoney(r.netValue),
    originalValue: safeMoney(r.originalValue),
    interestValue: safeMoney(r.interestValue),
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
  const id = asaasId(r.id);
  const event = str(r.event);
  const payment = normalizeAsaasPayment(r.payment);
  if (!id || !event || !payment) return null;
  return { id, event, dateCreated: str(r.dateCreated) ?? "", payment };
}
