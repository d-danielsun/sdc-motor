// API do console (/api/v1).
//
// AUTENTICAÇÃO (fecha a #1). Cookie de sessão de uma PESSOA nas rotas de dados; o
// `Bearer CONSOLE_TOKEN` sobrevive apenas em POST /jobs/:name, que é o cron externo. Antes
// disto, `resolved_by` vinha do header `x-user`, que qualquer portador do token escolhia —
// num motor que mexe em dinheiro isso não é rastro de auditoria, é sugestão. `x-user` deixou
// de ser lido: quem resolveu é quem estava logado.
//
// Envelope de erro único: { ok:false, code, error } — code decide o status.
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AuthStore, ConsoleUser } from "../adapters/db/auth.js";
import { FreioDeLogin, isEmail, normalizeEmail, SESSION_TTL_SECONDS, tokenBemFormado, verifyPassword } from "../core/auth.js";
import type { ConsoleQueries } from "../core/console.js";
import { CONSOLE_CONFIG_KEYS, EXC_TYPES, type ActionResult, type ErrorCode } from "../core/console.js";
import type { Deps } from "../core/ports.js";
import type { ChargeStatus, ExceptionType } from "../core/types.js";
import { acceptWriteoff, enableCustomerNotifications, healthReport, isIsoDate, reprocessException, requeueAllByType, resolveException, setConsoleConfig } from "../core/usecases/console.js";
import { safeEqual } from "./server.js";

import type { JobRunner } from "./scheduler.js";
export interface ConsoleDeps {
  deps: Deps; queries: ConsoleQueries;
  /** Só abre POST /jobs/:name (cron externo). Não abre mais rota de dados. */
  token: string | null;
  jobs?: JobRunner;
  /** Ausente = login desabilitado (só o cron funciona). */
  auth?: AuthStore;
  /** Freio de tentativas injetável para o teste não depender de tempo real. */
  freio?: FreioDeLogin;
  /** Quantos proxies existem na frente do motor. 0 = ignora X-Forwarded-For. */
  proxiesConfiaveis?: number;
  /** Permite cookie sem `Secure` em loopback. Ligado só fora de produção. */
  permitirCookieInseguro?: boolean;
}

export const SESSION_COOKIE = "sdc_session";

// A pessoa logada viaja no contexto da requisição. Augmentation do ContextVariableMap é o
// jeito do Hono de tipar isso sem espalhar generic por todo lugar (nem `any`).
declare module "hono" {
  interface ContextVariableMap { consoleUser: ConsoleUser }
}

/** `Secure` quando a requisição chega por https, e nunca desligado fora de loopback: senão o
 *  dev local e o modo demo não conseguiriam logar, e um host público não pode mandar cookie
 *  de sessão em claro. */
export function cookieSeguro(c: Context): boolean {
  const proto = (c.req.header("x-forwarded-proto") ?? "").split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return true;
  }
}
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i;
export function ehLoopback(host: string | undefined): boolean {
  return LOOPBACK.test((host ?? "").trim());
}

/** Cookie sem `Secure` só em http de loopback E com a exceção declarada. Antes bastava o
 *  `Host: localhost`, que um proxy mal configurado pode reescrever — o cookie saía em claro
 *  sem ninguém pedir. Em produção (NODE_ENV=production, como no Dockerfile) a exceção não
 *  existe e o cookie é sempre Secure. */
export function exigeSecure(c: Context, cd: Pick<ConsoleDeps, "permitirCookieInseguro">): boolean {
  if (cookieSeguro(c)) return true;
  return !(cd.permitirCookieInseguro === true && ehLoopback(c.req.header("host")));
}

const STATUS_BY_CODE: Record<ErrorCode | "internal" | "unauthorized", number> = { not_found: 404, invalid_state: 409, invalid_input: 400, upstream: 502, config: 500, busy: 409, internal: 500, unauthorized: 401 };
const EXC_STATUSES = ["open", "resolved", "ignored"] as const;

const CHARGE_STATUSES: ChargeStatus[] = ["pending", "created", "confirmed", "received", "settled", "cancelled", "refunded", "exception"];

