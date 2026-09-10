// Achados da caça-unknowns (TEST-PLAN §3) e do review: cada um vira um teste que fixa o comportamento certo.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { assertMigrated, pendingMigrations } from "../../src/adapters/db/migrations.js";
import { OdooJson2Client } from "../../src/adapters/odoo/client.js";
import { CLAIM_TTL_MINUTES } from "../../src/adapters/db/repo.js";
import { runJob, startScheduler } from "../../src/app/scheduler.js";
import { safeEqual } from "../../src/app/server.js";
import { processAsaasEvents, processOdooEvents, reconcileDaily, syncInvoices } from "../../src/core/index.js";
import { reprocessException } from "../../src/core/usecases/console.js";
import { CNPJ_OK, CPF_OK, KEY, dbReachable, json, seedInvoice, world, type World } from "../helpers.js";

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
    await w.deps.odoo.registerPayment({ moveLineId: 1001, amount: "100.00", paymentDate: "2026-09-10", ref: `asaas:${p1.id}` });   // registrou, mas o motor caiu antes de gravar
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

describe("U6b — vínculo em conflito e isolamento de falha na rede de segurança", () => {
  it("id do pagamento e externalReference apontando para cobranças diferentes → exceção, zero baixa", async () => {
    const w = await fresh(); seedInvoice(w); await syncInvoices(w.deps);
    const p2 = [...w.asaas.payments.values()][1]!;
    w.asaas.confirm(p2.id);
    w.asaas.payments.get(p2.id)!.externalReference = "odoo:move_line:1001";   // referência editada no Asaas aponta pra outra parcela
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "cf1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p2.id, payload: w.asaas.event("PAYMENT_RECEIVED", w.asaas.payments.get(p2.id)!) });
    expect(await processAsaasEvents(w.deps)).toMatchObject({ errors: 1, done: 0 });
    expect(w.odoo.payments).toHaveLength(0);
    expect((await w.pool.query("select detail from exceptions where type='payment_unmatched' and ref_table='asaas_payments'")).rows[0].detail).toMatchObject({ reason: expect.stringContaining("cobranças diferentes"), asaasPaymentId: p2.id });
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("created");
    expect((await w.deps.repo.charges.getByMoveLine(1002))!.status).toBe("created");
  });
  it("reconcile-daily: um pagamento que explode não derruba a varredura (conta em errors, o outro baixa)", async () => {
    const w = await fresh(); seedInvoice(w); await syncInvoices(w.deps);
    const [p1, p2] = [...w.asaas.payments.values()];
    w.asaas.confirm(p1!.id); w.asaas.confirm(p2!.id);
    const real = w.odoo.registerPayment.bind(w.odoo);
    w.deps.odoo.registerPayment = async (p) => { if (p.moveLineId === 1001) throw Object.assign(new Error("odoo 503"), { transient: true }); return real(p); };
    const s = await reconcileDaily(w.deps);
    delete (w.odoo as { registerPayment?: unknown }).registerPayment;
    expect(s).toMatchObject({ ok: true, scanned: 2, received: 1, errors: 1 });
    expect(w.odoo.payments.map((x) => x.moveLineId)).toEqual([1002]);
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("created");
    expect((await w.deps.repo.config.get<{ ok: boolean }>("RECONCILE_LAST"))?.ok).toBe(true);
  });
});

