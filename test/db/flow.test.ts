// Ciclo inteiro contra Postgres real + Odoo/Asaas em memória. É a suíte que vira E2E quando trocamos os fakes pelos reais.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../../src/app/server.js";
import { processAsaasEvents, processOdooEvents, reconcileDaily, syncInvoices, watchdog } from "../../src/core/index.js";
import { CNPJ_OK, CPF_OK, dbReachable, world, type World } from "../helpers.js";

let w: World;
beforeAll(async () => { if (!(await dbReachable())) throw new Error("Postgres local fora do ar — rode `npm run db:up && npm run db:migrate`"); });
afterEach(async () => { await w?.close(); });

async function seedInvoice(o: { lines?: Array<{ id: number; dateMaturity: string; amount: string }>; vat?: string | null } = {}) {
  w.odoo.addPartner({ id: 10, name: "Cliente Um Ltda", vat: o.vat === undefined ? CNPJ_OK : o.vat, email: "fin@um.com" });
  return w.odoo.addInvoice({ id: 100, name: "INV/2026/0001", partnerId: 10, lines: o.lines ?? [{ id: 1001, dateMaturity: "2026-09-20", amount: "100.00" }, { id: 1002, dateMaturity: "2026-10-20", amount: "100.00" }] });
}
const TOKEN = "t".repeat(32), KEY = "k".repeat(32);
const server = () => createServer({ repo: w.deps.repo, asaasWebhookToken: TOKEN, odooWebhookKey: KEY, log: () => {} });
const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