class BadInput extends Error { constructor(msg: string) { super(msg); } }
const intParam = (v: string | undefined, name: string, o: { min?: number; max?: number } = {}): number | undefined => {
  if (v === undefined || v === "") return undefined;
  if (!/^\d+$/.test(v)) throw new BadInput(`${name} deve ser inteiro`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || (o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max)) throw new BadInput(`${name} fora da faixa`);
  return n;
};
const idParam = (v: string): number => { const n = intParam(v, "id", { min: 1 }); if (n === undefined) throw new BadInput("id obrigatório"); return n; };
const dateParam = (v: string | undefined, name: string): string | undefined => { if (v === undefined || v === "") return undefined; if (!isIsoDate(v)) throw new BadInput(`${name} deve ser YYYY-MM-DD`); return v; };
const enumParam = <T extends string>(v: string | undefined, name: string, allowed: readonly T[]): T | undefined => { if (v === undefined || v === "") return undefined; if (!(allowed as readonly string[]).includes(v)) throw new BadInput(`${name} inválido`); return v as T; };
const send = (c: Context, r: ActionResult) => c.json(r, r.ok ? 200 : (STATUS_BY_CODE[r.code] as 400 | 404 | 409 | 500 | 502));
/** Quem está agindo: o e-mail da sessão. `x-user` NÃO é mais lido (era asserção do cliente). */
const who = (c: Context): string => {
  const u = c.get("consoleUser");
  return u ? u.email.slice(0, 64) : "cron";
};
/** Hash de uma senha que ninguém tem: garante o mesmo custo de scrypt quando o e-mail não
 *  existe. Gerado uma vez, no carregamento do módulo. */
const HASH_FALSO = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** De onde vem a requisição, para o freio de tentativas.
 *
 *  `X-Forwarded-For` é escrito pelo cliente: confiar nele de graça deixa qualquer um trocar
 *  de identidade a cada tentativa, e o braço por IP do freio para de existir (achado do
 *  verificador da #13). Então o default é o endereço do socket, e o header só vale quando o
 *  operador declara quantos proxies existem na frente — aí o hop que interessa é o
 *  N-ésimo a partir do fim, o único que um proxy honesto acrescentou.
 *
 *  Sem socket (o `app.request()` dos testes), cai em "local": o teste do freio passa a chave
 *  que quer exercitar. */
export function clientIp(c: Context, proxiesConfiaveis = 0): string {
  if (proxiesConfiaveis > 0) {
    const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    const escolhido = hops[hops.length - proxiesConfiaveis];
    if (escolhido) return escolhido.slice(0, 64);
  }
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket;
  return (socket?.remoteAddress ?? "local").slice(0, 64);
}

/** O scrypt é caro de propósito (~50 ms de CPU), e o login é a única porta que aceita
 *  trabalho pesado ANTES de autenticar. Sem teto, algumas centenas de tentativas simultâneas
 *  comem o pool do banco e a CPU do processo. Quem passar do teto leva 429 na hora, sem
 *  gastar scrypt — a resposta rápida é a defesa, não o enfileiramento. */
export const MAX_LOGINS_SIMULTANEOS = 4;

/** CSRF: um formulário cross-site só consegue mandar form-urlencoded ou multipart. Toda rota
 *  que muda estado exige JSON, o que um formulário não consegue forjar sem CORS. */
function exigeJson(c: Context): void {
  const ct = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (ct !== "application/json") throw new BadInput("content-type deve ser application/json");
}
function exigeJsonSeTiverCorpo(c: Context): void {
  const ct = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (ct && ct !== "application/json") throw new BadInput("content-type deve ser application/json");
}

async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  let b: unknown;
  try { b = await c.req.json(); } catch { throw new BadInput("bad json"); }
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw new BadInput("expected JSON object");
  return b as Record<string, unknown>;
}

