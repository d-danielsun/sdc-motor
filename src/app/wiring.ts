// Monta as dependências reais a partir do ambiente. Único lugar que conhece env + adaptadores concretos.
import { AsaasHttpClient } from "../adapters/asaas/client.js";
import { AsaasGateway } from "../adapters/asaas/gateway.js";
import { ItauClient, readItauConfig, type ItauConfig } from "../adapters/itau/config.js";
import { ItauGateway } from "../adapters/itau/gateway.js";
import { systemClock } from "../adapters/clock.js";
import { createConsoleQueries } from "../adapters/db/console.js";
import { DEFAULT_DATABASE_URL, createLockPool, createPool } from "../adapters/db/pool.js";
import { createPgRepo } from "../adapters/db/repo.js";
import { createNoopNotifier, createResendNotifier, parseDestinatarios } from "../adapters/notify/resend.js";
import { OdooJson2Client } from "../adapters/odoo/client.js";
import type { ConsoleQueries } from "../core/console.js";
import type { ChargeGateway } from "../core/gateway.js";
import type { Deps, Notifier, Repo } from "../core/ports.js";

export const DEFAULT_ASAAS_URL = "https://api-sandbox.asaas.com/v3";
export const MIN_SECRET_LENGTH = 32;
export const GATEWAYS = ["asaas", "itau"] as const;
export type GatewayName = (typeof GATEWAYS)[number];
export interface Env {
  /** Gateway de cobrança (default asaas). itau = só auth/certificado; cobrança lança GatewayNotReady. */
  GATEWAY: GatewayName; ITAU: ItauConfig | null;
  DATABASE_URL: string; ASAAS_URL: string; ASAAS_API_KEY: string; ASAAS_WEBHOOK_TOKEN: string;
  ODOO_URL: string; ODOO_DB: string; ODOO_API_KEY: string; ODOO_WEBHOOK_KEY: string;
  CONSOLE_TOKEN: string | null; PORT: number; TRUSTED_PROXIES: number;
  RESEND_API_KEY: string | null; ALERT_FROM: string | null; ALERT_EMAIL: string[]; CONSOLE_PUBLIC_URL: string | null;
  /** Data (YYYY-MM-DD ou ISO) em que a chave do Odoo foi criada. Sem ela, o alerta de chave
   *  vencendo NUNCA dispara — era o furo que o verificador da #14 achou. */
  ODOO_API_KEY_CREATED_AT: string | null;
  warnings: string[];
}

export function readEnv(e: NodeJS.ProcessEnv = process.env): Env {
  const req = (k: string) => { const v = e[k]; if (!v) throw new Error(`env ${k} ausente — o motor falha fechado`); return v; };
  const secret = (k: string) => { const v = req(k); if (v.length < MIN_SECRET_LENGTH) throw new Error(`env ${k} precisa de ≥${MIN_SECRET_LENGTH} caracteres`); return v; };
  const warnings: string[] = [];
  const gateway = (e.GATEWAY || "asaas").trim().toLowerCase();
  if (!(GATEWAYS as readonly string[]).includes(gateway)) throw new Error(`env GATEWAY inválido (${gateway}) — use ${GATEWAYS.join("|")}`);
  if (gateway === "itau") {
    // A ida mora em app_config (o boot confere lá também); quem a ligou também por env leva recusa aqui.
    const idaPorEnv = (e.IDA_ENABLED ?? "").trim().toLowerCase();
    if (idaPorEnv !== "" && idaPorEnv !== "false" && idaPorEnv !== "0") throw new Error("GATEWAY=itau não emite cobrança ainda (aguardando Cobrança V2) — desligue a ida (IDA_ENABLED) para subir");
    warnings.push("GATEWAY=itau: cliente Itaú com auth/mTLS apenas; cobrança e aviso de pagamento lançam GatewayNotReady até a Cobrança V2");
  }
  // Alerta é aviso, não dinheiro: canal ausente vira aviso de configuração, nunca erro de boot.
  if (!e.RESEND_API_KEY) warnings.push("RESEND_API_KEY ausente — alertas críticos NÃO serão enviados (notifier no-op)");
  else if (!e.ALERT_FROM || parseDestinatarios(e.ALERT_EMAIL).length === 0) warnings.push("RESEND_API_KEY presente mas ALERT_FROM/ALERT_EMAIL faltando — alertas NÃO serão enviados");
  if (!e.CONSOLE_PUBLIC_URL) warnings.push("CONSOLE_PUBLIC_URL ausente — o e-mail de alerta sai sem link para o console");
  if (!e.ODOO_API_KEY_CREATED_AT) warnings.push("ODOO_API_KEY_CREATED_AT ausente — o aviso de chave do Odoo vencendo NÃO vai disparar");
  else if (Number.isNaN(new Date(e.ODOO_API_KEY_CREATED_AT).getTime())) warnings.push(`ODOO_API_KEY_CREATED_AT não é data válida (${e.ODOO_API_KEY_CREATED_AT}) — o aviso de chave vencendo não vai disparar`);
  if (e.CONSOLE_TOKEN && e.CONSOLE_TOKEN.length < MIN_SECRET_LENGTH) warnings.push(`CONSOLE_TOKEN tem menos de ${MIN_SECRET_LENGTH} caracteres — o cron externo (POST /api/v1/jobs/:name) fica sem acesso; o console segue funcionando pelo login`);
  if (!e.ODOO_URL || !e.ODOO_API_KEY) warnings.push("ODOO_URL/ODOO_API_KEY ausentes — toda chamada ao Odoo vai falhar (ok só até o acesso chegar)");
  // DATABASE_URL ou PG* (senha com @ / # % não quebra a URL). Advisory locks exigem conexão de SESSÃO: pooler em modo transação (Supabase :6543) não serve.
  const databaseUrl = e.DATABASE_URL ?? (e.PGHOST ? `postgres://${encodeURIComponent(e.PGUSER ?? "motor")}:${encodeURIComponent(e.PGPASSWORD ?? "")}@${e.PGHOST}:${e.PGPORT ?? "5432"}/${e.PGDATABASE ?? "motor"}` : DEFAULT_DATABASE_URL);
  if (/:6543\b|pgbouncer=true/.test(databaseUrl)) warnings.push("DATABASE_URL parece pooler em modo transação (:6543) — os advisory locks quebram; use a conexão direta/sessão (:5432)");
  return {
    GATEWAY: gateway as GatewayName, ITAU: gateway === "itau" ? readItauConfig(e) : null,
    DATABASE_URL: databaseUrl,
    ASAAS_URL: e.ASAAS_URL ?? DEFAULT_ASAAS_URL, ASAAS_API_KEY: gateway === "asaas" ? req("ASAAS_API_KEY") : (e.ASAAS_API_KEY ?? ""), ASAAS_WEBHOOK_TOKEN: secret("ASAAS_WEBHOOK_TOKEN"),
    ODOO_URL: (e.ODOO_URL ?? "").replace(/\/+$/, ""), ODOO_DB: e.ODOO_DB ?? "", ODOO_API_KEY: e.ODOO_API_KEY ?? "", ODOO_WEBHOOK_KEY: secret("ODOO_WEBHOOK_KEY"),
    CONSOLE_TOKEN: e.CONSOLE_TOKEN && e.CONSOLE_TOKEN.length >= MIN_SECRET_LENGTH ? e.CONSOLE_TOKEN : null,
    // Quantos proxies existem na frente. 0 (default) = X-Forwarded-For é ignorado, e o freio
    // de login conta pelo socket. Atrás de Cloud Run / ALB / Cloudflare, ponha 1.
    PORT: Number(e.PORT ?? 8787), TRUSTED_PROXIES: Math.max(0, Math.trunc(Number(e.TRUSTED_PROXIES ?? 0)) || 0),
    RESEND_API_KEY: e.RESEND_API_KEY || null, ALERT_FROM: e.ALERT_FROM || null,
    ALERT_EMAIL: parseDestinatarios(e.ALERT_EMAIL), CONSOLE_PUBLIC_URL: (e.CONSOLE_PUBLIC_URL ?? "").replace(/\/+$/, "") || null,
    ODOO_API_KEY_CREATED_AT: e.ODOO_API_KEY_CREATED_AT || null,
    warnings,
  };
}

