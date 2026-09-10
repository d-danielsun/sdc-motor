// Achados da caça-unknowns (TEST-PLAN §3) e do review: cada um vira um teste que fixa o comportamento certo.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertMigrated, pendingMigrations } from "../../src/adapters/db/migrations.js";
import { OdooJson2Client } from "../../src/adapters/odoo/client.js";
import { CLAIM_TTL_MINUTES } from "../../src/adapters/db/repo.js";
import { runJob, startScheduler } from "../../src/app/scheduler.js";
import { safeEqual } from "../../src/app/server.js";
import { processAsaasEvents, syncInvoices } from "../../src/core/index.js";
import { reprocessException } from "../../src/core/usecases/console.js";
import { dbReachable, json, seedInvoice, world, type World } from "../helpers.js";

const opened: World[] = [];
async function fresh(o: Parameters<typeof world>[0] = {}): Promise<World> { const w = await world(o); opened.push(w); return w; }
beforeAll(async () => { if (!(await dbReachable())) throw new Error("banco de teste fora do ar — `npm run db:reset`"); });
afterEach(async () => { for (const w of opened.splice(0)) await w.close(); });
async function idaPronta() { const w = await fresh(); seedInvoice(w); await syncInvoices(w.deps); return { w, p1: [...w.asaas.payments.values()][0]! }; }
const htmlFetch = (async () => new Response("<html>Database currently unavailable</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

describe("U1 — Odoo devolvendo HTML/303 nunca vira baixa", () => {
  it("HTML 200 (transiente) → evento fica em retry; cobrança 'created'; zero conciliações", async () => {
    const { w, p1 } = await idaPronta();
    w.deps.odoo = new OdooJson2Client({ url: "https://odoo.expirada", apiKey: "k", fetchImpl: htmlFetch });
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1.id, payload: w.asaas.confirm(p1.id) });
    expect(await processAsaasEvents(w.deps)).toMatchObject({ done: 0, errors: 0 });
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("created");
    expect(await w.deps.repo.reconciliations.existsForCharge(1)).toBe(false);
    expect((await w.deps.repo.asaasEvents.findByPayment(p1.id, "PAYMENT_RECEIVED"))!.attempts).toBe(1);
  });
  it("303 (definitivo) → evento em 'error' COM exceção reprocessável; Odoo volta → reprocessar → baixa", async () => {
    const { w, p1 } = await idaPronta();
    w.deps.odoo = new OdooJson2Client({ url: "https://odoo.expirada", apiKey: "k", fetchImpl: (async () => new Response("", { status: 303, headers: { location: "https://odoo/_odoo/upgrade/x" } })) as unknown as typeof fetch });
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e2", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1.id, payload: w.asaas.confirm(p1.id) });
    expect(await processAsaasEvents(w.deps)).toMatchObject({ errors: 1 });
    const ev = (await w.deps.repo.asaasEvents.findByPayment(p1.id, "PAYMENT_RECEIVED"))!;
    expect(await w.deps.repo.exceptions.hasOpen("payment_unmatched", "webhook_events", ev.id)).toBe(true);
    expect((await w.pool.query("select count(*)::int as n from exceptions where status='open'")).rows[0].n).toBe(1);   // uma só, não duas
    w.deps.odoo = w.odoo;
    const exId = (await w.pool.query("select id from exceptions where ref_table='webhook_events' and ref_id=$1", [ev.id])).rows[0].id;
    expect(await reprocessException(w.deps, exId, "dan")).toMatchObject({ ok: true, action: "asaas_event_requeued" });
    expect(await processAsaasEvents(w.deps)).toMatchObject({ done: 1 });
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("received");
  });
  it("wizard rodou e a parcela não fechou (409) → cobrança vai a 'exception', 1 exceção, e o reconcile NÃO re-tenta sozinho", async () => {
    const { w, p1 } = await idaPronta();
    w.deps.odoo.registerPayment = async () => { throw Object.assign(new Error("odoo: baixa NÃO confirmada"), { transient: false }); };
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e3", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1.id, payload: w.asaas.confirm(p1.id) });
    expect(await processAsaasEvents(w.deps)).toMatchObject({ errors: 1 });
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("exception");
    expect((await w.pool.query("select count(*)::int as n from exceptions where status='open'")).rows[0].n).toBe(1);
    const { reconcileDaily } = await import("../../src/core/index.js");
    delete (w.odoo as { registerPayment?: unknown }).registerPayment;   // volta ao método real do fake (w.deps.odoo é o próprio fake)
    expect(await reconcileDaily(w.deps)).toMatchObject({ needsReview: 1, received: 0 });
    expect(w.odoo.payments).toHaveLength(0);
    const exId = (await w.pool.query("select id from exceptions where ref_table='charges'")).rows[0].id;
    expect(await reprocessException(w.deps, exId, "dan")).toMatchObject({ ok: true });   // a pessoa reabre: cobrança volta a created, evento reenfileirado
    expect(await processAsaasEvents(w.deps)).toMatchObject({ done: 1 });
    expect(w.odoo.payments).toHaveLength(1);
  });
});

