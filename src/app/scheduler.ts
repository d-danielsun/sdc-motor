// Agendador em processo: é o que roda no container. No Supabase, o cron do próprio Supabase chama os mesmos jobs.
// Um job nunca sobrepõe a si mesmo; o diário roda uma vez por dia civil (persistido em RECONCILE_LAST, sobrevive a restart).
import type { Deps } from "../core/ports.js";
import { AUDIT_RETENTION_DAYS, EVENT_RETENTION_DAYS } from "../core/limits.js";
import { processAsaasEvents, processOdooEvents, reconcileDaily, syncInvoices, watchdog } from "../core/index.js";
import { alertaJobFalhou, alertar } from "../core/usecases/notify.js";
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

/** Extras que o núcleo não conhece. A limpeza de sessão do console é SQL de adaptador, então
 *  entra por aqui em vez de virar porta no `Deps`. */
export interface JobExtras { purgarSessoes?: (agora: Date) => Promise<number> }

/** Roda um job; falha vira exceção `integration_error` visível no console (uma aberta por vez), não só log. */
export async function runJob(deps: Deps, name: JobName, extras: JobExtras = {}): Promise<unknown> {
  try {
    const base = await JOBS[name](deps);
    // Sessão expirada é lixo com risco: fica no banco podendo ser resolvida se o relógio
    // voltar. Sai no mesmo diário que já limpa audit_log e eventos.
    const r = name === "reconcile-daily" && extras.purgarSessoes
      ? { ...(base as object), purged: { ...((base as { purged?: object }).purged ?? {}), sessions: await extras.purgarSessoes(deps.clock.now()) } }
      : base;
    // Sucesso FECHA a exceção que a falha anterior abriu. Sem isto, `integration_error` de um job
    // que já voltou fica aberta para sempre — e o alerta de exceção travada (>30 min) manda e-mail
    // dizendo que o job "está falhando" sobre um job que está rodando. Histórico não encerrado
    // virava afirmação sobre o presente. Achado do review adversarial do Codex.
    const fechadas = await deps.repo.exceptions.resolverPorRef(`jobs:${name}`, "motor").catch(() => 0);
    deps.log(`job ${name}`, { result: r, ...(fechadas > 0 ? { excecoesFechadas: fechadas } : {}) });
    return r;
  } catch (e) {
    const error = (e as Error).message;
    deps.log(`job ${name} falhou`, { error });
    try {
      // `jobs:<nome>` e não `jobs`: com a ref genérica, os quatro jobs dividiam UMA exceção, e o
      // e-mail de um job levava para a exceção que descrevia o erro de outro.
      const exc = await deps.repo.exceptions.openOnce({ type: "integration_error", refTable: `jobs:${name}`, detail: { job: name, error, at: deps.clock.now().toISOString() } });
      // O quarto alerta. Um job que falha de forma permanente (chave vencida, base expirada)
      // para uma parte do ciclo em silêncio — este e-mail é o que quebra o silêncio.
      const consoleUrl = await deps.repo.config.get<string | null>("CONSOLE_PUBLIC_URL").catch(() => null);
      await alertar(deps, alertaJobFalhou({ job: name, error, excecaoId: exc.id }), { consoleUrl });
    } catch (e2) { deps.log("não consegui registrar a exceção do job", { error: (e2 as Error).message }); }
    return null;
  }
}

export const DAILY_HOUR_UTC = 9;   // 06:00 BRT

/** Um job nunca sobrepõe a si mesmo — vale pro scheduler em processo E pro POST /api/v1/jobs/:name (cron do Supabase). */
export interface JobRunner { run(name: JobName): Promise<unknown>; inFlight(): JobName[]; isJob(name: string): name is JobName }
export function createJobRunner(deps: Deps, extras: JobExtras = {}): JobRunner {
  const running = new Map<JobName, Promise<unknown>>();
  return {
    run(name) {
      const current = running.get(name);
      if (current) return current;
      const p = runJob(deps, name, extras).finally(() => running.delete(name));
      running.set(name, p);
      return p;
    },
    inFlight: () => [...running.keys()],
    isJob: (name): name is JobName => name in JOBS,
  };
}

export interface Scheduler { stop(): Promise<void>; tick(): Promise<void>; inFlight(): JobName[] }

export function startScheduler(deps: Deps, o: { setInterval?: typeof setInterval; clearInterval?: typeof clearInterval; runner?: JobRunner } = {}): Scheduler {
  const si = o.setInterval ?? setInterval, ci = o.clearInterval ?? clearInterval;
  const runner = o.runner ?? createJobRunner(deps);
  const run = (name: JobName) => runner.run(name);
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
    inFlight: () => runner.inFlight(),
    stop: async () => { timers.forEach(ci); while (runner.inFlight().length) await new Promise((r) => setTimeout(r, 200)); },   // deploy espera o que está no meio
  };
}
