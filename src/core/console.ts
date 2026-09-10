// Read model do console: o que a UI mostra. Escrita passa pelos casos de uso em usecases/console.ts.
import type { ChargeStatus, ExceptionType, Money } from "./types.js";

export interface ExceptionRow {
  id: number; type: ExceptionType; status: "open" | "resolved" | "ignored"; refTable: string | null; refId: number | null;
  detail: unknown; createdAt: string; resolvedBy: string | null; resolvedAt: string | null;
  charge: { id: number; invoiceName: string | null; amount: Money; dueDate: string; status: ChargeStatus; customerName: string | null } | null;
}
export interface ReconciliationRow { id: number; odooPaymentId: number | null; amountReceived: Money; amountExpected: Money; netValue: Money | null; diff: Money; diffPolicy: string | null; paymentDate: string | null; creditDate: string | null; createdAt: string }
export interface EventRow { id: number; asaasEventId: string; eventType: string; processStatus: string; receivedAt: string; processedAt: string | null; attempts: number; error: string | null }
export interface ChargeRow {
  id: number; invoiceName: string | null; odooMoveId: number; odooMoveLineId: number; status: ChargeStatus; amount: Money; dueDate: string;
  asaasPaymentId: string | null; bankSlipUrl: string | null; nossoNumero: string | null; asaasInvoiceNumber: string | null;
  customer: { odooPartnerId: number; name: string | null; cpfCnpj: string | null; asaasCustomerId: string | null };
  received: { amountReceived: Money; paymentDate: string | null; diffPolicy: string | null; odooPaymentId: number | null } | null;
  openExceptions: number; createdAt: string; updatedAt: string;
}
export interface Page<T> { data: T[]; total: number; limit: number; offset: number }
export interface ChargeFilter { status?: ChargeStatus[]; dueFrom?: string; dueTo?: string; partnerId?: number; q?: string; limit?: number; offset?: number }
export interface ExceptionFilter { status?: "open" | "resolved" | "ignored"; type?: ExceptionType; limit?: number; offset?: number }
export interface AgingBucket { bucket: "a_vencer" | "1_7" | "8_30" | "31_mais"; count: number; amount: Money }
export interface JobSummary { at: string; ok: boolean; [k: string]: unknown }
export interface HealthReport {
  idaEnabled: boolean; notificationsEnabled: boolean; openCharges: number; openExceptionsByType: Record<string, number>;
  lastAsaasEventAt: string | null; lastOdooEventAt: string | null; lastSync: JobSummary | null; lastReconcile: JobSummary | null; lastWatchdog: JobSummary | null;
  webhook: { id: string | null; interrupted: boolean | null; penalizedRequestsCount: number | null };
  odooApiKeyAgeDays: number | null;
}

export interface ConsoleQueries {
  exceptions(f: ExceptionFilter): Promise<Page<ExceptionRow>>;
  exception(id: number): Promise<ExceptionRow | null>;
  charges(f: ChargeFilter): Promise<Page<ChargeRow>>;
  charge(id: number): Promise<(ChargeRow & { reconciliations: ReconciliationRow[]; exceptions: ExceptionRow[]; events: EventRow[] }) | null>;
  aging(today: string): Promise<AgingBucket[]>;
  lastOdooEventAt(): Promise<string | null>;
}

/** Registro único das chaves de app_config (o teste reseta a partir daqui). */
export const CONFIG_KEYS = {
  IDA_ENABLED: false, TOLERANCE_BRL: "0.01", GO_LIVE_CUTOFF_DATE: null, JUROS_MULTA_AUTO: false, NOTIFICATIONS_ENABLED: false,
  ASAAS_WEBHOOK_ID: null, ASAAS_PENALIZED_LAST: 0, ASAAS_REACTIVATED_AT: null, ODOO_API_KEY_CREATED_AT: null,
  RECONCILE_LOOKBACK_DAYS: 3, SWEEP_FAILURES: {}, SYNC_LAST: null, RECONCILE_LAST: null, WATCHDOG_LAST: null,
  // Endereço público do motor, usado para montar o link do console no e-mail de alerta. Vem do
  // env no boot (CONSOLE_PUBLIC_URL) e mora aqui porque o núcleo não lê env.
  CONSOLE_PUBLIC_URL: null,
} as const satisfies Record<string, unknown>;
export type ConfigKey = keyof typeof CONFIG_KEYS;
/** Chaves que o console pode alterar (gates R1/R3 e defaults até Q3/Q6). */
export const CONSOLE_CONFIG_KEYS = ["IDA_ENABLED", "TOLERANCE_BRL", "GO_LIVE_CUTOFF_DATE", "JUROS_MULTA_AUTO", "RECONCILE_LOOKBACK_DAYS"] as const;
export type ConsoleConfigKey = (typeof CONSOLE_CONFIG_KEYS)[number];

export type ErrorCode = "not_found" | "invalid_state" | "invalid_input" | "upstream" | "config" | "busy";
export type ActionResult = { ok: true; action: string; detail?: unknown } | { ok: false; code: ErrorCode; error: string };
export const fail = (code: ErrorCode, error: string): ActionResult => ({ ok: false, code, error });
