import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createConsoleQueries } from "../../src/adapters/db/console.js";
import { createPool } from "../../src/adapters/db/pool.js";
import { createConsoleApi } from "../../src/app/console.js";
import { createServer } from "../../src/app/server.js";
import { processAsaasEvents, syncInvoices } from "../../src/core/index.js";
import { CNPJ_OK, DB_URL, dbReachable, world, type World } from "../helpers.js";

let w: World; let pool: ReturnType<typeof createPool>;
const TOKEN = "c".repeat(40);
beforeAll(async () => { if (!(await dbReachable())) throw new Error("Postgres local fora do ar"); });
afterEach(async () => { await pool?.end(); await w?.close(); });

async function setup() {
  w = await world(); pool = createPool(DB_URL);
  w.odoo.addPartner({ id: 10, name: "Cliente Um Ltda", vat: CNPJ_OK });
  w.odoo.addInvoice({ id: 100, name: "INV/2026/0001", partnerId: 10, lines: [{ id: 1001, dateMaturity: "2026-09-01", amount: "100.00" }, { id: 1002, dateMaturity: "2026-09-25", amount: "100.00" }] });
  await syncInvoices(w.deps);
  const api = createConsoleApi({ deps: w.deps, queries: createConsoleQueries(pool), token: TOKEN });
  const app = createServer({ repo: w.deps.repo, asaasWebhookToken: "t".repeat(32), odooWebhookKey: "k".repeat(32), log: () => {}, console: api });
  const call = async (path: string, init: RequestInit = {}, token = TOKEN) => {
    const res = await app.request(`/api/v1${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-user": "dan", ...(init.headers ?? {}) } });
    return { status: res.status, body: await res.json() as any };
  };
  return { app, call };
}

describe("console API", () => {
  it("auth: 401 com token errado, 503 sem CONSOLE_TOKEN", async () => {
    const { call } = await setup();
    expect((await call("/charges", {}, "errado")).status).toBe(401);
    const off = createServer({ repo: w.deps.repo, asaasWebhookToken: "t".repeat(32), odooWebhookKey: "k".repeat(32), log: () => {}, console: createConsoleApi({ deps: w.deps, queries: createConsoleQueries(pool), token: null }) });
    expect((await off.request("/api/v1/charges", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(503);
  });
  it("cobranças: lista com cliente, filtros e busca; detalhe com eventos e conciliação; aging", async () => {
    const { call } = await setup();
    const all = await call("/charges");
    expect(all.body.total).toBe(2);
    expect(all.body.data[0]).toMatchObject({ invoiceName: "INV/2026/0001", status: "created", customer: { name: "Cliente Um Ltda", cpfCnpj: CNPJ_OK }, received: null, openExceptions: 0 });
    expect(all.body.data[0].bankSlipUrl).toMatch(/^https:/);
    expect((await call("/charges?due_to=2026-09-10")).body.total).toBe(1);
    expect((await call("/charges?q=INV/2026")).body.total).toBe(2);
    expect((await call("/charges?status=received")).body.total).toBe(0);
    const [p1] = [...w.asaas.payments.values()];
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1!.id, payload: w.asaas.confirm(p1!.id) });
    await processAsaasEvents(w.deps);
    const det = await call(`/charges/${all.body.data[0].id}`);
    expect(det.body).toMatchObject({ status: "received", received: { amountReceived: "100.00", diffPolicy: null } });
    expect(det.body.events).toHaveLength(1);
    expect(det.body.reconciliations).toHaveLength(1);
    const dash = await call("/dashboard");                                     // hoje = 2026-09-10: parcela 2 (25/09) a vencer
    expect(dash.body.aging.find((b: any) => b.bucket === "a_vencer")).toMatchObject({ count: 1, amount: "100.00" });
  });
  it("exceções: lista com cobrança junta; resolver/ignorar; reprocessar reenfileira o evento e a baixa acontece", async () => {
    const { call } = await setup();
    // pagamento de uma parcela que ainda não existia → unmatched
    const orphan = { id: "evt_o", event: "PAYMENT_RECEIVED", dateCreated: "", payment: { id: "pay_o", value: 100, status: "RECEIVED", externalReference: "odoo:move_line:1002", paymentDate: "2026-09-09" } };
    // apaga a charge 1002 pra simular: o boleto foi criado fora do motor e a cobrança do motor "não existe"
    await pool.query("delete from charges where odoo_move_line_id=1002");
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "evt_o", eventType: "PAYMENT_RECEIVED", asaasPaymentId: "pay_o", payload: orphan });
    await processAsaasEvents(w.deps);
    const list = await call("/exceptions?status=open");
    expect(list.body.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ type: "payment_unmatched", status: "open", charge: null });
    const exId = list.body.data[0].id;
    // financeiro cria a cobrança faltante (aqui: a varredura recria a parcela 1002) e reprocessa
    await pool.query("update sync_watermarks set last_write_date='2020-01-01'");
    await syncInvoices(w.deps);
    const re = await call(`/exceptions/${exId}/reprocess`, { method: "POST" });
    expect(re.body).toMatchObject({ ok: true, action: "asaas_event_requeued" });
    await processAsaasEvents(w.deps);
    expect((await call(`/exceptions/${exId}`)).body.status).toBe("resolved");
    expect((await call("/charges?status=received")).body.total).toBe(1);
    // ignorar/resolver manual
    await w.deps.repo.exceptions.open({ type: "stale_heartbeat", refTable: "webhook_events" });
    const ex2 = (await call("/exceptions?status=open")).body.data[0].id;
    expect((await call(`/exceptions/${ex2}/ignore`, { method: "POST" })).body).toMatchObject({ ok: true, action: "ignored" });
    expect((await call(`/exceptions/${ex2}`)).body).toMatchObject({ status: "ignored", resolvedBy: "dan" });
    expect((await call(`/exceptions/999/resolve`, { method: "POST" })).status).toBe(400);
  });
  it("write-off: juros do Asaas → writeoff_needed → financeiro aceita → baixa com diff_policy juros_multa", async () => {
    const { call } = await setup();
    const [p1] = [...w.asaas.payments.values()];
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "j1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1!.id, payload: w.asaas.confirm(p1!.id, { interest: "3.10" }) });
    await processAsaasEvents(w.deps);
    const ex = (await call("/exceptions?type=writeoff_needed")).body.data[0];
    expect(ex.charge).toMatchObject({ invoiceName: "INV/2026/0001", customerName: "Cliente Um Ltda" });
    const r = await call(`/exceptions/${ex.id}/accept-writeoff`, { method: "POST" });
    expect(r.body).toMatchObject({ ok: true, action: "writeoff_accepted" });
    const det = await call(`/charges/${ex.charge.id}`);
    expect(det.body.received).toMatchObject({ amountReceived: "103.10", diffPolicy: "juros_multa" });
    expect(w.odoo.payments[0]).toMatchObject({ amount: "103.10" });
  });
  it("cliente sem documento: corrigido no Odoo → reprocessar sincroniza e cria as cobranças", async () => {
    w = await world(); pool = createPool(DB_URL);
    w.odoo.addPartner({ id: 20, name: "Sem Doc", vat: null });
    w.odoo.addInvoice({ id: 200, name: "INV/2026/0002", partnerId: 20, lines: [{ id: 2001, dateMaturity: "2026-09-30", amount: "50.00" }] });
    await syncInvoices(w.deps);
    const api = createConsoleApi({ deps: w.deps, queries: createConsoleQueries(pool), token: TOKEN });
    const ex = (await api.request("/exceptions?status=open", { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.json()) as any).data[0];
    expect(ex.type).toBe("customer_missing_document");
    w.odoo.partners.get(20)!.vat = "529.982.247-25";
    const r = await api.request(`/exceptions/${ex.id}/reprocess`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } }).then((x) => x.json()) as any;
    expect(r).toMatchObject({ ok: true, action: "customer_synced", detail: { chargesCreated: 1 } });
    expect(w.asaas.payments.size).toBe(1);
  });
  it("config: gates R1 (IDA_ENABLED) e R3 (notificações) pelo console; chave desconhecida é recusada", async () => {
    const { call } = await setup();
    expect((await call("/config")).body).toMatchObject({ IDA_ENABLED: true, TOLERANCE_BRL: "0.01" });
    expect((await call("/config/IDA_ENABLED", { method: "PUT", body: JSON.stringify({ value: false }) })).body.ok).toBe(true);
    expect((await call("/config")).body.IDA_ENABLED).toBe(false);
    expect((await call("/config/IDA_ENABLED", { method: "PUT", body: JSON.stringify({ value: "sim" }) })).status).toBe(400);
    expect((await call("/config/ASAAS_API_KEY", { method: "PUT", body: JSON.stringify({ value: "x" }) })).status).toBe(400);
    expect((await call("/config/GO_LIVE_CUTOFF_DATE", { method: "PUT", body: JSON.stringify({ value: "2026-10-01" }) })).body.ok).toBe(true);
    expect([...w.asaas.customers.values()][0]!.notificationDisabled).toBe(true);
    expect((await call("/customers/enable-notifications", { method: "POST" })).body).toEqual({ updated: 1, failed: 0 });
    expect([...w.asaas.customers.values()][0]!.notificationDisabled).toBe(false);
    const h = await call("/health-report");
    expect(h.body).toMatchObject({ idaEnabled: false, openCharges: 2, webhook: { id: null } });
    expect(h.body.lastSync).toMatchObject({ created: 2 });
  });
});