export function createConsoleApi(cd: ConsoleDeps): Hono {
  const api = new Hono();
  api.onError((e, c) => {
    if (e instanceof BadInput) return c.json({ ok: false, code: "invalid_input", error: e.message }, 400);
    cd.deps.log("console: erro não tratado", { path: c.req.path, error: e.message });
    return c.json({ ok: false, code: "internal", error: "internal error" }, 500);
  });
  api.notFound((c) => c.json({ ok: false, code: "not_found", error: "not found" }, 404));
  // ── sessão ────────────────────────────────────────────────────────────────
  const freio = cd.freio ?? new FreioDeLogin();
  let emVoo = 0;
  const naoAutorizado = (c: Context) => c.json({ ok: false, code: "unauthorized", error: "unauthorized" }, 401);

  api.post("/session", async (c) => {
    if (!cd.auth) return c.json({ ok: false, code: "config", error: "login do console indisponível: banco sem a migration 0005" }, 503);
    exigeJson(c);
    const body = await jsonObject(c);
    const email = typeof body.email === "string" ? normalizeEmail(body.email) : "";
    const senha = typeof body.password === "string" ? body.password : "";
    const agora = cd.deps.clock.now();
    const ip = clientIp(c, cd.proxiesConfiaveis ?? 0);
    const chaves = [`email:${email}`, `ip:${ip}`];

    if (!email || !senha) throw new BadInput("email e password são obrigatórios");
    if (emVoo >= MAX_LOGINS_SIMULTANEOS) {
      cd.deps.log("console: login recusado por concorrência", { emVoo, ip });
      return c.json({ ok: false, code: "busy", error: "muitas tentativas simultâneas — tente de novo em instantes" }, 429);
    }
    if (freio.bloqueado(chaves, agora)) {
      cd.deps.log("console: login barrado pelo freio", { email, ip });
      return c.json({ ok: false, code: "busy", error: "muitas tentativas — espere alguns minutos" }, 429);
    }

    emVoo++;
    let u: Awaited<ReturnType<AuthStore["porEmail"]>>, senhaOk: boolean;
    try {
      u = isEmail(email) ? await cd.auth.porEmail(email) : null;
      // Mesmo trabalho para e-mail inexistente e senha errada: sem o hash falso, o tempo de
      // resposta diria quais e-mails existem.
      senhaOk = await verifyPassword(senha, u?.passwordHash ?? HASH_FALSO);
    } finally {
      emVoo--;
    }
    if (!u || !u.active || !senhaOk) {
      freio.registrarFalha(chaves, agora);
      cd.deps.log("console: login negado", { email, ip });
      return naoAutorizado(c);
    }

    freio.limpar(chaves);
    const s = await cd.auth.abrirSessao(u.id, agora);
    await cd.auth.marcarLogin(u.id, agora);
    setCookie(c, SESSION_COOKIE, s.token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: SESSION_TTL_SECONDS, secure: exigeSecure(c, cd) });
    await cd.deps.repo.audit.log({ direction: "console", endpoint: "console:login", requestSummary: { email: u.email, ip } });
    return c.json({ ok: true, action: "login", user: { email: u.email, name: u.name }, expiresAt: s.expiresAt.toISOString() });
  });

  api.delete("/session", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (cd.auth && tokenBemFormado(token)) {
      const sessao = await cd.auth.resolverSessao(token, cd.deps.clock.now());
      await cd.auth.fecharSessao(token);
      if (sessao) await cd.deps.repo.audit.log({ direction: "console", endpoint: "console:logout", requestSummary: { email: sessao.user.email } });
    }
    setCookie(c, SESSION_COOKIE, "", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 0, secure: exigeSecure(c, cd) });
    return c.json({ ok: true, action: "logout" });
  });

  /** Resolve o cookie de sessão, se houver uma válida. */
  const sessaoDe = async (c: Context) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!cd.auth || !tokenBemFormado(token)) return null;
    return cd.auth.resolverSessao(token, cd.deps.clock.now());
  };

  // ── jobs: o ÚNICO lugar onde o token compartilhado ainda abre porta ───────
  //
  // Sub-app próprio de propósito. Antes isto era um `if` dentro do middleware geral, que
  // decidia "isto é um job?" com regex sobre a URL re-parseada — ou seja, o guard de
  // segurança lia o caminho com um parser e o roteador com outro. Não era explorável, mas
  // dois parsers discordando é como furo de autenticação nasce. Agora quem decide que a rota
  // é de job é o próprio roteador: se este handler rodou, é job.
  const jobsApp = new Hono();
  jobsApp.post("/:name", async (c) => {
    const sessao = await sessaoDe(c);
    if (!sessao) {
      const auth = c.req.header("authorization") ?? "";
      if (!cd.token || !safeEqual(auth.startsWith("Bearer ") ? auth.slice(7) : null, cd.token)) return naoAutorizado(c);
    }
    const name = c.req.param("name");
    if (!cd.jobs || !cd.jobs.isJob(name)) return c.json({ ok: false, code: "not_found", error: "job desconhecido" }, 404);
    const result = await cd.jobs.run(name);
    return c.json({ ok: result !== null, action: `job:${name}`, detail: result }, result !== null ? 200 : 502);
  });
  api.route("/jobs", jobsApp);

  // Guarda de todo o resto. Registrada DEPOIS de /session e /jobs, então não os envolve.
  api.use("*", async (c, next) => {
    const sessao = await sessaoDe(c);
    if (!sessao) return naoAutorizado(c);
    c.set("consoleUser", sessao.user);
    if (c.req.method !== "GET") exigeJsonSeTiverCorpo(c);
    await next();
  });

  api.get("/me", async (c) => {
    const u = c.get("consoleUser");
    return u ? c.json({ ok: true, user: { email: u.email, name: u.name } }) : naoAutorizado(c);
  });

  api.get("/exceptions", async (c) => c.json(await cd.queries.exceptions({
    status: enumParam(c.req.query("status"), "status", EXC_STATUSES), type: enumParam(c.req.query("type"), "type", EXC_TYPES),
    limit: intParam(c.req.query("limit"), "limit", { min: 1, max: 200 }), offset: intParam(c.req.query("offset"), "offset", { min: 0 }),
  })));
  api.get("/exceptions/:id", async (c) => { const r = await cd.queries.exception(idParam(c.req.param("id"))); return r ? c.json(r) : c.json({ ok: false, code: "not_found", error: "not found" }, 404); });
  api.post("/exceptions/:id/resolve", async (c) => send(c, await resolveException(cd.deps, idParam(c.req.param("id")), who(c), "resolved")));
  api.post("/exceptions/:id/ignore", async (c) => send(c, await resolveException(cd.deps, idParam(c.req.param("id")), who(c), "ignored")));
  api.post("/exceptions/:id/reprocess", async (c) => send(c, await reprocessException(cd.deps, idParam(c.req.param("id")), who(c))));
  api.post("/exceptions/:id/accept-writeoff", async (c) => send(c, await acceptWriteoff(cd.deps, idParam(c.req.param("id")), who(c))));

  api.get("/charges", async (c) => {
    const statuses = c.req.query("status")?.split(",").filter(Boolean);
    for (const s of statuses ?? []) enumParam(s, "status", CHARGE_STATUSES);
    const q = c.req.query("q");
    if (q !== undefined && q.length > 100) throw new BadInput("q muito longo");
    // Keyset: os dois parâmetros ou nenhum. Um só é erro de quem chama, não default silencioso —
    // paginar por metade do cursor devolveria página errada sem avisar.
    const afterDue = dateParam(c.req.query("after_due_date"), "after_due_date");
    const afterId = intParam(c.req.query("after_id"), "after_id", { min: 1 });
    if ((afterDue === undefined) !== (afterId === undefined)) throw new BadInput("after_due_date e after_id andam juntos");
    return c.json(await cd.queries.charges({
      status: statuses as ChargeStatus[] | undefined, dueFrom: dateParam(c.req.query("due_from"), "due_from"), dueTo: dateParam(c.req.query("due_to"), "due_to"),
      partnerId: intParam(c.req.query("partner"), "partner", { min: 1 }), q: q || undefined,
      limit: intParam(c.req.query("limit"), "limit", { min: 1, max: 200 }), offset: intParam(c.req.query("offset"), "offset", { min: 0 }),
      after: afterDue !== undefined && afterId !== undefined ? { dueDate: afterDue, id: afterId } : undefined,
    }));
  });
  api.get("/charges/:id", async (c) => { const r = await cd.queries.charge(idParam(c.req.param("id"))); return r ? c.json(r) : c.json({ ok: false, code: "not_found", error: "not found" }, 404); });

  api.get("/dashboard", async (c) => c.json({ today: cd.deps.clock.today(), aging: await cd.queries.aging(cd.deps.clock.today()) }));
  api.get("/health-report", async (c) => c.json(await healthReport(cd.deps, cd.queries)));

  api.get("/config", async (c) => {
    const out: Record<string, unknown> = {};
    for (const k of CONSOLE_CONFIG_KEYS) out[k] = await cd.deps.repo.config.get(k);
    return c.json(out);
  });
  api.put("/config/:key", async (c) => send(c, await setConsoleConfig(cd.deps, c.req.param("key"), (await jsonObject(c)).value)));
  // 202 e não 200: o trabalho continua depois da resposta. Ligar a régua para uma base grande é
  // uma chamada ao Asaas por cliente, e isso não cabe num request sem morrer no timeout do proxy.
  // O progresso vive em app_config.NOTIFICATIONS_PROGRESS e aparece no health-report; retomar é
  // chamar de novo, porque quem já está ligado não é rechamado.
  api.post("/customers/enable-notifications", async (c) => {
    const total = (await cd.deps.repo.customers.listSynced()).length;
    void enableCustomerNotifications(cd.deps).catch((e) => cd.deps.log("enable-notifications falhou", { error: (e as Error).message }));
    return c.json({ ok: true, action: "notifications_enabling", detail: { total } }, 202);
  });
  // Reenfileira em lote os eventos em `error` das exceções abertas de um tipo. A exceção NÃO é
  // resolvida aqui: quem resolve é o worker ao processar com sucesso, ou uma pessoa.
  api.post("/exceptions/requeue-all", async (c) => {
    const tipo = c.req.query("type");
    if (!tipo) throw new BadInput("type é obrigatório — reenfileirar tudo de uma vez não é uma operação que alguém queira sem escolher");
    return send(c, await requeueAllByType(cd.deps, tipo));
  });
  return api;
}
