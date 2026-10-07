// Probes P1–P4 do pivô Itaú, rodando PELA PORTA neutra (deps.gateway), contra Postgres real.
// P1/P2 com o Asaas atrás da porta; P3/P4 nos dois gateways (Asaas e Itaú stub).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ItauClient } from "../../src/adapters/itau/config.js";
import { ItauGateway } from "../../src/adapters/itau/gateway.js";
import { processAsaasEvents, setConsoleConfig, syncInvoices } from "../../src/core/index.js";
import { dbReachable, seedInvoice, world, type World } from "../helpers.js";
import { gerarPki, type Pki } from "../itau-fixtures.js";

const opened: World[] = [];
async function fresh(o: Parameters<typeof world>[0] = {}): Promise<World> { const w = await world(o); opened.push(w); return w; }
let pki: Pki;
beforeAll(async () => {
  if (!(await dbReachable())) throw new Error("banco de teste fora do ar — rode `npm run db:migrate:test`");
  pki = gerarPki();
});
afterEach(async () => { for (const w of opened.splice(0)) await w.close(); });
afterAll(() => pki?.cleanup());

/** Mesmo mundo, com o Itaú (stub) atrás da porta. O transporte injetado conta chamadas de rede. */
function comItau(w: World) {
  const rede = { chamadas: 0 };
  const transport = async () => { rede.chamadas++; return { status: 500, body: "", headers: {} }; };
  const client = new ItauClient({ clientId: "cid", clientSecret: "s", tokenUrl: "https://127.0.0.1:1/t", cert: pki.clientCert, key: pki.clientKey, extraCa: null }, { transport });
  return { deps: { ...w.deps, gateway: new ItauGateway(client) }, rede };
}

async function emitirELiquidar(w: World, o: { value?: string } = {}) {
  seedInvoice(w);
  await syncInvoices(w.deps);
  const c = (await w.deps.repo.charges.getByMoveLine(1001))!;
  const ev = w.asaas.confirm(c.asaasPaymentId!, o);
  return { c, ev };
}

describe("probes do gateway (porta neutra)", () => {
  it("P1: aviso repetido do gateway → 1 baixa só, memo asaas:<pay_id> idempotente", async () => {
    const w = await fresh();
    const { c, ev } = await emitirELiquidar(w);
    // O mesmo aviso chega 3 vezes: 1 com o mesmo id (dedupe no insert) e 2 com ids novos (reentrega).
    expect(await w.deps.repo.asaasEvents.insert({ asaasEventId: ev.id, eventType: ev.event, asaasPaymentId: c.asaasPaymentId, payload: ev })).not.toBeNull();
    expect(await w.deps.repo.asaasEvents.insert({ asaasEventId: ev.id, eventType: ev.event, asaasPaymentId: c.asaasPaymentId, payload: ev })).toBeNull();
    for (const id of ["evt_reentrega_1", "evt_reentrega_2"]) await w.deps.repo.asaasEvents.insert({ asaasEventId: id, eventType: ev.event, asaasPaymentId: c.asaasPaymentId, payload: { ...ev, id } });
    await processAsaasEvents(w.deps);
    await processAsaasEvents(w.deps);
    expect(w.odoo.payments).toHaveLength(1);
    expect(w.odoo.payments[0]).toMatchObject({ moveLineId: 1001, amount: "100.00", ref: `asaas:${c.asaasPaymentId}` });
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).toBe("received");
    expect((await w.pool.query("select count(*)::int as n from reconciliations")).rows[0].n).toBe(1);
  });

  it("P2: valor pago ≠ residual → exceção, nenhuma baixa (Asaas atrás da porta)", async () => {
    const w = await fresh();
    const { c, ev } = await emitirELiquidar(w, { value: "90.00" });
    await w.deps.repo.asaasEvents.insert({ asaasEventId: ev.id, eventType: ev.event, asaasPaymentId: c.asaasPaymentId, payload: ev });
    await processAsaasEvents(w.deps);
    expect(w.odoo.payments).toHaveLength(0);
    expect(await w.deps.repo.exceptions.hasOpen("amount_divergent", "charges", c.id)).toBe(true);
    expect((await w.deps.repo.charges.getByMoveLine(1001))!.status).not.toBe("received");
  });

  it("P3: ida desligada → nenhuma cobrança criada em nenhum gateway", async () => {
    const w = await fresh({ idaEnabled: false }); seedInvoice(w);
    expect(await syncInvoices(w.deps)).toMatchObject({ enabled: false, created: 0 });
    expect(w.asaas.payments.size).toBe(0);
    const itau = comItau(w);
    expect(await syncInvoices(itau.deps)).toMatchObject({ enabled: false, created: 0 });
    expect(itau.rede.chamadas).toBe(0);
    expect((await w.pool.query("select count(*)::int as n from charges")).rows[0].n).toBe(0);
  });

  it("P3: Itaú atrás da porta, mesmo com a ida ligada no banco → nada emitido, nenhuma chamada, nenhuma exceção", async () => {
    const w = await fresh(); seedInvoice(w);
    const itau = comItau(w);
    const s = await syncInvoices(itau.deps);
    expect(s).toMatchObject({ created: 0, failed: 0 });
    expect(itau.rede.chamadas).toBe(0);
    expect((await w.pool.query("select count(*)::int as n from charges")).rows[0].n).toBe(0);
    expect((await w.pool.query("select count(*)::int as n from exceptions")).rows[0].n).toBe(0);
    expect(s).toMatchObject({ gatewayCanIssue: false, invoices: 0 });
    expect(await w.deps.repo.watermarks.get("invoices")).toBeNull();   // BLOQ-1: o watermark não anda
  });

  it("BLOQ-1: sync com Itaú (ida ligada) não pode consumir o watermark — ao voltar ao Asaas a fatura é cobrada", async () => {
    const w = await fresh(); seedInvoice(w);
    await syncInvoices(comItau(w).deps);
    await syncInvoices(w.deps);   // volta ao Asaas
    expect((await w.pool.query("select count(*)::int as n from charges")).rows[0].n).toBeGreaterThan(0);
  });

  it("P3: o console não liga a ida com o Itaú (sem emissão real); com o Asaas liga", async () => {
    const w = await fresh({ idaEnabled: false });
    const itau = comItau(w);
    const r = await setConsoleConfig(itau.deps, "IDA_ENABLED", true);
    expect(r).toMatchObject({ ok: false, code: "invalid_state" });
    expect(await w.deps.repo.config.get("IDA_ENABLED")).toBe(false);
    expect(await setConsoleConfig(itau.deps, "IDA_ENABLED", false)).toMatchObject({ ok: true });
    expect(await setConsoleConfig(w.deps, "IDA_ENABLED", true)).toMatchObject({ ok: true });
  });

  it("P4: sem GO_LIVE_CUTOFF_DATE → nada emitido, em nenhum gateway", async () => {
    const w = await fresh({ cutoff: null }); seedInvoice(w);
    expect((await syncInvoices(w.deps)).created).toBe(0);
    expect(w.asaas.payments.size).toBe(0);
    const itau = comItau(w);
    expect((await syncInvoices(itau.deps)).created).toBe(0);
    expect(itau.rede.chamadas).toBe(0);
    expect((await w.pool.query("select count(*)::int as n from charges")).rows[0].n).toBe(0);
  });
});
