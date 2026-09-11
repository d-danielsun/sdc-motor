import { createPool } from "../src/adapters/db/pool.js";
import { createPgRepo } from "../src/adapters/db/repo.js";
import { FakeAsaas } from "../src/adapters/fakes/fakeAsaas.js";
import { FakeOdoo } from "../src/adapters/fakes/fakeOdoo.js";
import { FakeNotifier } from "../src/adapters/notify/fake.js";
import { fixedClock } from "../src/adapters/clock.js";
import { createServer } from "../src/app/server.js";
import { SESSION_COOKIE, createConsoleApi } from "../src/app/console.js";
import { createJobRunner } from "../src/app/scheduler.js";
import { createAuthStore } from "../src/adapters/db/auth.js";
import { createConsoleQueries } from "../src/adapters/db/console.js";
import { CUSTO_TESTE, hashPassword, type FreioDeLogin } from "../src/core/auth.js";
import { CONFIG_KEYS } from "../src/core/console.js";
import type { Deps } from "../src/core/ports.js";

// Banco SEPARADO do de desenvolvimento (lição U4 do QA: os testes sujavam a config do dev).
export const DB_URL = process.env.DATABASE_URL_TEST ?? "postgres://motor:motor@localhost:55432/motor_test";
const TABLES = ["reconciliations", "exceptions", "charges", "customers_map", "webhook_events", "odoo_events", "sync_watermarks", "audit_log", "console_sessions", "console_users", "alerts_sent"];
export const TOKEN = "t".repeat(32), KEY = "k".repeat(32), CONSOLE_TOKEN = "c".repeat(40);
/** Usuário que o `world()` cria e loga: as chamadas de `api()` são desta pessoa. */
export const USUARIO = { email: "financeiro@exemplo.com.br", name: "Financeiro", senha: "senha-de-teste-1" };
// Documentos SINTÉTICOS com dígito verificador válido. O CNPJ daqui já foi o da BLZA
// Digital, a entidade que fatura este deal — e o repositório é público desde 10/09/2026.
export const CPF_OK = "11144477735";
export const CNPJ_OK = "11222333000181";

export async function dbReachable(): Promise<boolean> {
  const pool = createPool(DB_URL);
  try { await pool.query("select 1"); return true; } catch { return false; } finally { await pool.end(); }
}

export interface World {
  deps: Deps; odoo: FakeOdoo; asaas: FakeAsaas; pool: ReturnType<typeof createPool>;
  auth: ReturnType<typeof createAuthStore>;
  /** Canal de alerta em memória: `w.notify.enviados` é o que teria sido mandado. */
  notify: FakeNotifier;
  logs: Array<{ msg: string; ctx?: Record<string, unknown> }>;
  app(): ReturnType<typeof createServer>;
  /** Cookie de sessão da pessoa logada — o que autentica as rotas de dados. */
  sessao: string;
  /** chamada na API do console COM a sessão; `o.cookie:null` derruba a sessão, `o.bearer` usa o token do cron. */
  api(path: string, init?: RequestInit, o?: { cookie?: string | null; bearer?: string }): Promise<{ status: number; body: any; headers: Headers }>;
  close: () => Promise<void>;
}

/** Mundo limpo: tabelas truncadas, app_config no default do registro (com IDA ligada, salvo pedido contrário). */
export async function world(o: { today?: string; idaEnabled?: boolean; cutoff?: string | null; freio?: FreioDeLogin; destinatarios?: string[] } = {}): Promise<World> {
  const pool = createPool(DB_URL);
  await pool.query(`truncate ${TABLES.join(", ")} restart identity cascade`);
  await pool.query("delete from app_config");
  const overrides: Record<string, unknown> = { IDA_ENABLED: o.idaEnabled ?? true, GO_LIVE_CUTOFF_DATE: o.cutoff === undefined ? "2026-01-01" : o.cutoff };   // sem data de corte nada é emitido
  for (const [k, v] of Object.entries(CONFIG_KEYS)) await pool.query("insert into app_config (key, value) values ($1, $2::jsonb)", [k, JSON.stringify(k in overrides ? overrides[k] : v)]);
  const repo = createPgRepo(pool);
  const odoo = new FakeOdoo();
  const asaas = new FakeAsaas();
  const logs: World["logs"] = [];
  const notify = new FakeNotifier(o.destinatarios ?? ["financeiro@exemplo.com.br"]);
  const deps: Deps = { repo, odoo, asaas, clock: fixedClock(`${o.today ?? "2026-09-10"}T13:00:00.000Z`), log: (msg, ctx) => logs.push({ msg, ctx }), notify };
  const auth = createAuthStore(pool);
  const consoleApi = createConsoleApi({ deps, queries: createConsoleQueries(pool), token: CONSOLE_TOKEN, jobs: createJobRunner(deps), auth, freio: o.freio });
  const app = () => createServer({ repo, asaasWebhookToken: TOKEN, odooWebhookKey: KEY, log: () => {}, console: consoleApi });

  // Uma pessoa logada, porque desde a #13 o token compartilhado não abre rota de dados.
  const pessoa = await auth.criarOuAtualizar({ email: USUARIO.email, name: USUARIO.name, passwordHash: await hashPassword(USUARIO.senha, { custo: CUSTO_TESTE }) });
  const { token: sessao } = await auth.abrirSessao(pessoa.id, deps.clock.now());

  const api: World["api"] = async (path, init = {}, o = {}) => {
    const cookie = o.cookie === undefined ? sessao : o.cookie;
    const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as Record<string, string> ?? {}) };
    if (cookie) headers.cookie = `${SESSION_COOKIE}=${cookie}`;
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    const res = await app().request(`/api/v1${path}`, { ...init, headers });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return { deps, odoo, asaas, pool, auth, notify, logs, app, api, sessao, close: () => pool.end() };
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
