// Login do console contra Postgres real. Cada teste aqui corresponde a um critério da #13.
// O que está sendo protegido: ninguém entra sem senha, ninguém continua dentro depois de
// desativado, e o token de sessão não sobrevive em lugar nenhum além do cookie do navegador.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createConsoleQueries } from "../../src/adapters/db/console.js";
import { createConsoleApi, cookieSeguro, ehLoopback } from "../../src/app/console.js";
import { createJobRunner } from "../../src/app/scheduler.js";
import { createServer } from "../../src/app/server.js";
import { FreioDeLogin, LOGIN_MAX_TENTATIVAS, hashPassword, hashToken } from "../../src/core/auth.js";
import { CONSOLE_TOKEN, USUARIO, dbReachable, json, world, type World } from "../helpers.js";

let w: World | undefined;
beforeAll(async () => {
  if (!(await dbReachable())) throw new Error("Postgres inacessível — npm run db:up && npm run db:migrate:test");
});
afterEach(async () => { const atual = w; w = undefined; await atual?.close(); });   // não fechar duas vezes o pool do teste anterior

const entrar = (email: string, password: string, headers: Record<string, string> = {}) =>
  w!.api("/session", { ...json({ email, password }), headers: { "content-type": "application/json", ...headers } }, { cookie: null });
const cookieDa = (h: Headers): string => /sdc_session=([^;]*)/.exec(h.get("set-cookie") ?? "")?.[1] ?? "";

