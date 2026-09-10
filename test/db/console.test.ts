import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { processAsaasEvents, syncInvoices } from "../../src/core/index.js";
import { CNPJ_OK, dbReachable, world, type World } from "../helpers.js";
import { createConsoleApi } from "../../src/app/console.js";
import { createConsoleQueries } from "../../src/adapters/db/console.js";
import { createServer } from "../../src/app/server.js";

const opened: World[] = [];
async function fresh(): Promise<World> { const w = await world(); opened.push(w); return w; }
beforeAll(async () => { if (!(await dbReachable())) throw new Error("banco de teste fora do ar"); });
afterEach(async () => { for (const w of opened.splice(0)) await w.close(); });

async function setup() {
  const w = await fresh();
  w.odoo.addPartner({ id: 10, name: "Cliente Um Ltda", vat: CNPJ_OK });
  w.odoo.addInvoice({ id: 100, name: "INV/2026/0001", partnerId: 10, lines: [{ id: 1001, dateMaturity: "2026-09-01", amount: "100.00" }, { id: 1002, dateMaturity: "2026-09-25", amount: "100.00" }] });
  await syncInvoices(w.deps);
  return w;
}

describe("console API", () => {
  it("auth: 401 com token errado; 503 sem CONSOLE_TOKEN; 404 JSON em rota inexistente", async () => {
    const w = await setup();
    expect((await w.api("/charges", {}, "errado")).status).toBe(401);
    const off = createServer({ repo: w.deps.repo, asaasWebhookToken: "t".repeat(32), odooWebhookKey: "k".repeat(32), log: () => {}, console: createConsoleApi({ deps: w.deps, queries: createConsoleQueries(w.pool), token: null }) });
    expect((await off.request("/api/v1/charges", { headers: { authorization: "Bearer x" } })).status).toBe(503);
    const nf = await w.api("/nada");
    expect(nf.status).toBe(404); expect(nf.body).toMatchObject({ ok: false, code: "not_found" });
  });
  it("entrada inválida → 400 JSON, nunca 500: limit/offset/id/partner/due_from/status/q/body", async () => {
    const w = await setup();
    for (const p of ["/charges?limit=abc", "/charges?limit=0", "/charges?limit=1000", "/charges?offset=-1", "/charges?offset=1e300", "/charges?partner=abc", "/charges?due_from=garbage", "/charges?due_to=2026-99-99", "/charges?status=opened", "/exceptions?status=bogus", "/exceptions?type=x", "/exceptions/abc", "/exceptions/1.5", "/charges/abc", `/charges?q=${"x".repeat(101)}`]) {
      const r = await w.api(p);
      expect(r.status, p).toBe(400); expect(r.body, p).toMatchObject({ ok: false, code: "invalid_input" });
    }
    expect((await w.api("/exceptions/abc/resolve", { method: "POST" })).status).toBe(400);
    for (const body of ["null", "[1]", '"x"', "{{{"]) expect((await w.api("/config/IDA_ENABLED", { method: "PUT", body })).status, body).toBe(400);
  });
  it("cobranças: lista com cliente, filtros e busca (% e _ são literais); detalhe com eventos e conciliação; aging", async () => {
    const w = await setup();
    const all = await w.api("/charges");
    expect(all.body).toMatchObject({ total: 2, limit: 50, offset: 0 });
    expect(all.body.data[0]).toMatchObject({ invoiceName: "INV/2026/0001", status: "created", customer: { name: "Cliente Um Ltda", cpfCnpj: CNPJ_OK }, received: null, openExceptions: 0 });
    expect(all.body.data[0].bankSlipUrl).toMatch(/^https:/);
    expect((await w.api("/charges?due_to=2026-09-10")).body.total).toBe(1);
    expect((await w.api("/charges?q=INV/2026")).body.total).toBe(2);
    expect((await w.api("/charges?q=%")).body.total).toBe(0);
    expect((await w.api("/charges?status=received")).body.total).toBe(0);
    expect((await w.api("/charges?status=created,confirmed&limit=1&offset=1")).body).toMatchObject({ total: 2, limit: 1, offset: 1 });
    const [p1] = [...w.asaas.payments.values()];
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "e1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1!.id, payload: w.asaas.confirm(p1!.id) });
    await processAsaasEvents(w.deps);
    const det = await w.api(`/charges/${all.body.data[0].id}`);
    expect(det.body).toMatchObject({ status: "received", received: { amountReceived: "100.00", diffPolicy: null } });
    expect(det.body.events[0]).toMatchObject({ asaasEventId: "e1", processStatus: "done" });
    expect(det.body.reconciliations[0]).toMatchObject({ amountReceived: "100.00", diff: "0.00" });
    expect((await w.api("/dashboard")).body.aging.find((b: any) => b.bucket === "a_vencer")).toMatchObject({ count: 1, amount: "100.00" });
  });
  it("exceções: lista com cobrança junta; resolver/ignorar (409 se já fechada, 404 se não existe); reprocessar reenfileira e a baixa acontece", async () => {
    const w = await setup();
    await w.pool.query("delete from charges where odoo_move_line_id=1002");   // simula: o boleto foi criado fora do motor
    const orphan = [...w.asaas.payments.values()].find((p) => p.externalReference === "odoo:move_line:1002")!;
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "evt_o", eventType: "PAYMENT_RECEIVED", asaasPaymentId: orphan.id, payload: w.asaas.confirm(orphan.id) });
    await processAsaasEvents(w.deps);
    const list = await w.api("/exceptions?status=open");
    expect(list.body.total).toBe(1);
    expect(list.body.data[0]).toMatchObject({ type: "payment_unmatched", status: "open", charge: null });
    const exId = list.body.data[0].id;
    await w.pool.query("update sync_watermarks set last_write_date='2020-01-01', last_id=0");   // a varredura recria a parcela 1002 (adotando o boleto)
    await syncInvoices(w.deps);
    expect((await w.api(`/exceptions/${exId}/reprocess`, { method: "POST" })).body).toMatchObject({ ok: true, action: "asaas_event_requeued" });
    await processAsaasEvents(w.deps);
    expect((await w.api(`/exceptions/${exId}`)).body.status).toBe("resolved");
    expect((await w.api("/charges?status=received")).body.total).toBe(1);
    const again = await w.api(`/exceptions/${exId}/reprocess`, { method: "POST" });
    expect(again.status).toBe(409); expect(again.body.code).toBe("invalid_state");
    await w.deps.repo.exceptions.open({ type: "stale_heartbeat", refTable: "webhook_events" });
    const ex2 = (await w.api("/exceptions?status=open")).body.data[0].id;
    expect((await w.api(`/exceptions/${ex2}/ignore`, { method: "POST" })).body).toMatchObject({ ok: true, action: "ignored" });
    expect((await w.api(`/exceptions/${ex2}`)).body).toMatchObject({ status: "ignored", resolvedBy: "dan" });
    expect((await w.api(`/exceptions/999999/resolve`, { method: "POST" })).status).toBe(404);
  });
  it("write-off: juros do Asaas → writeoff_needed → financeiro aceita → baixa com diff_policy juros_multa; pagamento estornado → 409", async () => {
    const w = await setup();
    const [p1, p2] = [...w.asaas.payments.values()];
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "j1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1!.id, payload: w.asaas.confirm(p1!.id, { interest: "3.10" }) });
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "j2", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p2!.id, payload: w.asaas.confirm(p2!.id, { interest: "1.00" }) });
    await processAsaasEvents(w.deps);
    const exs = (await w.api("/exceptions?type=writeoff_needed")).body.data;
    expect(exs).toHaveLength(2);
    const ex1 = exs.find((e: any) => e.charge.id === 1), ex2 = exs.find((e: any) => e.charge.id === 2);
    expect(ex1.charge).toMatchObject({ invoiceName: "INV/2026/0001", customerName: "Cliente Um Ltda" });
    expect((await w.api(`/exceptions/${ex1.id}/accept-writeoff`, { method: "POST" })).body).toMatchObject({ ok: true, action: "writeoff_accepted" });
    expect((await w.api(`/charges/1`)).body.received).toMatchObject({ amountReceived: "103.10", diffPolicy: "juros_multa" });
    expect(w.odoo.payments[0]).toMatchObject({ amount: "103.10" });
    w.asaas.setStatus(p2!.id, "REFUNDED");
    const r = await w.api(`/exceptions/${ex2.id}/accept-writeoff`, { method: "POST" });
    expect(r.status).toBe(409); expect(w.odoo.payments).toHaveLength(1);
    expect((await w.api(`/exceptions/${(await w.api("/exceptions?type=amount_divergent")).body.data[0]?.id ?? 999999}/accept-writeoff`, { method: "POST" })).status).toBe(404);
  });
  it("cliente sem documento: corrigido no Odoo → reprocessar sincroniza só as faturas dele e cria as cobranças", async () => {
    const w = await fresh();
    w.odoo.addPartner({ id: 20, name: "Sem Doc", vat: null });
    w.odoo.addPartner({ id: 30, name: "Outro", vat: CNPJ_OK });
    w.odoo.addInvoice({ id: 200, name: "INV/2026/0002", partnerId: 20, lines: [{ id: 2001, dateMaturity: "2026-09-30", amount: "50.00" }] });
    w.odoo.addInvoice({ id: 300, name: "INV/2026/0003", partnerId: 30, lines: [{ id: 3001, dateMaturity: "2026-09-30", amount: "70.00" }] });
    await syncInvoices(w.deps);
    const ex = (await w.api("/exceptions?status=open")).body.data[0];
    expect(ex.type).toBe("customer_missing_document");
    w.odoo.partners.get(20)!.vat = "529.982.247-25";
    const r = await w.api(`/exceptions/${ex.id}/reprocess`, { method: "POST" });
    expect(r.body).toMatchObject({ ok: true, action: "customer_synced", detail: { invoicesProcessed: 1, chargesCreated: 1 } });
    expect([...w.asaas.payments.values()].map((p) => p.externalReference).sort()).toEqual(["odoo:move_line:2001", "odoo:move_line:3001"]);
  });
  it("reprocessar: charge_create_failed relê a fatura pelo odooId; sem fatura conhecida e tipo sem reprocesso → 409", async () => {
    const w = await fresh();
    w.odoo.addPartner({ id: 10, name: "Cliente Um Ltda", vat: CNPJ_OK });
    w.odoo.addInvoice({ id: 100, name: "INV/2026/0001", partnerId: 10, lines: [{ id: 1001, dateMaturity: "2026-09-25", amount: "100.00" }] });
    const real = w.asaas.createPayment.bind(w.asaas);
    w.asaas.createPayment = async () => { throw new Error("invalid_action: cpfCnpj inválido"); };
    await syncInvoices(w.deps);
    const ex = (await w.api("/exceptions?type=charge_create_failed")).body.data[0];
    expect(ex.detail).toMatchObject({ odooId: 100, moveLineId: 1001 });
    w.asaas.createPayment = real;
    expect((await w.api(`/exceptions/${ex.id}/reprocess`, { method: "POST" })).body).toMatchObject({ ok: true, action: "invoice_reprocessed", detail: { created: 1 } });
    expect((await w.api(`/exceptions/${ex.id}`)).body.status).toBe("resolved");
    expect([...w.asaas.payments.values()][0]!.externalReference).toBe("odoo:move_line:1001");
    await w.deps.repo.exceptions.open({ type: "charge_create_failed", refTable: "account.move.line", refId: 999 });   // sem odooId no detail
    await w.deps.repo.exceptions.open({ type: "stale_heartbeat", refTable: "webhook_events" });
    for (const [type, re] of [["charge_create_failed", /não sei qual fatura/], ["stale_heartbeat", /não tem reprocessamento automático/]] as const) {
      const alvo = (await w.api(`/exceptions?type=${type}&status=open`)).body.data[0];
      const r = await w.api(`/exceptions/${alvo.id}/reprocess`, { method: "POST" });
      expect(r.status, type).toBe(409); expect(r.body.error, type).toMatch(re);
      expect((await w.api(`/exceptions/${alvo.id}`)).body.status).toBe("open");   // falhou: não resolve sozinha
    }
  });
  it("reprocessar: queue_interrupted reativa a fila no Asaas; sem ASAAS_WEBHOOK_ID → 500 config", async () => {
    const w = await fresh();
    const wh = await w.asaas.createWebhook({ name: "Salvei", url: "https://x/webhook-asaas", email: "financeiro@exemplo.com.br", authToken: "t".repeat(32), events: ["PAYMENT_RECEIVED"] });
    w.asaas.interrupt(wh.id, 3);
    await w.deps.repo.exceptions.open({ type: "queue_interrupted", refTable: "asaas_webhooks", detail: { webhookId: wh.id } });
    const ex = (await w.api("/exceptions?type=queue_interrupted")).body.data[0];
    const semId = await w.api(`/exceptions/${ex.id}/reprocess`, { method: "POST" });
    expect(semId.status).toBe(500); expect(semId.body.code).toBe("config");
    await w.deps.repo.config.set("ASAAS_WEBHOOK_ID", wh.id);
    expect((await w.api(`/exceptions/${ex.id}/reprocess`, { method: "POST" })).body).toMatchObject({ ok: true, action: "webhook_reactivated" });
    expect((await w.asaas.getWebhook(wh.id))!.interrupted).toBe(false);
    expect((await w.api(`/exceptions/${ex.id}`)).body).toMatchObject({ status: "resolved", resolvedBy: "dan" });
  });
  it("aceitar write-off: exceção de outro tipo → 409; pagamento que sumiu do Asaas → 502, sem baixa", async () => {
    const w = await setup();
    const [p1, p2] = [...w.asaas.payments.values()];
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "d1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p1!.id, payload: w.asaas.confirm(p1!.id, { value: "50.00" }) });
    await w.deps.repo.asaasEvents.insert({ asaasEventId: "j2", eventType: "PAYMENT_RECEIVED", asaasPaymentId: p2!.id, payload: w.asaas.confirm(p2!.id, { interest: "5.00" }) });
    await processAsaasEvents(w.deps);
    const div = (await w.api("/exceptions?type=amount_divergent")).body.data[0];
    const r = await w.api(`/exceptions/${div.id}/accept-writeoff`, { method: "POST" });
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/writeoff_needed/);
    const wo = (await w.api("/exceptions?type=writeoff_needed")).body.data[0];
    w.asaas.payments.delete(p2!.id);   // pagamento apagado no Asaas entre a exceção e o clique
    const up = await w.api(`/exceptions/${wo.id}/accept-writeoff`, { method: "POST" });
    expect(up.status).toBe(502); expect(up.body.code).toBe("upstream");
    expect(w.odoo.payments).toHaveLength(0);
    expect((await w.api(`/exceptions/${wo.id}`)).body.status).toBe("open");
  });
  it("cliente ainda sem CPF/CNPJ válido → reprocessar devolve 409 e a exceção continua aberta", async () => {
    const w = await fresh();
    w.odoo.addPartner({ id: 20, name: "Sem Doc", vat: "123" });
    w.odoo.addInvoice({ id: 200, name: "INV/2026/0002", partnerId: 20, lines: [{ id: 2001, dateMaturity: "2026-09-30", amount: "50.00" }] });
    await syncInvoices(w.deps);
    const ex = (await w.api("/exceptions?type=customer_missing_document")).body.data[0];
    const r = await w.api(`/exceptions/${ex.id}/reprocess`, { method: "POST" });
    expect(r.status).toBe(409); expect(r.body.error).toMatch(/continua sem CPF\/CNPJ/);
    expect((await w.api(`/exceptions/${ex.id}`)).body.status).toBe("open");
    expect(w.asaas.payments.size).toBe(0);
  });
  it("x-user é sanitizado antes de virar resolved_by — nunca vai cru pro banco", async () => {
    const w = await fresh();
    for (const [header, esperado] of [["fer<script>alert(1)</script>@exemplo.com.br", "ferscriptalert1script@exemplo.com.br"], ["'; drop table charges; --", "droptablecharges--"], ["«»", "console"], ["f".repeat(80), "f".repeat(64)]] as const) {
      await w.deps.repo.exceptions.open({ type: "stale_heartbeat", refTable: "webhook_events", detail: { header } });
      const ex = (await w.api("/exceptions?status=open")).body.data[0];
      await w.api(`/exceptions/${ex.id}/resolve`, { method: "POST", headers: { "x-user": header } });
      expect((await w.api(`/exceptions/${ex.id}`)).body.resolvedBy, header).toBe(esperado);
    }
    expect((await w.pool.query("select count(*)::int as n from charges")).rows[0].n).toBe(0);
  });
  it("health-report não quebra com o Asaas fora; enable-notifications com falha parcial → 502", async () => {
    const w = await setup();
    await w.deps.repo.config.set("ASAAS_WEBHOOK_ID", "wh_sumiu");
    await w.deps.repo.config.set("ODOO_API_KEY_CREATED_AT", "2026-06-20T00:00:00.000Z");
    w.asaas.getWebhook = async () => { throw new Error("asaas 503"); };
    expect((await w.api("/jobs/watchdog", { method: "POST" })).status).toBe(502);   // cron externo: job que falha devolve 502 e vira integration_error
    const h = await w.api("/health-report");
    expect(h.status).toBe(200);
    expect(h.body).toMatchObject({ webhook: { id: "wh_sumiu", interrupted: null, penalizedRequestsCount: null }, odooApiKeyAgeDays: 82, openCharges: 2 });
    w.asaas.updateCustomer = async () => { throw new Error("asaas 500"); };
    const r = await w.api("/customers/enable-notifications", { method: "POST" });
    expect(r.status).toBe(502); expect(r.body.error).toMatch(/falharam 1/);
    expect(await w.deps.repo.config.get("NOTIFICATIONS_ENABLED")).toBe(true);   // a política fica ligada; o retry é da ação
  });
  it("config: gates R1 (IDA_ENABLED) e R3 (notificações como política); validação por chave; health-report", async () => {
    const w = await setup();
    expect((await w.api("/config")).body).toMatchObject({ IDA_ENABLED: true, TOLERANCE_BRL: "0.01", RECONCILE_LOOKBACK_DAYS: 3 });
    for (const [k, v, st] of [["IDA_ENABLED", false, 200], ["IDA_ENABLED", "sim", 400], ["TOLERANCE_BRL", "0.50", 200], ["TOLERANCE_BRL", "0,50", 400], ["TOLERANCE_BRL", "9.00", 400], ["JUROS_MULTA_AUTO", true, 200], ["GO_LIVE_CUTOFF_DATE", null, 200], ["GO_LIVE_CUTOFF_DATE", "2026-99-99", 400], ["RECONCILE_LOOKBACK_DAYS", 7, 200], ["RECONCILE_LOOKBACK_DAYS", 0, 400], ["ASAAS_API_KEY", "x", 400]] as const) {
      expect((await w.api(`/config/${k}`, { method: "PUT", body: JSON.stringify({ value: v }) })).status, `${k}=${JSON.stringify(v)}`).toBe(st);
    }
    expect((await w.api("/config")).body).toMatchObject({ IDA_ENABLED: false, TOLERANCE_BRL: "0.50", RECONCILE_LOOKBACK_DAYS: 7, GO_LIVE_CUTOFF_DATE: null });
    // guard do red team: ligar a ida sem data de corte emitiria boleto pro histórico inteiro
    expect((await w.api("/config/IDA_ENABLED", { method: "PUT", body: JSON.stringify({ value: true }) })).status).toBe(409);
    expect((await w.api("/config/GO_LIVE_CUTOFF_DATE", { method: "PUT", body: JSON.stringify({ value: "2026-01-01" }) })).status).toBe(200);
    expect((await w.api("/config/IDA_ENABLED", { method: "PUT", body: JSON.stringify({ value: true }) })).status).toBe(200);
    expect((await w.api("/config/GO_LIVE_CUTOFF_DATE", { method: "PUT", body: JSON.stringify({ value: null }) })).status).toBe(409);
    expect([...w.asaas.customers.values()][0]!.notificationDisabled).toBe(true);
    expect((await w.api("/customers/enable-notifications", { method: "POST" })).body).toMatchObject({ ok: true, action: "notifications_enabled", detail: { updated: 1, failed: 0 } });
    expect([...w.asaas.customers.values()][0]!.notificationDisabled).toBe(false);
    // política: cliente novo depois do gate já nasce com notificações ligadas
    w.odoo.addPartner({ id: 11, name: "Novo", vat: "529.982.247-25" }); w.odoo.addInvoice({ id: 101, name: "INV/2", partnerId: 11, lines: [{ id: 1101, dateMaturity: "2026-10-01", amount: "5.00" }] });   // CPF distinto: mesmo CNPJ seria adotado como o cliente 10
    await syncInvoices(w.deps);
    expect([...w.asaas.customers.values()].find((c) => c.externalReference === "odoo:partner:11")!.notificationDisabled).toBe(false);
    // cron externo: POST /jobs/:name roda com o mesmo guard; desconhecido → 404
    expect((await w.api("/jobs/watchdog", { method: "POST" })).body).toMatchObject({ ok: true, action: "job:watchdog" });
    expect((await w.api("/jobs/nada", { method: "POST" })).status).toBe(404);
    const h = await w.api("/health-report");
    expect(h.body).toMatchObject({ idaEnabled: true, notificationsEnabled: true, openCharges: 3, webhook: { id: null } });
    expect(h.body.lastSync).toMatchObject({ ok: true, created: 1 });
  });
});
