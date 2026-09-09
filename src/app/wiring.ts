// Monta as dependências reais a partir do ambiente. Único lugar que conhece env + adaptadores concretos.
import { AsaasHttpClient } from "../adapters/asaas/client.js";
import { systemClock } from "../adapters/clock.js";
import { createPool } from "../adapters/db/pool.js";
import { createPgRepo } from "../adapters/db/repo.js";
import { createConsoleQueries } from "../adapters/db/console.js";
import type { ConsoleQueries } from "../core/console.js";
import { OdooJson2Client } from "../adapters/odoo/client.js";
import type { Deps } from "../core/ports.js";

export interface Env { DATABASE_URL: string; ASAAS_URL: string; ASAAS_API_KEY: string; ASAAS_WEBHOOK_TOKEN: string; ODOO_URL: string; ODOO_DB: string; ODOO_API_KEY: string; ODOO_WEBHOOK_KEY: string; CONSOLE_TOKEN: string | null; PORT: number }

export function readEnv(e: NodeJS.ProcessEnv = process.env): Env {
  const req = (k: string) => { const v = e[k]; if (!v) throw new Error(`env ${k} ausente — o motor falha fechado`); return v; };
  return {
    DATABASE_URL: e.DATABASE_URL ?? "postgres://motor:motor@localhost:55432/motor",
    ASAAS_URL: e.ASAAS_URL ?? "https://api-sandbox.asaas.com/v3", ASAAS_API_KEY: req("ASAAS_API_KEY"), ASAAS_WEBHOOK_TOKEN: req("ASAAS_WEBHOOK_TOKEN"),
    ODOO_URL: e.ODOO_URL ?? "", ODOO_DB: e.ODOO_DB ?? "", ODOO_API_KEY: e.ODOO_API_KEY ?? "", ODOO_WEBHOOK_KEY: req("ODOO_WEBHOOK_KEY"),
    CONSOLE_TOKEN: e.CONSOLE_TOKEN && e.CONSOLE_TOKEN.length >= 32 ? e.CONSOLE_TOKEN : null,
    PORT: Number(e.PORT ?? 8787),
  };
}

export const jsonLog = (msg: string, ctx: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...ctx }));

export function buildDeps(env: Env): { deps: Deps; queries: ConsoleQueries; close: () => Promise<void> } {
  const pool = createPool(env.DATABASE_URL);
  const repo = createPgRepo(pool);
  const asaas = new AsaasHttpClient({ url: env.ASAAS_URL, apiKey: env.ASAAS_API_KEY, audit: repo.audit });
  const odoo = new OdooJson2Client({ url: env.ODOO_URL, db: env.ODOO_DB || null, apiKey: env.ODOO_API_KEY, audit: repo.audit });
  return { deps: { repo, odoo, asaas, clock: systemClock, log: jsonLog }, queries: createConsoleQueries(pool), close: () => pool.end() };
}
