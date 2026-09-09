// Read model do console: o que a UI mostra. Escrita passa pelos casos de uso em usecases/console.ts.
import type { ChargeStatus, ExceptionType, Money } from "./types.js";

export interface ExceptionRow {
  id: number; type: ExceptionType; status: "open" | "resolved" | "ignored"; refTable: string | null; refId: number | null;
  detail: unknown; createdAt: string; resolvedBy: string | null; resolvedAt: string | null;
  charge: { id: number; invoiceName: string | null; amount: Money; dueDate: string; status: ChargeStatus; customerName: string | null } | null;
}
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
export interface HealthReport {
  idaEnabled: boolean; openCharges: number; openExceptionsByType: Record<string, number>;
  lastAsaasEventAt: string | null; lastOdooEventAt: string | null; lastSync: unknown; lastReconcile: unknown; lastWatchdog: unknown;
  webhook: { id: string | null; interrupted: boolean | null; penalizedRequestsCount: number | null };
  odooApiKeyAgeDays: number | null;
}

export interface ConsoleQueries {
  exceptions(f: ExceptionFilter): Promise<Page<ExceptionRow>>;
  exception(id: number): Promise<ExceptionRow | null>;
  charges(f: ChargeFilter): Promise<Page<ChargeRow>>;
  charge(id: number): Promise<(ChargeRow & { reconciliations: unknown[]; exceptions: ExceptionRow[]; events: unknown[] }) | null>;
  aging(today: string): Promise<AgingBucket[]>;
  lastOdooEventAt(): Promise<string | null>;
}

/** Chaves de config que o console pode alterar (gates R1/R2 e defaults até Q3/Q6). */
export const CONSOLE_CONFIG_KEYS = ["IDA_ENABLED", "TOLERANCE_BRL", "GO_LIVE_CUTOFF_DATE", "JUROS_MULTA_AUTO"] as const;
export type ConsoleConfigKey = (typeof CONSOLE_CONFIG_KEYS)[number];