describe("login do console (#13)", () => {
  it("senha errada → 401 e NENHUMA sessão no banco (AC1)", async () => {
    w = await world();
    const antes = Number((await w!.pool.query("select count(*)::int as n from console_sessions")).rows[0].n);
    const r = await entrar(USUARIO.email, "senha-errada-mesmo");
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ ok: false, code: "unauthorized" });
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(Number((await w!.pool.query("select count(*)::int as n from console_sessions")).rows[0].n)).toBe(antes);
  });

  it("e-mail que não existe responde igual a senha errada, sem dizer que não existe", async () => {
    w = await world();
    const a = await entrar("ninguem@exemplo.com.br", "chute-qualquer-1");
    const b = await entrar(USUARIO.email, "chute-qualquer-1");
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body).toEqual(b.body);   // mesma resposta, byte a byte
  });

  it("senha certa → cookie de sessão e as rotas de dados abrem", async () => {
    w = await world();
    const r = await entrar(USUARIO.email, USUARIO.senha);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, action: "login", user: { email: USUARIO.email } });
    const set = r.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    const token = cookieDa(r.headers);
    expect((await w!.api("/me", {}, { cookie: token })).body).toMatchObject({ user: { email: USUARIO.email } });
    expect((await w!.api("/charges", {}, { cookie: token })).status).toBe(200);
    // e o último login ficou registrado
    expect((await w!.pool.query("select last_login_at from console_users where email=$1", [USUARIO.email])).rows[0].last_login_at).not.toBeNull();
  });

  it("usuário desativado não entra, e a sessão dele morre na requisição seguinte (AC2)", async () => {
    w = await world();
    expect((await w!.api("/charges")).status).toBe(200);           // sessão do world() funciona
    const u = (await w!.auth.porEmail(USUARIO.email))!;
    await w!.auth.definirAtivo(USUARIO.email, false);
    expect((await w!.api("/charges")).status).toBe(401);           // a MESMA sessão deixa de valer
    expect((await entrar(USUARIO.email, USUARIO.senha)).status).toBe(401);
    // reativar devolve o acesso sem precisar de sessão nova
    await w!.auth.definirAtivo(USUARIO.email, true);
    expect((await w!.api("/charges")).status).toBe(200);
    expect(u.id).toBeGreaterThan(0);
  });

  it("sessão expirada → 401 (AC4)", async () => {
    w = await world();
    const u = (await w!.auth.porEmail(USUARIO.email))!;
    const { token } = await w!.auth.abrirSessao(u.id, w!.deps.clock.now(), 1);
    expect((await w!.api("/charges", {}, { cookie: token })).status).toBe(200);
    // O relógio do mundo de teste é FIXO: vencer contra o `now()` do Postgres não adiantaria,
    // porque quem decide é o clock do motor. Vence contra ele.
    await w!.pool.query("update console_sessions set expires_at = $2 where token_hash = $1", [hashToken(token), new Date(w!.deps.clock.now().getTime() - 1000)]);
    expect((await w!.api("/charges", {}, { cookie: token })).status).toBe(401);
  });

  it("nenhuma rota de dados responde sem sessão (AC5)", async () => {
    w = await world();
    const rotas: Array<[string, RequestInit]> = [
      ["/charges", {}], ["/charges/1", {}], ["/exceptions", {}], ["/exceptions/1", {}],
      ["/dashboard", {}], ["/health-report", {}], ["/config", {}], ["/me", {}],
      ["/exceptions/1/resolve", { method: "POST" }], ["/exceptions/1/ignore", { method: "POST" }],
      ["/exceptions/1/reprocess", { method: "POST" }], ["/exceptions/1/accept-writeoff", { method: "POST" }],
      ["/config/IDA_ENABLED", { method: "PUT", body: JSON.stringify({ value: true }) }],
      ["/customers/enable-notifications", { method: "POST" }],
    ];
    for (const [rota, init] of rotas) {
      expect((await w!.api(rota, init, { cookie: null })).status, `${rota} sem sessão`).toBe(401);
      expect((await w!.api(rota, init, { cookie: null, bearer: CONSOLE_TOKEN })).status, `${rota} com o token do cron`).toBe(401);
    }
  });

  it("POST /jobs/:name continua abrindo com o CONSOLE_TOKEN — o cron externo não quebra (AC8)", async () => {
    w = await world();
    expect((await w!.api("/jobs/watchdog", { method: "POST" }, { cookie: null, bearer: CONSOLE_TOKEN })).status).toBe(200);
    expect((await w!.api("/jobs/watchdog", { method: "POST" }, { cookie: null, bearer: "token-errado" })).status).toBe(401);
    expect((await w!.api("/jobs/naoexiste", { method: "POST" }, { cookie: null, bearer: CONSOLE_TOKEN })).status).toBe(404);
    // e quem está logado também consegue disparar um job pela tela
    expect((await w!.api("/jobs/watchdog", { method: "POST" })).status).toBe(200);
  });

  it("o token da sessão nunca aparece no banco nem no log — só o hash (AC9)", async () => {
    w = await world();
    const r = await entrar(USUARIO.email, USUARIO.senha);
    const token = cookieDa(r.headers);
    expect(token.length).toBeGreaterThan(20);

    const guardados = (await w!.pool.query("select token_hash from console_sessions")).rows.map((x) => String(x.token_hash));
    expect(guardados).toContain(hashToken(token));
    expect(guardados).not.toContain(token);

    const trilha = JSON.stringify((await w!.pool.query("select * from audit_log")).rows);
    expect(trilha).not.toContain(token);
    expect(trilha).toContain("console:login");
    expect(JSON.stringify(w!.logs)).not.toContain(token);
    // a senha também não: nem crua, nem no log
    expect(trilha).not.toContain(USUARIO.senha);
    expect(JSON.stringify(w!.logs)).not.toContain(USUARIO.senha);
  });

  it("seis tentativas erradas seguidas → 429 na sexta (AC10)", async () => {
    w = await world({ freio: new FreioDeLogin() });
    for (let i = 0; i < LOGIN_MAX_TENTATIVAS; i++) {
      expect((await entrar(USUARIO.email, "errada-de-proposito")).status, `tentativa ${i + 1}`).toBe(401);
    }
    const sexta = await entrar(USUARIO.email, "errada-de-proposito");
    expect(sexta.status).toBe(429);
    expect(sexta.body).toMatchObject({ ok: false, code: "busy" });
    // e o freio barra mesmo com a senha CERTA: quem está sendo atacado não é destravado pelo atacante
    expect((await entrar(USUARIO.email, USUARIO.senha)).status).toBe(429);
  });

  it("trocar a senha invalida as sessões abertas na hora (AC11)", async () => {
    w = await world();
    expect((await w!.api("/charges")).status).toBe(200);
    const u = (await w!.auth.porEmail(USUARIO.email))!;
    await w!.auth.definirSenha(USUARIO.email, await hashPassword("outra-senha-boa-9"));
    expect(await w!.auth.revogarDoUsuario(u.id)).toBeGreaterThan(0);
    expect((await w!.api("/charges")).status).toBe(401);
    // e a senha nova entra
    expect((await entrar(USUARIO.email, "outra-senha-boa-9")).status).toBe(200);
    expect((await entrar(USUARIO.email, USUARIO.senha)).status).toBe(401);
  });

  it("logout apaga a sessão do banco e o cookie do navegador", async () => {
    w = await world();
    const r = await w!.api("/session", { method: "DELETE" });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie") ?? "").toMatch(/sdc_session=;|Max-Age=0/i);
    expect((await w!.api("/charges")).status).toBe(401);
    expect(Number((await w!.pool.query("select count(*)::int as n from console_sessions")).rows[0].n)).toBe(0);
  });

  it("CSRF: rota que muda estado recusa content-type de formulário", async () => {
    w = await world();
    await w!.deps.repo.exceptions.open({ type: "stale_heartbeat", refTable: "webhook_events" });
    const ex = (await w!.api("/exceptions?status=open")).body.data[0];
    const comoFormulario = await w!.api(`/exceptions/${ex.id}/resolve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(comoFormulario.status).toBe(400);
    expect((await w!.api(`/exceptions/${ex.id}`)).body.status).toBe("open");   // não mexeu em nada
    expect((await w!.api(`/exceptions/${ex.id}/resolve`, { method: "POST" })).status).toBe(200);
  });

  it("cookie Secure segue o protocolo, e localhost consegue logar sem https (AC12)", async () => {
    w = await world();
    const req = (url: string, headers: Record<string, string> = {}) =>
      ({ req: { url, header: (h: string) => headers[h.toLowerCase()] } }) as never;
    expect(cookieSeguro(req("http://localhost:8787/api/v1/session"))).toBe(false);
    expect(cookieSeguro(req("https://motor.exemplo.com.br/api/v1/session"))).toBe(true);
    // atrás de proxy o protocolo real vem no header
    expect(cookieSeguro(req("http://motor.interno/api/v1/session", { "x-forwarded-proto": "https" }))).toBe(true);
    expect(cookieSeguro(req("http://motor.interno/api/v1/session", { "x-forwarded-proto": "https, http" }))).toBe(true);
    expect(cookieSeguro(req("http://motor.interno/api/v1/session", { "x-forwarded-proto": "http" }))).toBe(false);
    // e o Secure só pode cair em loopback: host público em http continua exigindo Secure
    expect(ehLoopback("localhost:8787")).toBe(true);
    expect(ehLoopback("127.0.0.1")).toBe(true);
    expect(ehLoopback("motor.exemplo.com.br")).toBe(false);
    expect(ehLoopback(undefined)).toBe(false);
  });

  it("token de cookie malformado não vira consulta ao banco, e não autentica", async () => {
    w = await world();
    for (const ruim of ["", "x", "'; drop table console_sessions; --", "a".repeat(200)]) {
      expect((await w!.api("/charges", {}, { cookie: ruim })).status, ruim.slice(0, 12)).toBe(401);
    }
    expect(Number((await w!.pool.query("select count(*)::int as n from console_sessions")).rows[0].n)).toBe(1);
  });

  it("o diário limpa sessão expirada", async () => {
    w = await world();
    const u = (await w!.auth.porEmail(USUARIO.email))!;
    await w!.auth.abrirSessao(u.id, new Date(Date.now() - 86_400_000), 60);   // venceu ontem
    expect(Number((await w!.pool.query("select count(*)::int as n from console_sessions")).rows[0].n)).toBe(2);
    expect(await w!.auth.purgarExpiradas(new Date())).toBe(1);
    expect((await w!.api("/charges")).status).toBe(200);   // a sessão viva sobreviveu
  });

  it("console sem store de login: 503 explicando, e o cron ainda funciona", async () => {
    w = await world();
    // Simula um deploy onde a migration 0005 não rodou: nada de login, mas o cron externo
    // não pode cair junto.
    const semLogin = createServer({
      repo: w!.deps.repo, asaasWebhookToken: "t".repeat(32), odooWebhookKey: "k".repeat(32), log: () => {},
      console: createConsoleApi({ deps: w!.deps, queries: createConsoleQueries(w!.pool), token: CONSOLE_TOKEN, jobs: createJobRunner(w!.deps) }),
    });
    const r = await semLogin.request("/api/v1/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: USUARIO.email, password: USUARIO.senha }) });
    expect(r.status).toBe(503);
    expect((await r.json()).error).toMatch(/0005/);
    expect((await semLogin.request("/api/v1/charges")).status).toBe(401);
    expect((await semLogin.request("/api/v1/jobs/watchdog", { method: "POST", headers: { authorization: `Bearer ${CONSOLE_TOKEN}` } })).status).toBe(200);
  });
});