describe("U2 — job que falha vira exceção integration_error (uma por vez)", () => {
  it("sync-invoices com Odoo fora → exceção aberta; segunda falha não duplica", async () => {
    const w = await fresh();
    w.deps.odoo.searchInvoices = async () => { throw new Error("odoo: redirect 303 — base expirada"); };
    expect(await runJob(w.deps, "sync-invoices")).toBeNull();
    expect(await runJob(w.deps, "sync-invoices")).toBeNull();
    const r = await w.pool.query("select count(*)::int as n, min(detail->>'job') as job from exceptions where type='integration_error' and status='open'");
    expect(r.rows[0]).toMatchObject({ n: 1, job: "sync-invoices" });
  });
});

describe("U3 — banco sem migração", () => {
  it("assertMigrated lista o que falta; erro de conexão NÃO vira 'sem migração'", async () => {
    const w = await fresh();
    expect(await pendingMigrations(w.pool)).toEqual([]);
    await w.pool.query("delete from schema_migrations where name='0004_review_hardening.sql'");
    try { await expect(assertMigrated(w.pool)).rejects.toThrow(/0004_review_hardening\.sql/); }
    finally { await w.pool.query("insert into schema_migrations (name) values ('0004_review_hardening.sql') on conflict do nothing"); }
    const broken = { query: async () => { throw Object.assign(new Error("password authentication failed"), { code: "28P01" }); } };
    await expect(pendingMigrations(broken as never)).rejects.toThrow(/password/);
  });
});

describe("U6 — a fonte de verdade é a parcela no Odoo", () => {
  it("parcela já conciliada (retry após crash) → fecha do nosso lado sem 2º pagamento", async () => {
    const { w, p1 } = await idaPronta();
    await w.deps.odoo.registerPayment({ moveLineId: 1001, amount: "100.00", paymentDate: "2026-09-10" });   // registrou, mas o motor caiu antes de gravar
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1.id, payload: w.asaas.confirm(p1.id) });
    expect(await processAsaasEvents(w.deps)).toMatchObject({ done: 1 });
    expect(w.odoo.payments).toHaveLength(1);
    expect((await w.pool.query("select diff_policy from reconciliations where charge_id=1")).rows[0].diff_policy).toBe("ja_baixada_no_odoo");
  });
  it("parcela que sumiu do Odoo → exceção, nunca baixa; residual parcial → divergente, sem 2º pagamento", async () => {
    const { w, p1 } = await idaPronta();
    w.odoo.lines.delete(1001);
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1.id, payload: w.asaas.confirm(p1.id) });
    expect(await processAsaasEvents(w.deps)).toMatchObject({ errors: 1 });
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("created");
    expect((await w.pool.query("select detail from exceptions where type='payment_unmatched' and ref_table='charges'")).rows[0].detail).toMatchObject({ reason: expect.stringContaining("não existe mais") });
    const { w: w2, p1: q1 } = await idaPronta();
    await w2.odoo.registerPayment({ moveLineId: 1001, amount: "40.00", paymentDate: "2026-09-09" });
    await w2.deps.repo.asaasEvents.insert({ asaasEventId: "e1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: q1.id, payload: w2.asaas.confirm(q1.id) });
    await processAsaasEvents(w2.deps);
    expect(w2.odoo.payments).toHaveLength(1);
    expect(await w2.deps.repo.exceptions.hasOpen("amount_divergent", "charges")).toBe(true);
  });
  it("mesma parcela paga duas vezes (2º pay_ com a mesma referência) → exceção, não 2ª baixa; conciliação é única no schema", async () => {
    const { w, p1 } = await idaPronta();
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1.id, payload: w.asaas.confirm(p1.id) });
    await processAsaasEvents(w.deps);
    const dup = await w.asaas.createPayment({ customer: p1.customer, value: "100.00", dueDate: "2026-09-20", externalReference: "odoo:move_line:1001", description: "dup" });
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e2", eventType: "PAYMENT_RECEIVED", asaasPaymentId: dup.id, payload: w.asaas.confirm(dup.id) });
    expect(await processAsaasEvents(w.deps)).toMatchObject({ errors: 1 });
    expect(w.odoo.payments).toHaveLength(1);
    expect((await w.pool.query("select detail from exceptions where type='payment_unmatched' and ref_table='charges'")).rows[0].detail).toMatchObject({ reason: expect.stringContaining("segundo pagamento") });
    await expect(w.pool.query("insert into reconciliations (charge_id, amount_received, amount_expected) values (1,'1.00','1.00')")).rejects.toThrow(/reconciliations_charge_id_uniq/);
  });
  it("dois receivePayment simultâneos na mesma cobrança → 1 pagamento no Odoo", async () => {
    const { w, p1 } = await idaPronta();
    const orig = w.odoo.registerPayment.bind(w.odoo);
    w.deps.odoo.registerPayment = async (p) => { await new Promise((r) => setTimeout(r, 100)); return orig(p); };
    const { receivePayment } = await import("../../src/core/receive.js");
    const live = (await w.asaas.getPayment(p1.id), w.asaas.confirm(p1.id).payment);
    const [a, b] = await Promise.all([receivePayment(w.deps, live, "webhook"), receivePayment(w.deps, live, "reconcile")]);
    expect([a, b].sort()).toEqual(["busy", "received"]);
    expect(w.odoo.payments).toHaveLength(1);
  });
});

