// Ciclo inteiro contra Postgres real + Odoo/Asaas em memória. É a suíte que vira E2E quando trocamos os fakes pelos reais.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { processAsaasEvents, processOdooEvents, reconcileDaily, syncInvoices, watchdog } from "../../src/core/index.js";
import { CNPJ_OK, CPF_OK, KEY, TOKEN, dbReachable, json, seedInvoice, world, type World } from "../helpers.js";

const opened: World[] = [];
async function fresh(o: Parameters<typeof world>[0] = {}): Promise<World> { const w = await world(o); opened.push(w); return w; }
beforeAll(async () => { if (!(await dbReachable())) throw new Error("banco de teste fora do ar — rode `npm run db:reset` (cria motor_test) ou `npm run db:migrate:test`"); });
afterEach(async () => { for (const w of opened.splice(0)) await w.close(); });

describe("ida: fatura postada → 1 boleto por parcela", () => {
  it("cria cobranças, cliente com notificações OFF, idempotente e avança o watermark (write_date, id)", async () => {
    const w = await fresh(); seedInvoice(w);
    const s1 = await syncInvoices(w.deps);
    expect(s1).toMatchObject({ enabled: true, invoices: 1, created: 2, failed: 0, blocked: 0 });
    expect(s1.watermark).toEqual({ writeDate: expect.stringMatching(/Z$/), id: 100 });
    expect([...w.asaas.customers.values()][0]).toMatchObject({ cpfCnpj: CNPJ_OK, externalReference: "odoo:partner:10", notificationDisabled: true });
    const pays = [...w.asaas.payments.values()];
    expect(pays.map((p) => p.externalReference).sort()).toEqual(["odoo:move_line:1001", "odoo:move_line:1002"]);
    expect(pays[0]!.value).toBe("100.00");
    expect((await syncInvoices(w.deps))).toMatchObject({ invoices: 0, created: 0 });   // nada novo: idempotente
    expect(w.asaas.payments.size).toBe(2);
  });
  it("kill switch IDA_ENABLED=false → não cria nada (nem pelo push já enfileirado)", async () => {
    const w = await fresh({ idaEnabled: false }); seedInvoice(w);
    expect(await syncInvoices(w.deps)).toMatchObject({ enabled: false, created: 0 });
    await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: 100, odooAction: null, payload: {} });   // pending, mas a ida está desligada
    await processOdooEvents(w.deps);
    expect(w.asaas.payments.size).toBe(0);
  });
  it("cliente sem CPF/CNPJ → 0 cobranças, exceção customer_missing_document, e o watermark AVANÇA (a exceção rastreia)", async () => {
    const w = await fresh(); seedInvoice(w, { vat: null });
    const s = await syncInvoices(w.deps);
    expect(s).toMatchObject({ created: 0, blocked: 2, failed: 0 });
    expect(w.asaas.payments.size).toBe(0);
    expect(await w.deps.repo.exceptions.hasOpen("customer_missing_document", "customers_map", 10)).toBe(true);
    expect(s.watermark?.id).toBe(100);
    await syncInvoices(w.deps);   // segunda varredura não duplica a exceção
    expect((await w.pool.query("select count(*)::int as n from exceptions")).rows[0].n).toBe(1);
  });
  it("parceiro inexistente no Odoo → exceção, não silêncio", async () => {
    const w = await fresh();
    w.odoo.addInvoice({ id: 100, name: "INV/1", partnerId: 77, lines: [{ id: 1001, dateMaturity: "2026-09-20", amount: "100.00" }] });
    expect(await syncInvoices(w.deps)).toMatchObject({ blocked: 1 });
    expect(await w.deps.repo.exceptions.hasOpen("customer_missing_document", "customers_map", 77)).toBe(true);
  });
  it("GO_LIVE_CUTOFF_DATE ignora estoque antigo", async () => {
    const w = await fresh(); await w.deps.repo.config.set("GO_LIVE_CUTOFF_DATE", "2026-09-05");
    w.odoo.addPartner({ id: 10, name: "X", vat: CPF_OK });
    w.odoo.addInvoice({ id: 1, name: "OLD", partnerId: 10, invoiceDate: "2026-08-01", lines: [{ id: 11, dateMaturity: "2026-09-20", amount: "10.00" }] });
    w.odoo.addInvoice({ id: 2, name: "NEW", partnerId: 10, invoiceDate: "2026-09-06", lines: [{ id: 21, dateMaturity: "2026-09-20", amount: "20.00" }] });
    expect((await syncInvoices(w.deps)).created).toBe(1);
    expect([...w.asaas.payments.values()][0]!.externalReference).toBe("odoo:move_line:21");
  });
  it("Asaas recusa a cobrança (definitivo) → charge_create_failed com odooId, watermark avança; 5xx → aborta e vira integration_error", async () => {
    const w = await fresh(); seedInvoice(w);
    w.asaas.createPayment = async () => { throw new Error("invalid_action: cpfCnpj inválido"); };
    const s = await syncInvoices(w.deps);
    expect(s).toMatchObject({ created: 0, failed: 2 }); expect(s.watermark?.id).toBe(100);
    const ex = (await w.pool.query("select detail from exceptions where type='charge_create_failed' and ref_id=1001")).rows[0];
    expect(ex.detail).toMatchObject({ odooId: 100, moveLineId: 1001 });
    const w2 = await fresh(); seedInvoice(w2);
    w2.asaas.createPayment = async () => { throw Object.assign(new Error("asaas 503"), { transient: true }); };
    await expect(syncInvoices(w2.deps)).rejects.toThrow(/503/);
    expect(await w2.deps.repo.watermarks.get("invoices")).toBeNull();
  });
  it("fatura cancelada no Odoo → boleto apagado no Asaas; se já recebido → reversal_pending; boleto pago no Asaas não é apagado", async () => {
    const w = await fresh(); seedInvoice(w);
    await syncInvoices(w.deps);
    const [p1] = [...w.asaas.payments.values()];
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "evt_a", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1!.id, payload: w.asaas.confirm(p1!.id) });
    await processAsaasEvents(w.deps);
    w.odoo.cancelInvoice(100);
    const s = await syncInvoices(w.deps);
    expect(s.cancelled).toBe(1);
    expect(w.asaas.deleted.length).toBe(1);
    expect(await w.deps.repo.exceptions.hasOpen("reversal_pending", "charges")).toBe(true);
  });
  it("push do Odoo (webhook-odoo) faz o mesmo caminho; 404 sem token; corpo inválido → 400; repetido não duplica; outro modelo é ignorado", async () => {
    const w = await fresh(); seedInvoice(w);
    const app = w.app();
    expect((await app.request("/webhook-odoo?k=errado", json({ _model: "account.move", _id: 100 }))).status).toBe(404);
    for (const bad of [{ _model: "account.move", _id: "100" }, { _model: "account.move", _id: 1.5 }, null, [1], "{{{"]) expect((await app.request(`/webhook-odoo?k=${KEY}`, json(bad))).status, JSON.stringify(bad)).toBe(400);
    expect((await app.request(`/webhook-odoo?k=${KEY}`, json({ _model: "account.move", _id: 100, _action: "Salvei · fatura postada(#7)" }))).status).toBe(200);
    expect(await processOdooEvents(w.deps)).toMatchObject({ done: 1 });
    expect(w.asaas.payments.size).toBe(2);
    await app.request(`/webhook-odoo?k=${KEY}`, json({ _model: "account.move", _id: 100 }));
    await app.request(`/webhook-odoo?k=${KEY}`, json({ _model: "account.move", _id: 4242 }));   // fatura inexistente
    await app.request(`/webhook-odoo?k=${KEY}`, json({ _model: "res.partner", _id: 10 }));      // outro modelo: ignorado na entrada
    expect(await processOdooEvents(w.deps)).toMatchObject({ done: 1, ignored: 1 });
    expect(w.asaas.payments.size).toBe(2);
  });
  it("corrida push × varredura na mesma fatura → 1 boleto só (lock por fatura + adoção por externalReference)", async () => {
    const w = await fresh(); const inv = seedInvoice(w);
    const orig = w.asaas.createPayment.bind(w.asaas);
    w.asaas.createPayment = async (p) => { await new Promise((r) => setTimeout(r, 120)); return orig(p); };
    const { handleInvoice } = await import("../../src/core/usecases/handleInvoice.js");
    const [a, b] = await Promise.all([handleInvoice(w.deps, inv), handleInvoice(w.deps, inv)]);
    expect(w.asaas.payments.size).toBe(2);   // 2 parcelas, 1 boleto cada
    expect(a.created + b.created).toBe(2); expect(a.busy || b.busy).toBe(true);
    expect(await w.deps.repo.exceptions.hasOpen("charge_create_failed")).toBe(false);
    // crash entre criar no Asaas e gravar local: o boleto já existe por externalReference → adotado, não duplicado
    await w.pool.query("delete from charges where odoo_move_line_id=1002");
    expect((await handleInvoice(w.deps, inv)).created).toBe(1);
    expect(w.asaas.payments.size).toBe(2);
  });
  it("fatura resetada e re-postada com linhas novas → boletos antigos cancelados, novos criados; baixa manual no Odoo → boleto cancelado", async () => {
    const w = await fresh(); seedInvoice(w); await syncInvoices(w.deps);
    w.odoo.resetToDraft(100);
    expect((await syncInvoices(w.deps)).cancelled).toBe(2);
    w.odoo.repost(100, [{ id: 2001, dateMaturity: "2026-09-25", amount: "200.00" }]);
    const s = await syncInvoices(w.deps);
    expect(s.created).toBe(1);
    expect([...w.asaas.payments.values()].filter((p) => !p.deleted).map((p) => p.externalReference)).toEqual(["odoo:move_line:2001"]);
    // financeiro baixou a parcela por fora, no Odoo: o boleto vivo é cancelado
    await w.odoo.registerPayment({ moveLineId: 2001, amount: "200.00", paymentDate: "2026-09-11" });
    expect((await syncInvoices(w.deps)).cancelled).toBe(1);
    expect((await w.deps.repo.charges.getByMoveLine(2001))!.status).toBe("cancelled");
    // re-postar com as MESMAS linhas depois de cancelada: cobrança cancelada volta a viver com boleto novo
    const w2 = await fresh(); seedInvoice(w2); await syncInvoices(w2.deps);
    w2.odoo.resetToDraft(100); await syncInvoices(w2.deps); w2.odoo.repost(100); 
    expect((await syncInvoices(w2.deps)).created).toBe(2);
    expect((await w2.deps.repo.charges.getByMoveLine(1001))!.status).toBe("created");
  });
  it("parcela alterada no Odoo depois do boleto → amount_divergent (o boleto não muda sozinho)", async () => {
    const w = await fresh(); seedInvoice(w); await syncInvoices(w.deps);
    w.odoo.lines.get(1002)!.amountResidual = "150.00"; w.odoo.invoices.get(100)!.writeDate = w.odoo.stamp();   // no Odoo, mexer na linha avança o write_date da fatura
    await syncInvoices(w.deps);
    expect((await w.pool.query("select detail from exceptions where type='amount_divergent'")).rows[0].detail).toMatchObject({ stage: "ida", residual: "150.00", expected: "100.00" });
  });
  it("watermark avança com write_date no formato do Odoo e pagina", async () => {
    const w = await fresh(); w.odoo.addPartner({ id: 10, name: "X", vat: CPF_OK });
    for (let i = 1; i <= 5; i++) w.odoo.addInvoice({ id: i, name: `INV/${i}`, partnerId: 10, writeDate: "2026-09-09 12:00:05", lines: [{ id: 10 * i, dateMaturity: "2026-09-20", amount: "1.00" }] });
    const { ODOO_PAGE_SIZE } = await import("../../src/core/limits.js");
    const s1 = await syncInvoices(w.deps);
    expect(s1).toMatchObject({ invoices: 5, created: 5, pages: ODOO_PAGE_SIZE >= 5 ? 1 : expect.any(Number) });
    expect(s1.watermark).toEqual({ writeDate: "2026-09-09T12:00:05.000Z", id: 5 });   // mesmo write_date: desempate por id
    w.odoo.addInvoice({ id: 6, name: "INV/6", partnerId: 10, writeDate: "2026-09-09 12:00:09", lines: [{ id: 60, dateMaturity: "2026-09-20", amount: "1.00" }] });
    const s2 = await syncInvoices(w.deps);
    expect(s2).toMatchObject({ invoices: 1, created: 1 }); expect(s2.watermark).toEqual({ writeDate: "2026-09-09T12:00:09.000Z", id: 6 });
  });
});

