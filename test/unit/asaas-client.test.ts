// O adaptador que cria boletos de verdade, sem rede: chave×ambiente, 404, paginação, ids em paths, objetos malformados.
import { describe, expect, it } from "vitest";
import { AsaasHttpClient } from "../../src/adapters/asaas/client.js";
import { HttpError } from "../../src/adapters/http.js";
import { res, scriptedFetch } from "../helpers.js";

const client = (script: Array<(url: string, body: unknown) => Response>, url = "https://api-sandbox.asaas.com/v3") => new AsaasHttpClient({ url, apiKey: url.includes("sandbox") ? "$aact_hmlg_x" : "$aact_prod_x", fetchImpl: scriptedFetch(script) });
const pay = (id: string, extra: Record<string, unknown> = {}) => ({ id, value: 10, status: "PENDING", externalReference: "odoo:move_line:1", ...extra });

describe("AsaasHttpClient", () => {
  it("key de produção com URL sandbox (e vice-versa) → falha fechada", () => {
    expect(() => new AsaasHttpClient({ url: "https://api-sandbox.asaas.com/v3", apiKey: "$aact_prod_x" })).toThrow(/não bate/);
    expect(() => new AsaasHttpClient({ url: "https://api.asaas.com/v3", apiKey: "$aact_hmlg_x" })).toThrow(/não bate/);
  });
  it("getPayment: 404 → null; 400 → HttpError definitivo; objeto sem id/value → 502", async () => {
    expect(await client([() => res(404, JSON.stringify({ errors: [] }))]).getPayment("pay_1")).toBeNull();
    const err = await client([() => res(400, JSON.stringify({ errors: [{ code: "invalid_action" }] }))]).getPayment("pay_1").catch((e) => e as HttpError);
    expect((err as HttpError).status).toBe(400); expect((err as HttpError).transient).toBe(false);
    await expect(client([() => res(200, JSON.stringify({ object: "payment" }))]).getPayment("pay_1")).rejects.toThrow(/sem id\/value/);
  });
  it("creditDateFrom vira estimatedCreditDate[ge] na query (é o filtro do 2º passe do reconcile)", async () => {
    // O nome do parâmetro veio da documentação. O teste vivo contra o sandbox confirma que o
    // Asaas o RESPEITA; este aqui, grátis e em todo PR, garante que continuamos EMITINDO ele.
    let url = "";
    const c = client([(u) => { url = u; return res(200, JSON.stringify({ data: [], hasMore: false })); }]);
    for await (const _ of c.listPayments({ status: "RECEIVED", creditDateFrom: "2026-09-17" })) break;
    expect(url).toContain("estimatedCreditDate%5Bge%5D=2026-09-17");
    expect(url).not.toContain("creditDate%5Bge%5D=2026");   // o campo do crédito efetivado não é filtrável
  });
  it("ids com caractere de path nunca chegam à URL", async () => {
    let called = false;
    const c = client([() => { called = true; return res(200, "{}"); }]);
    await expect(c.getPayment("pay_1/../webhooks/abc")).rejects.toThrow(/id inválido/);
    await expect(c.deletePayment("pay?x=1")).rejects.toThrow(/id inválido/);
    expect(called).toBe(false);
  });
  it("listPayments pagina até hasMore=false e findPaymentByExternalRef ignora deletados", async () => {
    const urls: string[] = [];
    const c = client([
      (u) => { urls.push(u); return res(200, JSON.stringify({ data: [pay("pay_a", { deleted: true }), pay("pay_b")], hasMore: true })); },
      (u) => { urls.push(u); return res(200, JSON.stringify({ data: [pay("pay_c")], hasMore: false })); },
    ]);
    const ids: string[] = [];
    for await (const p of c.listPayments({ status: "RECEIVED", paymentDateFrom: "2026-09-01" })) ids.push(p.id);
    expect(ids).toEqual(["pay_a", "pay_b", "pay_c"]);
    expect(urls[0]).toContain("offset=0"); expect(urls[1]).toContain("offset=100"); expect(urls[0]).toContain("paymentDate%5Bge%5D=2026-09-01");
    const d = client([() => res(200, JSON.stringify({ data: [pay("pay_a", { deleted: true }), pay("pay_b")], hasMore: false }))]);
    expect((await d.findPaymentByExternalRef("odoo:move_line:1"))?.id).toBe("pay_b");
  });
  it("listagem sem `data` → 502 (não lista vazia); DELETE sem deleted=true → 502; DELETE 404 → ok", async () => {
    await expect(client([() => res(200, "{}")]).listWebhooks()).rejects.toThrow(/sem `data`/);
    await expect(client([() => res(200, JSON.stringify({ id: "pay_1" }))]).deletePayment("pay_1")).rejects.toThrow(/deleted=true/);
    await expect(client([() => res(404, "{}")]).deletePayment("pay_1")).resolves.toBeUndefined();
  });
  it("createPayment manda value numérico e BOLETO; customer sem id válido → 502", async () => {
    let sent: any;
    const c = client([(_u, b) => { sent = b; return res(200, JSON.stringify(pay("pay_n", { value: 123.45 }))); }]);
    expect((await c.createPayment({ customer: "cus_1", value: "123.45", dueDate: "2026-10-01", externalReference: "odoo:move_line:9", description: "x" })).value).toBe("123.45");
    expect(sent).toMatchObject({ billingType: "BOLETO", value: 123.45, customer: "cus_1" });
    await expect(client([() => res(200, JSON.stringify({ name: "x" }))]).createCustomer({ name: "x", cpfCnpj: "11144477735", externalReference: "odoo:partner:1", notificationDisabled: true })).rejects.toThrow(/sem id válido/);
  });
});