export const jsonLog = (msg: string, ctx: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...ctx }));

export function buildNotifier(env: Env, log = jsonLog): Notifier {
  if (!env.RESEND_API_KEY) return createNoopNotifier(log, "RESEND_API_KEY ausente");
  if (!env.ALERT_FROM || env.ALERT_EMAIL.length === 0) return createNoopNotifier(log, "ALERT_FROM ou ALERT_EMAIL ausente");
  return createResendNotifier({ apiKey: env.RESEND_API_KEY, from: env.ALERT_FROM, para: env.ALERT_EMAIL });
}

/** Boot com GATEWAY=itau e a ida ligada em app_config → recusa (não há emissão real ainda). */
export async function assertGatewayBoot(gateway: ChargeGateway, repo: Pick<Repo, "config">): Promise<void> {
  if (gateway.canIssue) return;
  const ida = await repo.config.get<boolean>("IDA_ENABLED");
  if (ida !== false && ida !== null) throw new Error(`GATEWAY=${gateway.name} não emite cobrança ainda (aguardando Cobrança V2) e a ida está ligada em app_config — desligue a ida no console antes de subir com este gateway`);
}

export function buildGateway(env: Env, repo: Repo): { gateway: ChargeGateway; asaas: AsaasHttpClient | null } {
  if (env.GATEWAY === "itau") {
    if (!env.ITAU) throw new Error("GATEWAY=itau sem configuração do Itaú");
    return { gateway: new ItauGateway(new ItauClient(env.ITAU)), asaas: null };
  }
  const asaas = new AsaasHttpClient({ url: env.ASAAS_URL, apiKey: env.ASAAS_API_KEY, audit: repo.audit });
  return { gateway: new AsaasGateway(asaas), asaas };
}

export function buildDeps(env: Env): { deps: Deps; asaas: AsaasHttpClient | null; queries: ConsoleQueries; pool: ReturnType<typeof createPool>; close: () => Promise<void> } {
  const pool = createPool(env.DATABASE_URL);
  const repo = createPgRepo(pool, createLockPool(env.DATABASE_URL));
  const { gateway, asaas } = buildGateway(env, repo);
  const odoo = new OdooJson2Client({ url: env.ODOO_URL, db: env.ODOO_DB || null, apiKey: env.ODOO_API_KEY, audit: repo.audit });
  return { deps: { repo, odoo, gateway, clock: systemClock, log: jsonLog, notify: buildNotifier(env) }, asaas, queries: createConsoleQueries(pool), pool, close: () => pool.end() };
}
