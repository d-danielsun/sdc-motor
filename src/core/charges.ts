import type { ChargeStatus } from "./types.js";

// Transições que o motor executa. 'settled' | 'refunded' | 'exception' existem no schema pra uso manual/futuro,
// mas nenhum código as grava (estorno é ação assistida no console — PRD §3.3).
const NEXT: Record<ChargeStatus, ReadonlySet<ChargeStatus>> = {
  pending:   new Set(["created"]),
  created:   new Set(["confirmed", "received", "cancelled"]),
  confirmed: new Set(["received", "cancelled"]),
  received:  new Set([]),
  settled:   new Set([]),
  cancelled: new Set(["created"]),          // PAYMENT_RESTORED
  refunded:  new Set([]),
  exception: new Set([]),
};

export const canTransition = (from: ChargeStatus, to: ChargeStatus): boolean => NEXT[from].has(to);
/** De onde se pode ir para `to` — usado nas transições atômicas (`WHERE status = any(...)`). */
export const fromStatesFor = (to: ChargeStatus): ChargeStatus[] => (Object.keys(NEXT) as ChargeStatus[]).filter((s) => NEXT[s].has(to));
export const OPEN_STATUSES: ReadonlyArray<ChargeStatus> = ["created", "confirmed"];
