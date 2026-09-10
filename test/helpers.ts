import { createPool } from "../src/adapters/db/pool.js";
import { createPgRepo } from "../src/adapters/db/repo.js";
import { FakeAsaas } from "../src/adapters/fakes/fakeAsaas.js";
import { FakeOdoo } from "../src/adapters/fakes/fakeOdoo.js";
import { fixedClock } from "../src/adapters/clock.js";
import { createServer } from "../src/app/server.js";
import { createConsoleApi } from "../src/app/console.js";
import { createConsoleQueries } from "../src/adapters/db/console.js";
import { CONFIG_KEYS } from "../src/core/console.js";
import type { Deps } from "../src/core/ports.js";

// Banco SEPARADO do de desenvolvimento (lição U4 do QA: os testes sujavam a config do dev).
export const DB_URL = process.env.DATABASE_URL_TEST ?? "postgres://motor:motor@localhost:55432/motor_test";
const TABLES = ["reconciliations", "exceptions", "charges", "customers_map", "webhook_events", "odoo_events", "sync_watermarks", "audit_log"];
export const TOKEN = "t".repeat(32), KEY = "k".repeat(32), CONSOLE_TOKEN = "c".repeat(40);
export const CPF_OK = "52998224725";
export const CNPJ_OK = "19950162000119";

export async function dbReachable(): Promise<boolean> {
  const pool = createPool(DB_URL);
  try { await pool.query("select 1"); return true; } catch { return false; } finally { await pool.end(); }
}

export interface World {
  deps: Deps; odoo: FakeOdoo; asaas: FakeAsaas; pool: ReturnType<typeof createPool>;
  logs: Array<{ msg: string; ctx?: Record<string, unknown> }>;
  app(): ReturnType<typeof createServer>;
  /** chamada autenticada na API do console: devolve status + JSON */
  api(path: string, init?: RequestInit, token?: string): Promise<{ status: number; body: any }>;
  close: () => Promise<void>;
}

/** Mundo limpo: tabelas truncadas, app_config no default do registro (com IDA ligada, salvo pedido contrário). */
export async function world(o: { today?: string; idaEnabled?: boolean } = {}): Promise<World> {
  const pool = createPool(DB_URL);
  await pool.query(`truncate ${TABLES.join(", ")} restart identity cascade`);
  await pool.query("delete from app_config");
  for (const [k, v] of Object.entries(CONFIG_KEYS)) await pool.query("insert into app_config (key, value) values ($1, $2::jsonb)", [k, JSON.stringify(k === "IDA_ENABLED" ? (o.idaEnabled ?? true) : v)]);
  const repo = createPgRepo(pool);
  const odoo = new FakeOdoo();
  const asaas = new FakeAsaas();
  const logs: World["logs"] = [];
  const deps: Deps = { repo, odoo, asaas, clock: fixedClock(`${o.today ?? "2026-09-10"}T13:00:00.000Z`), log: (msg, ctx) => logs.push({ msg, ctx }) };
  const consoleApi = createConsoleApi({ deps, queries: createConsoleQueries(pool), token: CONSOLE_TOKEN });
  const app = () => createServer({ repo, asaasWebhookToken: TOKEN, odooWebhookKey: KEY, log: () => {}, console: consoleApi });
  const api: World["api"] = async (path, init = {}, token = CONSOLE_TOKEN) => {
    const res = await app().request(`/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-user": "dan", ...(init.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { deps, odoo, asaas, pool, logs, app, api, close: () => pool.end() };
}

/** Parceiro 10 + fatura 100 com 2 parcelas de 100 — o cenário padrão. */
export function seedInvoice(w: World, o: { lines?: Array<{ id: number; dateMaturity: string; amount: string }>; vat?: string | null } = {}) {
  w.odoo.addPartner({ id: 10, name: "Cliente Um Ltda", vat: o.vat === undefined ? CNPJ_OK : o.vat, email: "fin@um.com" });
  return w.odoo.addInvoice({ id: 100, name: "INV/2026/0001", partnerId: 10, lines: o.lines ?? [{ id: 1001, dateMaturity: "2026-09-20", amount: "100.00" }, { id: 1002, dateMaturity: "2026-10-20", amount: "100.00" }] });
}
export const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
/** fetch falso por roteiro, pros adaptadores HTTP. */
export function scriptedFetch(script: Array<(url: string, body: unknown) => Response>): typeof fetch {
  let i = 0;
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const step = script[i++];
    if (!step) throw new Error(`fetch inesperado #${i}: ${String(url)}`);
    return step(String(url), init?.body ? JSON.parse(String(init.body)) : null);
  }) as typeof fetch;
}
export const res = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": body.trim().startsWith("<") ? "text/html" : "application/json", ...headers } });
