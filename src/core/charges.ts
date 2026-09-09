import type { ChargeStatus } from "./types.js";

// Transições permitidas da cobrança. Tudo fora daqui é ignorado (idempotência) ou vira exceção.
const NEXT: Record<ChargeStatus, ReadonlySet<ChargeStatus>> = {
  pending:   new Set(["created", "exception"]),
  created:   new Set(["confirmed", "received", "cancelled", "exception"]),
  confirmed: new Set(["received", "cancelled", "exception"]),
  received:  new Set(["settled", "refunded", "exception"]),
  settled:   new Set(["refunded", "exception"]),
  cancelled: new Set(["created"]),          // PAYMENT_RESTORED
  refunded:  new Set([]),
  exception: new Set(["created", "confirmed", "received", "cancelled"]), // "reprocessar" no console
};

export const canTransition = (from: ChargeStatus, to: ChargeStatus): boolean => NEXT[from].has(to);
export const OPEN_STATUSES: ReadonlyArray<ChargeStatus> = ["created", "confirmed"];