describe("retenção — o purge só apaga o que já foi processado", () => {
  it("reconcile-daily purga trilha e eventos done/ignored antigos, e NUNCA um evento em 'error'", async () => {
    const w = await fresh();
    await w.deps.repo.audit.log({ direction: "asaas_out", endpoint: "GET /payments/:id", responseStatus: 200, durationMs: 12 });
    await w.deps.repo.audit.log({ direction: "odoo_out", endpoint: "account.move.search_read", responseStatus: 200 });
    const done = (await w.deps.repo.asaasEvents.insert({ asaasEventId: "velho-done", eventType: "PAYMENT_OVERDUE", asaasPaymentId: "pay_o", payload: {} }))!;
    const err = (await w.deps.repo.asaasEvents.insert({ asaasEventId: "velho-error", eventType: "PAYMENT_RECEIVED", asaasPaymentId: "pay_e", payload: {} }))!;
    await w.deps.repo.asaasEvents.mark(done, "done");
    await w.deps.repo.asaasEvents.mark(err, "error", { error: "o Odoo estava fora" });
    await w.deps.repo.odooEvents.mark(await w.deps.repo.odooEvents.insert({ odooModel: "res.partner", odooId: 10, odooAction: null, payload: {} }), "ignored");
    await w.pool.query("update audit_log set created_at = now() - interval '200 days' where endpoint like 'GET%'");
    await w.pool.query("update webhook_events set processed_at = now() - interval '200 days'");
    await w.pool.query("update odoo_events set processed_at = now() - interval '200 days'");
    expect(await runJob(w.deps, "reconcile-daily")).toMatchObject({ ok: true, purged: { audit: 1, asaasEvents: 1, odooEvents: 1 } });
    expect((await w.pool.query("select asaas_event_id from webhook_events")).rows.map((r) => r.asaas_event_id)).toEqual(["velho-error"]);
    expect((await w.pool.query("select count(*)::int as n from audit_log")).rows[0].n).toBe(1);   // a trilha recente fica
  });
});

describe("push do Odoo — kill switch na entrada e falha no worker", () => {
  it("webhook-odoo com a ida desligada (ou outro modelo) grava 'ignored' — o worker nem relê a fatura", async () => {
    const w = await fresh({ idaEnabled: false }); seedInvoice(w);
    expect((await w.app().request(`/webhook-odoo?k=${KEY}`, json({ _model: "account.move", _id: 100 }))).status).toBe(200);
    expect((await w.pool.query("select process_status from odoo_events")).rows[0].process_status).toBe("ignored");
    expect(await processOdooEvents(w.deps)).toMatchObject({ done: 0, ignored: 0, errors: 0 });
    expect(w.asaas.payments.size).toBe(0);
    const w2 = await fresh(); seedInvoice(w2);
    await w2.app().request(`/webhook-odoo?k=${KEY}`, json({ _model: "res.partner", _id: 10 }));
    expect((await w2.pool.query("select process_status from odoo_events")).rows[0].process_status).toBe("ignored");
  });
  it("processOdooEvents: transiente volta pra fila; definitivo → 'error' + charge_create_failed que o console reenfileira", async () => {
    const w = await fresh(); seedInvoice(w);
    w.deps.odoo.getInvoice = async () => { throw Object.assign(new Error("odoo 503"), { transient: true }); };
    const id = await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: 100, odooAction: null, payload: {} });
    expect(await processOdooEvents(w.deps)).toMatchObject({ done: 0, errors: 0 });
    expect((await w.pool.query("select process_status, attempts, next_attempt_at from odoo_events where id=$1", [id])).rows[0]).toMatchObject({ process_status: "pending", attempts: 1, next_attempt_at: expect.any(Date) });
    w.deps.odoo.getInvoice = async () => { throw new Error("odoo: 401 api key revogada"); };
    await w.pool.query("update odoo_events set next_attempt_at=null where id=$1", [id]);
    expect(await processOdooEvents(w.deps)).toMatchObject({ errors: 1 });
    expect((await w.pool.query("select process_status from odoo_events where id=$1", [id])).rows[0].process_status).toBe("error");
    const exId = (await w.pool.query("select id from exceptions where type='charge_create_failed' and ref_table='odoo_events'")).rows[0].id;
    delete (w.odoo as { getInvoice?: unknown }).getInvoice;
    expect(await reprocessException(w.deps, exId, "dan")).toMatchObject({ ok: true, action: "odoo_event_requeued" });
    expect(await processOdooEvents(w.deps)).toMatchObject({ done: 1 });
    expect(w.asaas.payments.size).toBe(2);
  });
});

