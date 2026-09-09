// Rede de segurança da volta: relê no Asaas tudo que foi RECEBIDO nos últimos 3 dias e baixa o que o webhook perdeu.
import type { Deps } from "../ports.js";
import { receivePayment } from "../receive.js";
import { moveLineIdFromRef } from "../types.js";

export interface ReconcileSummary { scanned: number; received: number; already: number; unmatched: number; divergent: number }

export function daysAgo(today: string, days: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function reconcileDaily(deps: Deps, o: { lookbackDays?: number } = {}): Promise<ReconcileSummary> {
  const s: ReconcileSummary = { scanned: 0, received: 0, already: 0, unmatched: 0, divergent: 0 };
  const from = daysAgo(deps.clock.today(), o.lookbackDays ?? 3);
  for await (const p of deps.asaas.listPayments({ status: "RECEIVED", paymentDateFrom: from })) {
    s.scanned++;
    if (moveLineIdFromRef(p.externalReference) === null) continue; // cobrança que não é nossa
    const r = await receivePayment(deps, p, "reconcile");
    if (r === "received") s.received++;
    else if (r === "already") s.already++;
    else if (r === "unmatched") s.unmatched++;
    else s.divergent++;
  }
  await deps.repo.config.set("RECONCILE_LAST", { at: deps.clock.now().toISOString(), from, ...s });
  deps.log("reconcile-daily", { from, ...s });
  return s;
}