describe("volta: webhook do Asaas → baixa na parcela exata", () => {
  async function idaPronta() { const w = await fresh(); seedInvoice(w); await syncInvoices(w.deps); return { w, pays: [...w.asaas.payments.values()] }; }
  const post = (w: World, body: unknown, token = TOKEN) => w.app().request("/webhook-asaas", json(body, { "asaas-access-token": token }));

  it("CONFIRMED → confirmed; RECEIVED → baixa 1× (duplicata 0×); malformado/campo novo/valor lixo → 200; parcela 2 continua aberta", async () => {
    const { w, pays: [p1] } = await idaPronta();
    expect((await post(w, {}, "errado")).status).toBe(401);
    expect((await post(w, w.asaas.event("PAYMENT_CONFIRMED", w.asaas.setStatus(p1!.id, "CONFIRMED")))).status).toBe(200);
    const received = w.asaas.confirm(p1!.id);
    expect((await post(w, received)).status).toBe(200);
    expect((await post(w, received)).status).toBe(200);                          // duplicata
    expect((await post(w, { ...received, campoNovo: { x: 1 } })).status).toBe(200); // campo desconhecido (mesmo id → dedupe)
    expect((await post(w, "{{{ não é json")).status).toBe(200);                   // malformado: ainda 200
    expect((await post(w, { id: "evt_lixo", event: "PAYMENT_RECEIVED", payment: { id: "pay_x", value: "abc" } })).status).toBe(200);   // valor lixo: 200 também
    expect((await w.pool.query("select count(*)::int as n from webhook_events where event_type='UNPARSEABLE' and process_status='error'")).rows[0].n).toBe(2);
    expect(await w.deps.repo.exceptions.hasOpen("integration_error", "webhook_events")).toBe(true);
    const r = await processAsaasEvents(w.deps);
    expect(r).toMatchObject({ done: 2, ignored: 0, errors: 0 });
    expect(w.odoo.payments).toHaveLength(1);
    expect(w.odoo.payments[0]).toMatchObject({ moveLineId: 1001, amount: "100.00", paymentDate: "2026-09-10" });
    expect(w.odoo.invoices.get(100)!.paymentState).toBe("partial");
    expect(await w.deps.repo.charges.getByMoveLine(1001)).toMatchObject({ status: "received", nossoNumero: p1!.nossoNumero });
    expect((await w.deps.repo.charges.getByMoveLine(1002))!.status).toBe("created");
  });
  it("evento forjado (pagamento que o Asaas não conhece, ou não recebido) → nenhuma baixa", async () => {
    const { w, pays: [p1] } = await idaPronta();
    await post(w, { id: "evt_forjado", event: "PAYMENT_RECEIVED", payment: { id: "pay_forjado", value: 100, status: "RECEIVED", externalReference: "odoo:move_line:1001" } });
    await post(w, { ...w.asaas.event("PAYMENT_RECEIVED", { ...p1!, status: "RECEIVED" }) });   // o evento diz RECEIVED, mas no Asaas está PENDING
    expect(await processAsaasEvents(w.deps)).toMatchObject({ done: 1, errors: 1 });
    expect(w.odoo.payments).toHaveLength(0);
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("created");
    expect(await w.deps.repo.exceptions.hasOpen("payment_unmatched", "webhook_events")).toBe(true);
  });
  it("divergência acima da tolerância → 0 baixas + exceção; juros do Asaas → writeoff_needed", async () => {
    const { w, pays: [p1, p2] } = await idaPronta();
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1!.id, payload: w.asaas.confirm(p1!.id, { value: "90.00" }) });
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e2", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p2!.id, payload: w.asaas.confirm(p2!.id, { interest: "2.50" }) });
    await processAsaasEvents(w.deps);
    expect(w.odoo.payments).toHaveLength(0);
    expect(await w.deps.repo.exceptions.hasOpen("amount_divergent", "charges")).toBe(true);
    expect(await w.deps.repo.exceptions.hasOpen("writeoff_needed", "charges")).toBe(true);
  });
  it("pagamento com nossa referência sem cobrança → payment_unmatched (erro); referência alheia → ignorado", async () => {
    const w = await fresh();
    const cust = await w.asaas.createCustomer({ name: "x", cpfCnpj: CPF_OK, externalReference: "odoo:partner:1", notificationDisabled: true });
    const ours = await w.asaas.createPayment({ customer: cust.id, value: "10.00", dueDate: "2026-09-20", externalReference: "odoo:move_line:999", description: "x" });
    const alien = await w.asaas.createPayment({ customer: cust.id, value: "10.00", dueDate: "2026-09-20", externalReference: "manual-123", description: "x" });
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "a", eventType: "PAYMENT_RECEIVED", asaasPaymentId: ours.id, payload: w.asaas.confirm(ours.id) });
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "b", eventType: "PAYMENT_RECEIVED", asaasPaymentId: alien.id, payload: w.asaas.confirm(alien.id) });
    expect(await processAsaasEvents(w.deps)).toMatchObject({ errors: 1, ignored: 1 });
    expect(await w.deps.repo.exceptions.hasOpen("payment_unmatched")).toBe(true);
  });
  it("DELETED cancela; RESTORED reabre; REFUNDED após baixa → reversal_pending (estorno é manual); transições são atômicas", async () => {
    const { w, pays: [p1, p2] } = await idaPronta();
    const ins = (id: string, ev: string, p: NonNullable<typeof p1>) => w.deps.repo.asaasEvents.insert({ asaasEventId: id, eventType: ev, asaasPaymentId: p.id, payload: w.asaas.event(ev, p) });
    await w.asaas.deletePayment(p2!.id); await ins("d1", "PAYMENT_DELETED", p2!); await processAsaasEvents(w.deps);
    expect((await w.deps.repo.charges.getByMoveLine(1002))!.status).toBe("cancelled");
    await ins("r1", "PAYMENT_RESTORED", w.asaas.setStatus(p2!.id, "PENDING", { deleted: false })); await processAsaasEvents(w.deps);
    expect((await w.deps.repo.charges.getByMoveLine(1002))!.status).toBe("created");
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "rc", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1!.id, payload: w.asaas.confirm(p1!.id) });
    await processAsaasEvents(w.deps);
    await ins("rf", "PAYMENT_REFUNDED", w.asaas.setStatus(p1!.id, "REFUNDED")); await processAsaasEvents(w.deps);
    expect(await w.deps.repo.exceptions.hasOpen("reversal_pending", "charges")).toBe(true);
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("received");
    // um DELETED atrasado nunca regride uma cobrança recebida
    await ins("late", "PAYMENT_DELETED", w.asaas.setStatus(p1!.id, "RECEIVED", { deleted: true })); await processAsaasEvents(w.deps);
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("received");
  });
  it("PAYMENT_UPDATED com valor/vencimento diferente → amount_divergent com asaasPaymentId (reprocessável); evento desconhecido → ignored", async () => {
    const { w, pays: [p1] } = await idaPronta();
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "u1", eventType: "PAYMENT_UPDATED", asaasPaymentId: p1!.id, payload: w.asaas.event("PAYMENT_UPDATED", w.asaas.setStatus(p1!.id, "PENDING", { dueDate: "2026-12-01" })) });
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "x1", eventType: "PAYMENT_FOO", asaasPaymentId: p1!.id, payload: w.asaas.event("PAYMENT_FOO", p1!) });
    expect(await processAsaasEvents(w.deps)).toMatchObject({ done: 1, ignored: 1 });
    expect((await w.pool.query("select detail from exceptions where type='amount_divergent'")).rows[0].detail).toMatchObject({ asaasPaymentId: p1!.id, dueDate: "2026-12-01" });
  });
});