describe("cancelamento não apaga boleto que o cliente já pagou", () => {
  it("fatura cancelada com boleto CONFIRMED no Asaas → reversal_pending e o boleto fica de pé", async () => {
    const w = await fresh(); seedInvoice(w); await syncInvoices(w.deps);
    const [p1, p2] = [...w.asaas.payments.values()];
    w.asaas.setStatus(p1!.id, "CONFIRMED");
    w.odoo.cancelInvoice(100);
    expect(await syncInvoices(w.deps)).toMatchObject({ cancelled: 1, failed: 0 });   // só a parcela 2
    expect(w.asaas.deleted).toEqual([p2!.id]);
    expect((await w.asaas.getPayment(p1!.id))!.deleted).toBe(false);
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("created");
    expect((await w.pool.query("select detail from exceptions where type='reversal_pending'")).rows[0].detail).toMatchObject({ reason: expect.stringContaining("CONFIRMED") });
  });
  it("Asaas recusa o DELETE (definitivo) → charge_create_failed no cancelamento, a varredura segue", async () => {
    const w = await fresh(); seedInvoice(w); await syncInvoices(w.deps);
    w.asaas.deletePayment = async () => { throw new Error("invalid_action: cobrança não pode ser removida"); };
    w.odoo.cancelInvoice(100);
    expect(await syncInvoices(w.deps)).toMatchObject({ cancelled: 0, failed: 2 });
    expect((await w.pool.query("select detail from exceptions where type='charge_create_failed'")).rows[0].detail).toMatchObject({ stage: "cancelamento", invoice: "INV/2026/0001" });
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("created");
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

describe("Red team — o que ficou depois do primeiro lote", () => {
  it("varredura: 201 faturas no mesmo segundo são drenadas por id e o watermark passa do balde", async () => {
    const w = await fresh(); w.odoo.addPartner({ id: 10, name: "X", vat: CPF_OK });
    for (let i = 1; i <= 201; i++) w.odoo.addInvoice({ id: 1000 + i, name: `INV/${i}`, partnerId: 10, writeDate: "2026-09-09 12:00:05", lines: [{ id: 10_000 + i, dateMaturity: "2026-09-20", amount: "1.00" }] });
    w.odoo.addInvoice({ id: 2000, name: "INV/depois", partnerId: 10, writeDate: "2026-09-09 12:00:09", lines: [{ id: 20_000, dateMaturity: "2026-09-20", amount: "1.00" }] });
    const s = await syncInvoices(w.deps, { pageSize: 50 });
    expect(s).toMatchObject({ invoices: 202, created: 202 });
    expect(s.watermark).toEqual({ writeDate: "2026-09-09T12:00:09.000Z", id: 2000 });
    expect((await syncInvoices(w.deps, { pageSize: 50 })).invoices).toBe(0);   // nada re-lido: o balde não gira em círculo
  });
  it("varredura: fatura que o Odoo recusa (5xx) 3 ticks seguidos vira exceção com o id e a varredura segue", async () => {
    const w = await fresh(); w.odoo.addPartner({ id: 10, name: "X", vat: CPF_OK });
    w.odoo.addInvoice({ id: 1, name: "INV/ruim", partnerId: 10, writeDate: "2026-09-09 12:00:01", lines: [{ id: 11, dateMaturity: "2026-09-20", amount: "1.00" }] });
    w.odoo.addInvoice({ id: 2, name: "INV/boa", partnerId: 10, writeDate: "2026-09-09 12:00:02", lines: [{ id: 21, dateMaturity: "2026-09-20", amount: "1.00" }] });
    const orig = w.odoo.getPaymentTermLines.bind(w.odoo);
    w.odoo.getPaymentTermLines = async (id) => { if (id === 1) throw Object.assign(new Error("odoo HTTP 500: MissingError"), { transient: true }); return orig(id); };
    await expect(syncInvoices(w.deps)).rejects.toThrow(/INV\/ruim.*tentativa 1/);
    await expect(syncInvoices(w.deps)).rejects.toThrow(/tentativa 2/);
    expect(await w.deps.repo.watermarks.get("invoices")).toBeNull();
    const s = await syncInvoices(w.deps);
    expect(s).toMatchObject({ skippedBad: 1, created: 1 });
    expect((await w.pool.query("select detail from exceptions where type='charge_create_failed' and ref_table='account.move' and ref_id=1")).rows[0].detail).toMatchObject({ odooId: 1, invoice: "INV/ruim" });
    delete (w.odoo as { getPaymentTermLines?: unknown }).getPaymentTermLines;
  });
  it("PAYMENT_DELETED de boleto vivo é ignorado; boleto adotado com valor diferente vira divergência; cliente existente no Asaas é adotado por CPF", async () => {
    const { w, p1 } = await idaPronta();
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "d", eventType: "PAYMENT_DELETED", asaasPaymentId: p1.id, payload: w.asaas.event("PAYMENT_DELETED", p1) });   // o Asaas ainda tem o boleto vivo
    expect(await processAsaasEvents(w.deps)).toMatchObject({ ignored: 1 });
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("created");
    await w.pool.query("delete from charges where odoo_move_line_id=1002");
    const p2 = [...w.asaas.payments.values()][1]!; w.asaas.setStatus(p2.id, "PENDING", { value: "150.00" });   // alguém mexeu no boleto
    const { handleInvoice } = await import("../../src/core/usecases/handleInvoice.js");
    expect(await handleInvoice(w.deps, (await w.odoo.getInvoice(100))!)).toMatchObject({ created: 0, failed: 1 });
    expect(await w.deps.repo.exceptions.hasOpen("amount_divergent", "account.move.line", 1002)).toBe(true);
    const w2 = await fresh();
    await w2.asaas.createCustomer({ name: "Já existia", cpfCnpj: CNPJ_OK, externalReference: null as unknown as string, notificationDisabled: false });
    seedInvoice(w2); await syncInvoices(w2.deps);
    expect(w2.asaas.customers.size).toBe(1);
  });
  it("reconcile: janela ancorada no último sucesso e passe por cobranças vencidas; baixa manual com boleto pago fecha como ja_baixada", async () => {
    const w = await fresh({ today: "2026-10-30" }); seedInvoice(w); await syncInvoices(w.deps);
    const [p1, p2] = [...w.asaas.payments.values()];
    w.asaas.confirm(p1!.id, { paymentDate: "2026-09-25" });                       // pago fora de qualquer janela de 3 dias, webhook perdido
    await w.deps.repo.config.set("RECONCILE_LAST", { ok: true, at: "2026-09-27T09:00:00.000Z", from: "2026-09-24" });
    const s = await reconcileDaily(w.deps);
    expect(s.from).toBe("2026-09-24"); expect(s.received).toBe(1);           // janela cresceu até o último sucesso
    w.asaas.confirm(p2!.id, { paymentDate: "2026-08-01" });                       // data retroativa: só o passe por cobrança vencida pega
    const s2 = await reconcileDaily(w.deps);
    expect(s2).toMatchObject({ overdueChecked: 1, received: 1 });
    expect(w.odoo.payments).toHaveLength(2);
    // baixa manual no Odoo com boleto já pago no Asaas: não é estorno, é conciliação
    const w3 = await fresh(); seedInvoice(w3); await syncInvoices(w3.deps);
    const q1 = [...w3.asaas.payments.values()][0]!; w3.asaas.confirm(q1.id);
    await w3.odoo.registerPayment({ moveLineId: 1001, amount: "100.00", paymentDate: "2026-09-10" }); w3.odoo.invoices.get(100)!.writeDate = w3.odoo.stamp();
    await syncInvoices(w3.deps);
    expect((await w3.deps.repo.charges.getByMoveLine(1001))!.status).toBe("received");
    expect(await w3.deps.repo.exceptions.hasOpen("reversal_pending")).toBe(false);
  });
  it("insert que viola outro unique (asaas_payment_id) lança em vez de sumir em silêncio", async () => {
    const { w, p1 } = await idaPronta();
    await expect(w.deps.repo.charges.insert({ odooMoveId: 9, odooMoveLineId: 9, odooPartnerId: 10, asaasPaymentId: p1.id, externalRef: "odoo:move_line:9", amount: "1.00", dueDate: "2026-09-20", status: "created", bankSlipUrl: null, invoiceName: null, nossoNumero: null, asaasInvoiceNumber: null })).rejects.toThrow(/asaas_payment_id/);
    expect(await w.deps.repo.charges.insert({ odooMoveId: 100, odooMoveLineId: 1001, odooPartnerId: 10, asaasPaymentId: null, externalRef: "x", amount: "1.00", dueDate: "2026-09-20", status: "created", bankSlipUrl: null, invoiceName: null, nossoNumero: null, asaasInvoiceNumber: null })).toBeNull();
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