describe("ida: fatura postada → 1 boleto por parcela", () => {
  it("cria cobranças, cliente com notificações OFF, idempotente e avança o watermark", async () => {
    w = await world(); await seedInvoice();
    const s1 = await syncInvoices(w.deps);
    expect(s1).toMatchObject({ enabled: true, invoices: 1, created: 2, failed: 0 });
    expect(s1.watermark).not.toBeNull();
    const cust = [...w.asaas.customers.values()][0]!;
    expect(cust).toMatchObject({ cpfCnpj: CNPJ_OK, externalReference: "odoo:partner:10", notificationDisabled: true });
    const pays = [...w.asaas.payments.values()];
    expect(pays.map((p) => p.externalReference).sort()).toEqual(["odoo:move_line:1001", "odoo:move_line:1002"]);
    expect(pays[0]!.value).toBe("100.00");
    const s2 = await syncInvoices(w.deps);                       // nada novo: idempotente
    expect(s2).toMatchObject({ invoices: 0, created: 0 });
    expect(w.asaas.payments.size).toBe(2);
  });
  it("kill switch IDA_ENABLED=false → não cria nada", async () => {
    w = await world({ idaEnabled: false }); await seedInvoice();
    expect(await syncInvoices(w.deps)).toMatchObject({ enabled: false, created: 0 });
    expect(w.asaas.payments.size).toBe(0);
  });
  it("cliente sem CPF/CNPJ → 0 cobranças + exceção customer_missing_document; lote com falha não avança o watermark", async () => {
    w = await world(); await seedInvoice({ vat: null });
    const s = await syncInvoices(w.deps);
    expect(s).toMatchObject({ created: 0, failed: 2 });
    expect(w.asaas.payments.size).toBe(0);
    expect(await w.deps.repo.exceptions.hasOpen("customer_missing_document", "customers_map", 10)).toBe(true);
    expect(s.watermark).toBeNull();
  });
  it("GO_LIVE_CUTOFF_DATE ignora estoque antigo", async () => {
    w = await world(); await w.deps.repo.config.set("GO_LIVE_CUTOFF_DATE", "2026-09-05");
    w.odoo.addPartner({ id: 10, name: "X", vat: CPF_OK });
    w.odoo.addInvoice({ id: 1, name: "OLD", partnerId: 10, invoiceDate: "2026-08-01", lines: [{ id: 11, dateMaturity: "2026-09-20", amount: "10.00" }] });
    w.odoo.addInvoice({ id: 2, name: "NEW", partnerId: 10, invoiceDate: "2026-09-06", lines: [{ id: 21, dateMaturity: "2026-09-20", amount: "20.00" }] });
    expect((await syncInvoices(w.deps)).created).toBe(1);
    expect([...w.asaas.payments.values()][0]!.externalReference).toBe("odoo:move_line:21");
  });
  it("fatura cancelada no Odoo → cobrança apagada no Asaas; se já recebida → reversal_pending", async () => {
    w = await world(); await seedInvoice();
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
  it("push do Odoo (webhook-odoo) faz o mesmo caminho; 404 sem token; POST repetido não duplica", async () => {
    w = await world(); await seedInvoice();
    const app = server();
    expect((await app.request("/webhook-odoo?k=errado", json({ _model: "account.move", _id: 100 }))).status).toBe(404);
    expect((await app.request(`/webhook-odoo?k=${KEY}`, json({ _model: "account.move", _id: "100" }))).status).toBe(400);
    expect((await app.request(`/webhook-odoo?k=${KEY}`, json({ _model: "account.move", _id: 100, _action: "Salvei · fatura postada(#7)" }))).status).toBe(200);
    expect(await processOdooEvents(w.deps)).toMatchObject({ done: 1 });
    expect(w.asaas.payments.size).toBe(2);
    await app.request(`/webhook-odoo?k=${KEY}`, json({ _model: "account.move", _id: 100 }));
    await app.request(`/webhook-odoo?k=${KEY}`, json({ _model: "account.move", _id: 4242 }));   // fatura inexistente
    expect(await processOdooEvents(w.deps)).toMatchObject({ done: 1, ignored: 1 });
    expect(w.asaas.payments.size).toBe(2);
  });
});

describe("volta: webhook do Asaas → baixa na parcela exata", () => {
  async function idaPronta() {
    w = await world(); await seedInvoice(); await syncInvoices(w.deps);
    return [...w.asaas.payments.values()];
  }
  const post = (app: ReturnType<typeof createServer>, body: unknown, token = TOKEN) => app.request("/webhook-asaas", json(body, { "asaas-access-token": token }));

  it("CONFIRMED → confirmed; RECEIVED → baixa 1× (duplicata 0×); malformado/campo novo → 200; parcela 2 continua aberta", async () => {
    const [p1] = await idaPronta();
    const app = server();
    expect((await post(app, {}, "errado")).status).toBe(401);
    expect((await post(app, w.asaas.event("PAYMENT_CONFIRMED", { ...p1!, status: "CONFIRMED" }))).status).toBe(200);
    const received = w.asaas.confirm(p1!.id);
    expect((await post(app, received)).status).toBe(200);
    expect((await post(app, received)).status).toBe(200);                          // duplicata
    expect((await post(app, { ...received, campoNovo: { x: 1 } })).status).toBe(200); // campo desconhecido (mesmo id → dedupe)
    expect((await post(app, "{{{ não é json")).status).toBe(200);                   // malformado: ainda 200
    const r = await processAsaasEvents(w.deps);
    expect(r).toMatchObject({ done: 2, ignored: 0, errors: 0 });
    expect(w.odoo.payments).toHaveLength(1);
    expect(w.odoo.payments[0]).toMatchObject({ moveLineId: 1001, amount: "100.00", paymentDate: "2026-09-10" });
    expect(w.odoo.invoices.get(100)!.paymentState).toBe("partial");
    expect(await w.deps.repo.charges.getByMoveLine(1001)).toMatchObject({ status: "received", nossoNumero: p1!.nossoNumero });
    expect((await w.deps.repo.charges.getByMoveLine(1002))!.status).toBe("created");
  });
  it("divergência acima da tolerância → 0 baixas + exceção; juros do Asaas → writeoff_needed", async () => {
    const [p1, p2] = await idaPronta();
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1!.id, payload: w.asaas.confirm(p1!.id, { value: "90.00" }) });
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e2", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p2!.id, payload: w.asaas.confirm(p2!.id, { interest: "2.50" }) });
    await processAsaasEvents(w.deps);
    expect(w.odoo.payments).toHaveLength(0);
    expect(await w.deps.repo.exceptions.hasOpen("amount_divergent", "charges")).toBe(true);
    expect(await w.deps.repo.exceptions.hasOpen("writeoff_needed", "charges")).toBe(true);
  });
  it("pagamento sem cobrança nossa → payment_unmatched e evento em erro", async () => {
    w = await world();
    const orphan = { id: "evt_o", event: "PAYMENT_RECEIVED", dateCreated: "", payment: { id: "pay_orphan", value: 10, status: "RECEIVED", externalReference: "odoo:move_line:999" } };
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "evt_o", eventType: "PAYMENT_RECEIVED", asaasPaymentId: "pay_orphan", payload: orphan });
    expect(await processAsaasEvents(w.deps)).toMatchObject({ errors: 1 });
    expect(await w.deps.repo.exceptions.hasOpen("payment_unmatched")).toBe(true);
  });
  it("DELETED cancela; RESTORED reabre; REFUNDED após baixa → reversal_pending (estorno é manual)", async () => {
    const [p1, p2] = await idaPronta();
    const ins = (id: string, ev: string, p: typeof p1) => w.deps.repo.asaasEvents.insert({ asaasEventId: id, eventType: ev, asaasPaymentId: p!.id, payload: w.asaas.event(ev, p!) });
    await ins("d1", "PAYMENT_DELETED", p2); await processAsaasEvents(w.deps);
    expect((await w.deps.repo.charges.getByMoveLine(1002))!.status).toBe("cancelled");
    await ins("r1", "PAYMENT_RESTORED", p2); await processAsaasEvents(w.deps);
    expect((await w.deps.repo.charges.getByMoveLine(1002))!.status).toBe("created");
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "rc", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1!.id, payload: w.asaas.confirm(p1!.id) });
    await processAsaasEvents(w.deps);
    await ins("rf", "PAYMENT_REFUNDED", { ...p1!, status: "REFUNDED" }); await processAsaasEvents(w.deps);
    expect(await w.deps.repo.exceptions.hasOpen("reversal_pending", "charges")).toBe(true);
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("received");
  });
});