describe("U8 — dois workers no mesmo tick", () => {
  it("claim com SKIP LOCKED nas duas filas: nunca o mesmo evento; reserva abandonada expira; touch renova", async () => {
    const w = await fresh();
    for (let i = 0; i < 6; i++) await w.deps.repo.asaasEvents.insert({ asaasEventId: `e${i}`, eventType: "PAYMENT_OVERDUE", asaasPaymentId: `p${i}`, payload: { id: `e${i}`, event: "PAYMENT_OVERDUE", payment: { id: `p${i}`, value: 1 } } });
    for (let i = 0; i < 4; i++) await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: i, odooAction: null, payload: {} });
    const now = w.deps.clock.now();
    const [a, b] = await Promise.all([w.deps.repo.asaasEvents.pending(4, now), w.deps.repo.asaasEvents.pending(4, now)]);
    const ids = [...a, ...b].map((e) => e.id);
    expect(new Set(ids).size).toBe(6); expect(ids).toHaveLength(6);
    const [c, d] = await Promise.all([w.deps.repo.odooEvents.pending(3, now), w.deps.repo.odooEvents.pending(3, now)]);
    expect(new Set([...c, ...d].map((e) => e.id)).size).toBe(4);
    expect(await w.deps.repo.asaasEvents.pending(10, now)).toHaveLength(0);                      // tudo reservado
    const later = new Date(now.getTime() + (CLAIM_TTL_MINUTES + 1) * 60_000);
    await w.deps.repo.asaasEvents.touch(ids[0]!, new Date(later.getTime() - 60_000));         // este ainda está sendo trabalhado
    expect((await w.deps.repo.asaasEvents.pending(10, later)).map((e) => e.id)).not.toContain(ids[0]);
    expect(await w.deps.repo.asaasEvents.pending(10, new Date(later.getTime() + 20 * 60_000))).toHaveLength(6);
  });
  it("scheduler não sobrepõe um job a si mesmo e o diário roda uma vez por dia (persistido)", async () => {
    const w = await fresh({ today: "2026-09-10" });
    let running = 0, max = 0, calls = 0;
    w.deps.asaas.listPayments = async function* () { calls++; running++; max = Math.max(max, running); await new Promise((r) => setTimeout(r, 80)); running--; };
    const timers: Array<() => void> = [];
    const sched = startScheduler(w.deps, { setInterval: ((fn: () => void) => { timers.push(fn); return 0 as never; }) as never, clearInterval: (() => undefined) as never });
    await Promise.all([sched.tick(), sched.tick(), sched.tick()]);   // 3 ticks concorrentes (13h UTC ≥ 09h): um só reconcile
    expect(max).toBe(1); expect(calls).toBe(2);   // RECEIVED + RECEIVED_IN_CASH, uma varredura só
    await sched.tick();                            // já rodou hoje: não roda de novo
    expect(calls).toBe(2);
    await sched.stop();
  });
});

describe("HTTP — o que não pode virar 500", () => {
  it("safeEqual com multibyte não lança; corpo gigante → 413; banco fora → 503 nos webhooks e no /health", async () => {
    expect(safeEqual("x".repeat(31) + "é", "t".repeat(32))).toBe(false);
    expect(safeEqual("t".repeat(32), "t".repeat(32))).toBe(true);
    const w = await fresh();
    const big = w.app();
    expect((await big.request("/webhook-asaas", json({ pad: "x".repeat(300 * 1024) }, { "asaas-access-token": "t".repeat(32) }))).status).toBe(413);
    const dead = { ...w.deps.repo, config: { ...w.deps.repo.config, get: async () => { throw new Error("ECONNREFUSED"); } }, asaasEvents: { ...w.deps.repo.asaasEvents, insert: async () => { throw new Error("ECONNREFUSED"); } } };
    const { createServer } = await import("../../src/app/server.js");
    const app = createServer({ repo: dead as never, asaasWebhookToken: "t".repeat(32), odooWebhookKey: "k".repeat(32), log: () => {} });
    expect((await app.request("/health")).status).toBe(503);
    const h = await app.request("/health"); expect(await h.json()).not.toMatchObject({ error: expect.stringContaining("ECONNREFUSED") });
    expect((await app.request("/webhook-asaas", json({ id: "e1", event: "PAYMENT_RECEIVED", payment: { id: "p", value: 1 } }, { "asaas-access-token": "t".repeat(32) }))).status).toBe(503);
    expect((await app.request(`/webhook-odoo?k=${"k".repeat(32)}`, json({ _model: "account.move", _id: 1 }))).status).toBe(503);
  });
});