describe("redes de segurança", () => {
  it("reconcile-daily baixa o que o webhook perdeu (inclusive 'em dinheiro'), não duplica, e um erro não derruba os outros", async () => {
    const w = await fresh(); seedInvoice(w); await syncInvoices(w.deps);
    const [p1, p2] = [...w.asaas.payments.values()];
    w.asaas.confirm(p1!.id, { paymentDate: "2026-09-09", inCash: true });   // webhook "perdido", recebido em dinheiro
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "ok", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p2!.id, payload: w.asaas.confirm(p2!.id, { paymentDate: "2026-09-09" }) });
    await processAsaasEvents(w.deps);
    const s = await reconcileDaily(w.deps);
    expect(s).toMatchObject({ ok: true, scanned: 2, received: 1, already: 1, errors: 0 });
    expect(w.odoo.payments).toHaveLength(2);
    expect(w.odoo.invoices.get(100)!.paymentState).toBe("in_payment");
    expect((await w.pool.query("select diff_policy from reconciliations where charge_id=1")).rows[0].diff_policy).toBe("in_cash");
    expect((await w.deps.repo.config.get<{ ok: boolean }>("RECONCILE_LAST"))?.ok).toBe(true);
  });
  it("watchdog: fila interrompida → exceção + reativação (1×/h); penalidades subindo → webhook_penalized", async () => {
    const w = await fresh();
    const wh = await w.asaas.createWebhook({ name: "Salvei", url: "https://x/webhook-asaas", email: "f@sdc.com.br", authToken: TOKEN, events: ["PAYMENT_RECEIVED"] });
    await w.deps.repo.config.set("ASAAS_WEBHOOK_ID", wh.id);
    w.asaas.interrupt(wh.id, 15);
    expect(await watchdog(w.deps)).toMatchObject({ interrupted: true, reactivated: true, penalizedDelta: 15 });
    expect((await w.asaas.getWebhook(wh.id))!.interrupted).toBe(false);
    expect(await w.deps.repo.exceptions.hasOpen("queue_interrupted")).toBe(true);
    expect(await w.deps.repo.exceptions.hasOpen("webhook_penalized")).toBe(true);
    w.asaas.interrupt(wh.id, 0);
    expect(await watchdog(w.deps)).toMatchObject({ interrupted: true, reactivated: false, penalizedDelta: 0 }); // < 1h: não reativa
    expect((await w.pool.query("select count(*)::int as n from exceptions where type='queue_interrupted'")).rows[0].n).toBe(1);
  });
  it("watchdog: silêncio > 8h em horário comercial com cobranças abertas → stale_heartbeat; evento fresco → não; key velha → api_key_expiring", async () => {
    const w = await fresh({ today: "2026-09-14" }); seedInvoice(w); await syncInvoices(w.deps);   // seg 10h BRT, muito depois do received_at real
    expect((await watchdog(w.deps)).staleHeartbeat).toBe(true);
    expect(await w.deps.repo.exceptions.hasOpen("stale_heartbeat")).toBe(true);
    const w2 = await fresh({ today: "2026-09-14" }); seedInvoice(w2); await syncInvoices(w2.deps);
    await w2.pool.query("insert into webhook_events (asaas_event_id, event_type, payload, received_at) values ('f','PAYMENT_OVERDUE','{}', $1)", [w2.deps.clock.now()]);
    await w2.deps.repo.config.set("ODOO_API_KEY_CREATED_AT", "2026-06-20T00:00:00.000Z");   // 86 dias
    const s = await watchdog(w2.deps);
    expect(s.staleHeartbeat).toBe(false); expect(s.apiKeyDays).toBe(86);
    expect(await w2.deps.repo.exceptions.hasOpen("api_key_expiring")).toBe(true);
  });
  it("RLS: role sem policy lê 0 linhas mesmo com GRANT", async () => {
    const w = await fresh(); seedInvoice(w); await syncInvoices(w.deps);
    const c = await w.pool.connect();
    try {
      await c.query("do $$ begin if not exists (select 1 from pg_roles where rolname='anon_test') then create role anon_test nologin; end if; end $$");
      await c.query("grant select on all tables in schema public to anon_test");
      await c.query("set role anon_test");
      expect((await c.query("select count(*)::int as n from charges")).rows[0].n).toBe(0);
    } finally { await c.query("reset role"); await c.query("revoke all on all tables in schema public from anon_test"); c.release(); }
  });
});
