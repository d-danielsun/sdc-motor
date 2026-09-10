// Agendador em processo: é o que roda no container. No Supabase, o cron do próprio Supabase chama os mesmos jobs.
// Um job nunca sobrepõe a si mesmo; o diário roda uma vez por dia civil (persistido em RECONCILE_LAST, sobrevive a restart).
import type { Deps } from "../core/ports.js";
import { AUDIT_RETENTION_DAYS, EVENT_RETENTION_DAYS } from "../core/limits.js";
import { processAsaasEvents, processOdooEvents, reconcileDaily, syncInvoices, watchdog } from "../core/index.js";
import type { JobSummary } from "../core/console.js";

export const JOBS = {
  "worker": async (d: Deps) => ({ odoo: await processOdooEvents(d), asaas: await processAsaasEvents(d) }),
  "sync-invoices": (d: Deps) => syncInvoices(d),
  "reconcile-daily": async (d: Deps) => ({
    ...(await reconcileDaily(d)),
    purged: { audit: await d.repo.audit.purgeOlderThan(AUDIT_RETENTION_DAYS), asaasEvents: await d.repo.asaasEvents.purgeProcessedOlderThan(EVENT_RETENTION_DAYS), odooEvents: await d.repo.odooEvents.purgeProcessedOlderThan(EVENT_RETENTION_DAYS) },
  }),
  "watchdog": (d: Deps) => watchdog(d),
} as const;
export type JobName = keyof typeof JOBS;

/** Roda um job; falha vira exceção `integration_error` visível no console (uma aberta por vez), não só log. */
export async function runJob(deps: Deps, name: JobName): Promise<unknown> {
  try {
    const r = await JOBS[name](deps);
    deps.log(`job ${name}`, { result: r });
    return r;
  } catch (e) {
    const error = (e as Error).message;
    deps.log(`job ${name} falhou`, { error });
    try {
      await deps.repo.exceptions.openOnce({ type: "integration_error", refTable: "jobs", detail: { job: name, error, at: deps.clock.now().toISOString() } });
    } catch (e2) { deps.log("não consegui registrar a exceção do job", { error: (e2 as Error).message }); }
    return null;
  }
}

export const DAILY_HOUR_UTC = 9;   // 06:00 BRT

export interface Scheduler { stop(): Promise<void>; tick(): Promise<void>; inFlight(): JobName[] }

export function startScheduler(deps: Deps, o: { setInterval?: typeof setInterval; clearInterval?: typeof clearInterval } = {}): Scheduler {
  const si = o.setInterval ?? setInterval, ci = o.clearInterval ?? clearInterval;
  const running = new Map<JobName, Promise<unknown>>();
  const run = (name: JobName): Promise<unknown> => {
    const current = running.get(name);
    if (current) return current;   // ainda rodando: não sobrepõe (review 09/09)
    const p = runJob(deps, name).finally(() => running.delete(name));
    running.set(name, p);
    return p;
  };
  const dailyDue = async (): Promise<boolean> => {
    const now = deps.clock.now();
    if (now.getUTCHours() < DAILY_HOUR_UTC) return false;
    const last = await deps.repo.config.get<JobSummary>("RECONCILE_LAST").catch(() => null);
    return !last?.ok || String(last.at).slice(0, 10) !== now.toISOString().slice(0, 10);
  };
  const tick = async () => { if (await dailyDue()) await run("reconcile-daily"); };
  const timers = [
    si(() => void run("worker"), 60_000),
    si(() => void run("sync-invoices"), 15 * 60_000),
    si(() => void run("watchdog"), 15 * 60_000),
    si(() => void tick(), 60_000),
  ];
  void run("worker");
  return {
    tick,
    inFlight: () => [...running.keys()],
    stop: async () => { timers.forEach(ci); await Promise.allSettled([...running.values()]); },   // deploy espera o que está no meio
  };
}
