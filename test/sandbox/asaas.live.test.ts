// Vivo contra o sandbox do Asaas. Roda com: scripts/with-op.sh npm run test:sandbox
import { describe, expect, it } from "vitest";
import { AsaasHttpClient } from "../../src/adapters/asaas/client.js";

const key = process.env.ASAAS_API_KEY;
const url = process.env.ASAAS_URL ?? "https://api-sandbox.asaas.com/v3";
const d = key && url.includes("sandbox") ? describe : describe.skip;

d("Asaas sandbox (vivo)", () => {
  const asaas = new AsaasHttpClient({ url, apiKey: key! });
  const ref = `odoo:partner:${999100 + (Date.now() % 1000)}`;

  it("cliente: cria com notificações OFF, reaproveita por externalReference, liga no R3", async () => {
    const created = await asaas.createCustomer({ name: "Motor Teste Cliente", cpfCnpj: "11144477735", email: "motor-teste@example.com", externalReference: ref, notificationDisabled: true });
    expect(created.id).toMatch(/^cus_/);
    expect(created.notificationDisabled).toBe(true);
    const found = await asaas.findCustomerByExternalRef(ref);
    expect(found?.id).toBe(created.id);
    const on = await asaas.updateCustomer(created.id, { notificationDisabled: false });
    expect(on.notificationDisabled).toBe(false);
  });

  it("cobrança: cria boleto avulso, confirma no sandbox, vira RECEIVED com paymentDate, aparece no filtro do reconcile e pode ser apagada quando pendente", async () => {
    const cust = (await asaas.findCustomerByExternalRef(ref))!;
    const lineRef = `odoo:move_line:${Date.now()}`;
    const due = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const p = await asaas.createPayment({ customer: cust.id, value: "123.45", dueDate: due, externalReference: lineRef, description: "INV/TESTE parcela 1/1" });
    expect(p).toMatchObject({ status: "PENDING", value: "123.45", externalReference: lineRef, billingType: "BOLETO" });
    expect(p.bankSlipUrl).toMatch(/^https:/);
    await asaas.sandboxConfirm(p.id);
    const after = (await asaas.getPayment(p.id))!;
    expect(["RECEIVED", "CONFIRMED"]).toContain(after.status);
    expect(after.paymentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const listed: string[] = [];
    for await (const x of asaas.listPayments({ externalReference: lineRef })) listed.push(x.id);
    expect(listed).toEqual([p.id]);
    const pending = await asaas.createPayment({ customer: cust.id, value: "10.00", dueDate: due, externalReference: `${lineRef}-del`, description: "apagar" });
    await asaas.deletePayment(pending.id);
    expect((await asaas.getPayment(pending.id))?.deleted ?? true).toBe(true);
  });

  it("webhooks: lista (sem criar — precisa de endpoint público)", async () => {
    const list = await asaas.listWebhooks();
    expect(Array.isArray(list)).toBe(true);
  });
});
