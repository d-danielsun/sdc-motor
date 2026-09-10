// Monta as dependências reais a partir do ambiente. Único lugar que conhece env + adaptadores concretos.
import { AsaasHttpClient } from "../adapters/asaas/client.js";
import { systemClock } from "../adapters/clock.js";
import { createConsoleQueries } from "../adapters/db/console.js";
import { DEFAULT_DATABASE_URL, createLockPool, createPool } from "../adapters/db/pool.js";
import { createPgRepo } from "../adapters/db/repo.js";
import { OdooJson2Client } from "../adapters/odoo/client.js";
import type { ConsoleQueries } from "../core/console.js";
import type { Deps } from "../core/ports.js";

export const DEFAULT_ASAAS_URL = "https://api-sandbox.asaas.com/v3";
export const MIN_SECRET_LENGTH = 32;
export interface Env { DATABASE_URL: string; ASAAS_URL: string; ASAAS_API_KEY: string; ASAAS_WEBHOOK_TOKEN: string; ODOO_URL: string; ODOO_DB: string; ODOO_API_KEY: string; ODOO_WEBHOOK_KEY: string; CONSOLE_TOKEN: string | null; PORT: number; warnings: string[] }

export function readEnv(e: NodeJS.ProcessEnv = process.env): Env {
  const req = (k: string) => { const v = e[k]; if (!v) throw new Error(`env ${k} ausente — o motor falha fechado`); return v; };
  const secret = (k: string) => { const v = req(k); if (v.length < MIN_SECRET_LENGTH) throw new Error(`env ${k} precisa de ≥${MIN_SECRET_LENGTH} caracteres`); return v; };
  const warnings: string[] = [];
  if (e.CONSOLE_TOKEN && e.CONSOLE_TOKEN.length < MIN_SECRET_LENGTH) warnings.push(`CONSOLE_TOKEN tem menos de ${MIN_SECRET_LENGTH} caracteres — console DESABILITADO`);
  if (!e.ODOO_URL || !e.ODOO_API_KEY) warnings.push("ODOO_URL/ODOO_API_KEY ausentes — toda chamada ao Odoo vai falhar (ok só até o acesso chegar)");
  // DATABASE_URL ou PG* (senha com @ / # % não quebra a URL). Advisory locks exigem conexão de SESSÃO: pooler em modo transação (Supabase :6543) não serve.
  const databaseUrl = e.DATABASE_URL ?? (e.PGHOST ? `postgres://${encodeURIComponent(e.PGUSER ?? "motor")}:${encodeURIComponent(e.PGPASSWORD ?? "")}@${e.PGHOST}:${e.PGPORT ?? "5432"}/${e.PGDATABASE ?? "motor"}` : DEFAULT_DATABASE_URL);
  if (/:6543\b|pgbouncer=true/.test(databaseUrl)) warnings.push("DATABASE_URL parece pooler em modo transação (:6543) — os advisory locks quebram; use a conexão direta/sessão (:5432)");
  return {
    DATABASE_URL: databaseUrl,
    ASAAS_URL: e.ASAAS_URL ?? DEFAULT_ASAAS_URL, ASAAS_API_KEY: req("ASAAS_API_KEY"), ASAAS_WEBHOOK_TOKEN: secret("ASAAS_WEBHOOK_TOKEN"),
    ODOO_URL: (e.ODOO_URL ?? "").replace(/\/+$/, ""), ODOO_DB: e.ODOO_DB ?? "", ODOO_API_KEY: e.ODOO_API_KEY ?? "", ODOO_WEBHOOK_KEY: secret("ODOO_WEBHOOK_KEY"),
    CONSOLE_TOKEN: e.CONSOLE_TOKEN && e.CONSOLE_TOKEN.length >= MIN_SECRET_LENGTH ? e.CONSOLE_TOKEN : null,
    PORT: Number(e.PORT ?? 8787), warnings,
  };
}

export const jsonLog = (msg: string, ctx: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...ctx }));

export function buildDeps(env: Env): { deps: Deps; queries: ConsoleQueries; pool: ReturnType<typeof createPool>; close: () => Promise<void> } {
  const pool = createPool(env.DATABASE_URL);
  const repo = createPgRepo(pool, createLockPool(env.DATABASE_URL));
  const asaas = new AsaasHttpClient({ url: env.ASAAS_URL, apiKey: env.ASAAS_API_KEY, audit: repo.audit });
  const odoo = new OdooJson2Client({ url: env.ODOO_URL, db: env.ODOO_DB || null, apiKey: env.ODOO_API_KEY, audit: repo.audit });
  return { deps: { repo, odoo, asaas, clock: systemClock, log: jsonLog }, queries: createConsoleQueries(pool), pool, close: () => pool.end() };
}