describe("redes de segurança", () => {
  it("reconcile-daily baixa um pagamento cujo webhook foi perdido, e não duplica o que já baixou", async () => {
    w = await world(); await seedInvoice(); await syncInvoices(w.deps);
    const [p1, p2] = [...w.asaas.payments.values()];
    w.asaas.confirm(p1!.id, { paymentDate: "2026-09-09" });                // webhook "perdido"
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "ok", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p2!.id, payload: w.asaas.confirm(p2!.id, { paymentDate: "2026-09-09" }) });
    await processAsaasEvents(w.deps);
    const s = await reconcileDaily(w.deps);
    expect(s).toMatchObject({ scanned: 2, received: 1, already: 1 });
    expect(w.odoo.payments).toHaveLength(2);
    expect(w.odoo.invoices.get(100)!.paymentState).toBe("in_payment");
  });
  it("watchdog: fila interrompida → exceção + reativação (1×/h); penalidades subindo → webhook_penalized", async () => {
    w = await world();
    const wh = await w.asaas.createWebhook({ name: "Salvei", url: "https://x/webhook-asaas", email: "f@sdc.com.br", authToken: TOKEN, events: ["PAYMENT_RECEIVED"] });
    await w.deps.repo.config.set("ASAAS_WEBHOOK_ID", wh.id);
    w.asaas.interrupt(wh.id, 15);
    const s1 = await watchdog(w.deps);
    expect(s1).toMatchObject({ interrupted: true, reactivated: true, penalizedDelta: 15 });
    expect((await w.asaas.getWebhook(wh.id))!.interrupted).toBe(false);
    expect(await w.deps.repo.exceptions.hasOpen("queue_interrupted")).toBe(true);
    expect(await w.deps.repo.exceptions.hasOpen("webhook_penalized")).toBe(true);
    w.asaas.interrupt(wh.id, 0);
    expect(await watchdog(w.deps)).toMatchObject({ interrupted: true, reactivated: false, penalizedDelta: 0 }); // < 1h: não reativa
  });
  it("watchdog: silêncio > 8h em horário comercial com cobranças abertas → stale_heartbeat", async () => {
    w = await world(); await seedInvoice(); await syncInvoices(w.deps);
    expect((await watchdog(w.deps)).staleHeartbeat).toBe(true);
    expect(await w.deps.repo.exceptions.hasOpen("stale_heartbeat")).toBe(true);
  });
  it("RLS: role sem policy lê 0 linhas mesmo com GRANT", async () => {
    w = await world(); await seedInvoice(); await syncInvoices(w.deps);
    const { createPool } = await import("../../src/adapters/db/pool.js");
    const pool = createPool(process.env.DATABASE_URL ?? "postgres://motor:motor@localhost:55432/motor");
    const c = await pool.connect();
    try {
      await c.query("do $$ begin if not exists (select 1 from pg_roles where rolname='anon_test') then create role anon_test nologin; end if; end $$");
      await c.query("grant select on all tables in schema public to anon_test");
      await c.query("set role anon_test");
      const r = await c.query("select count(*)::int as n from charges");
      expect(r.rows[0].n).toBe(0);
    } finally { await c.query("reset role"); c.release(); await pool.end(); }
  });
});
