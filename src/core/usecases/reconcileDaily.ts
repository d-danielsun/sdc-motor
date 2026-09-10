// Rede de segurança da volta: relê no Asaas tudo que foi RECEBIDO (inclusive "em dinheiro") na janela e baixa o que o
// webhook perdeu. Um pagamento com problema não derruba os outros; o resumo só é gravado como ok se a varredura completou.
import { OVERDUE_RECHECK_DAYS, RECONCILE_LOOKBACK_DAYS } from "../limits.js";
import type { Deps } from "../ports.js";
import { RECEIVED_STATUSES, receivePayment } from "../receive.js";
import { moveLineIdFromRef } from "../types.js";

export interface ReconcileSummary { at: string; ok: boolean; from: string; scanned: number; received: number; already: number; unmatched: number; divergent: number; needsReview: number; errors: number; overdueChecked: number }

export function daysAgo(today: string, days: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function reconcileDaily(deps: Deps, o: { lookbackDays?: number } = {}): Promise<ReconcileSummary> {
  const lookback = o.lookbackDays ?? (await deps.repo.config.get<number>("RECONCILE_LOOKBACK_DAYS")) ?? RECONCILE_LOOKBACK_DAYS;
  const today = deps.clock.today();
  const last = await deps.repo.config.get<{ ok?: boolean; at?: string; from?: string }>("RECONCILE_LAST");
  const anchor = last?.ok && last.at && last.at.slice(0, 10) < today ? last.at.slice(0, 10) : today;   // motor parado > janela: a janela cresce até o último sucesso
  const from = daysAgo(anchor, lookback);
  const s: ReconcileSummary = { at: deps.clock.now().toISOString(), ok: false, from, scanned: 0, received: 0, already: 0, unmatched: 0, divergent: 0, needsReview: 0, errors: 0, overdueChecked: 0 };
  for (const status of RECEIVED_STATUSES) {
    for await (const p of deps.asaas.listPayments({ status, paymentDateFrom: from })) {
      s.scanned++;
      if (moveLineIdFromRef(p.externalReference) === null) continue;   // cobrança que não é nossa
      try {
        const r = await receivePayment(deps, p, "reconcile");
        if (r === "received") s.received++;
        else if (r === "already") s.already++;
        else if (r === "unmatched") s.unmatched++;
        else if (r === "wizard_failed" || r === "needs_review" || r === "busy") s.needsReview++;
        else s.divergent++;
      } catch (e) {
        s.errors++;
        deps.log("reconcile: pagamento com erro", { asaasPaymentId: p.id, error: (e as Error).message });
      }
    }
  }
  // Passe guiado por cobrança: aberta e vencida há dias → pergunta ao Asaas (cobre webhook perdido fora da janela, data retroativa etc.)
  for (const c of await deps.repo.charges.listOpenDueBefore(daysAgo(today, OVERDUE_RECHECK_DAYS), 500)) {
    s.overdueChecked++;
    try {
      const p = c.asaasPaymentId ? await deps.asaas.getPayment(c.asaasPaymentId) : null;
      if (p && !p.deleted && (RECEIVED_STATUSES as readonly string[]).includes(p.status)) {
        const r = await receivePayment(deps, p, "reconcile");
        if (r === "received") s.received++; else if (r === "already") s.already++; else if (r === "wizard_failed" || r === "needs_review" || r === "busy") s.needsReview++; else s.divergent++;
      }
    } catch (e) { s.errors++; deps.log("reconcile: cobrança vencida com erro", { chargeId: c.id, error: (e as Error).message }); }
  }
  s.ok = true;
  await deps.repo.config.set("RECONCILE_LAST", s);
  deps.log("reconcile-daily", { ...s });
  return s;
}
