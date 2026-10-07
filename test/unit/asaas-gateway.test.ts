// AsaasGateway: a porta neutra sobre o client do Asaas, sem mudar comportamento.
import { describe, expect, it } from "vitest";
import { AsaasGateway } from "../../src/adapters/asaas/gateway.js";
import { FakeAsaas } from "../../src/adapters/fakes/fakeAsaas.js";

async function comCobranca() {
  const fake = new FakeAsaas();
  const gw = new AsaasGateway(fake);
  const cus = await gw.createCustomer({ name: "Cliente", cpfCnpj: "11144477735", externalReference: "odoo:partner:1", notificationDisabled: true });
  const ch = await gw.createCharge({ customer: cus.id, value: "100.00", dueDate: "2026-10-20", externalReference: "odoo:move_line:1", description: "x" });
  return { fake, gw, ch };
}

describe("AsaasGateway", () => {
  it("nome do gateway é 'asaas' — o memo de baixa continua asaas:<pay_id>", () => {
    expect(new AsaasGateway(new FakeAsaas()).name).toBe("asaas");
  });

  it("delega ao client: criar, obter, achar por referência, listar e cancelar", async () => {
    const { fake, gw, ch } = await comCobranca();
    expect((await gw.getCharge(ch.id))?.status).toBe("PENDING");
    expect((await gw.findChargeByExternalRef("odoo:move_line:1"))?.id).toBe(ch.id);
    fake.confirm(ch.id);
    const recebidas = [];
    for await (const c of gw.listCharges({ status: "RECEIVED" })) recebidas.push(c.id);
    expect(recebidas).toEqual([ch.id]);
    await expect(gw.cancelCharge(ch.id)).rejects.toThrow(/recebida/);
  });

  it("sobrescrever método do client depois de embrulhar vale pela porta (os testes db dependem disso)", async () => {
    const { fake, gw, ch } = await comCobranca();
    fake.getPayment = async () => null;
    expect(await gw.getCharge(ch.id)).toBeNull();
  });

  it("traduz o evento do webhook para SettlementEvent", async () => {
    const { fake, gw, ch } = await comCobranca();
    const ev = gw.parseSettlementEvent(fake.confirm(ch.id, { inCash: true }));
    expect(ev).toMatchObject({ kind: "received", rawType: "PAYMENT_RECEIVED", gatewayChargeId: ch.id, externalReference: "odoo:move_line:1", status: "RECEIVED_IN_CASH", grossValue: "100.00", netValue: "98.01", paymentDate: "2026-09-10" });
    const p = (await fake.getPayment(ch.id))!;
    const kinds = ["PAYMENT_CONFIRMED", "PAYMENT_UPDATED", "PAYMENT_DELETED", "PAYMENT_BANK_SLIP_CANCELLED", "PAYMENT_RESTORED", "PAYMENT_REFUNDED", "PAYMENT_PARTIALLY_REFUNDED", "PAYMENT_RECEIVED_IN_CASH_UNDONE", "PAYMENT_OVERDUE", "PAYMENT_CREATED"]
      .map((e) => gw.parseSettlementEvent(fake.event(e, p))?.kind);
    expect(kinds).toEqual(["confirmed", "updated", "deleted", "slip_cancelled", "restored", "reversal", "reversal", "reversal", "overdue", "other"]);
    expect(gw.parseSettlementEvent("lixo")).toBeNull();
    expect(gw.parseSettlementEvent({ id: "evt", event: "PAYMENT_RECEIVED" })).toBeNull();
  });

  it("fila de avisos: lê o estado e retoma a fila interrompida", async () => {
    const fake = new FakeAsaas();
    const gw = new AsaasGateway(fake);
    const wh = await fake.createWebhook({ name: "m", url: "https://x", email: "a@b.c", authToken: "t", events: [] });
    fake.interrupt(wh.id, 15);
    expect(await gw.getEventQueue(wh.id)).toEqual({ id: wh.id, enabled: true, interrupted: true, penalizedRequestsCount: 15 });
    await gw.resumeEventQueue(wh.id);
    expect((await gw.getEventQueue(wh.id))?.interrupted).toBe(false);
    expect(await gw.getEventQueue("wh_nao_existe")).toBeNull();
  });
});
