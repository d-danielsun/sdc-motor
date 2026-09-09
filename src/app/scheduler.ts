// Agendador em processo: é o que roda no container. No Supabase, o cron do próprio Supabase chama os mesmos jobs.
import type { Deps } from "../core/ports.js";
import { processAsaasEvents, processOdooEvents, reconcileDaily, syncInvoices, watchdog } from "../core/index.js";

export const JOBS = {
  "worker": (d: Deps) => Promise.all([processOdooEvents(d), processAsaasEvents(d)]),
  "sync-invoices": (d: Deps) => syncInvoices(d),
  "reconcile-daily": async (d: Deps) => ({ ...(await reconcileDaily(d)), auditPurged: await d.repo.audit.purgeOlderThan(90) }),
  "watchdog": (d: Deps) => watchdog(d),
} as const;
export type JobName = keyof typeof JOBS;

export function startScheduler(deps: Deps): () => void {
  const timers: NodeJS.Timeout[] = [];
  const run = async (name: JobName) => {
    try { const r = await JOBS[name](deps); deps.log(`job ${name}`, { result: r }); }
    catch (e) { deps.log(`job ${name} falhou`, { error: (e as Error).message }); }
  };
  timers.push(setInterval(() => run("worker"), 60_000));
  timers.push(setInterval(() => run("sync-invoices"), 15 * 60_000));
  timers.push(setInterval(() => run("watchdog"), 15 * 60_000));
  let lastDaily = "";
  timers.push(setInterval(() => {                       // 06:00 BRT = 09:00 UTC, uma vez por dia
    const now = new Date(), key = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === 9 && lastDaily !== key) { lastDaily = key; void run("reconcile-daily"); }
  }, 60_000));
  void run("worker");
  return () => timers.forEach(clearInterval);
}
