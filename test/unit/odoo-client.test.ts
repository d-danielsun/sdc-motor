// Lição U1 do QA: o adaptador do Odoo tem que desconfiar da resposta. fetch falso, sem rede.
import { describe, expect, it } from "vitest";
import { OdooJson2Client } from "../../src/adapters/odoo/client.js";
import { HttpError } from "../../src/adapters/http.js";
import { res, scriptedFetch } from "../helpers.js";

const client = (script: Array<(url: string, body: unknown) => Response>) => new OdooJson2Client({ url: "https://odoo.test/", apiKey: "k", fetchImpl: scriptedFetch(script) });
const line = (residual: number, reconciled = false) => res(200, JSON.stringify([{ id: 1001, reconciled, amount_residual: residual, move_id: [100, "INV/1"], date_maturity: "2026-09-20" }]));

describe("OdooJson2Client desconfiado", () => {
  it("base expirada (303) → erro, não sucesso; barra final da URL é tolerada", async () => {
    let seen = "";
    const c = client([(url) => { seen = url; return res(303, "", { location: "https://odoo.test/_odoo/upgrade/x" }); }]);
    await expect(c.getInvoice(1)).rejects.toThrow(/redirect 303/);
    expect(seen).toBe("https://odoo.test/json/2/account.move/search_read");
  });
  it("HTML com 200 → erro 502 transiente, nunca lista vazia", async () => {
    const err = await client([() => res(200, "<html>Database currently unavailable</html>")]).getInvoice(1).catch((e) => e as HttpError);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(502);
    expect((err as HttpError).transient).toBe(true);
  });
  it("JSON que não é lista onde se espera lista → erro", async () => {
    await expect(client([() => res(200, JSON.stringify({ oops: true }))]).getOpenPaymentTermLines(1)).rejects.toThrow(/não devolveu lista/);
  });
  it("searchInvoices: desempate (write_date, id), formato do Odoo na ida e ISO na volta", async () => {
    let sent: any;
    const c = client([(_u, body) => { sent = body; return res(200, JSON.stringify([{ id: 5, name: "INV/5", partner_id: [10, "X"], state: "posted", payment_state: "not_paid", move_type: "out_invoice", amount_residual: 10, write_date: "2026-09-09 13:00:00" }])); }]);
    const out = await c.searchInvoices({ after: { writeDate: "2026-09-09T12:00:00.000Z", id: 4 }, limit: 50 });
    expect(sent.domain).toEqual([["move_type", "=", "out_invoice"], ["state", "in", ["posted", "cancel", "draft"]], "|", ["write_date", ">", "2026-09-09 12:00:00"], "&", ["write_date", "=", "2026-09-09 12:00:00"], ["id", ">", 4]]);
    expect(sent.order).toBe("write_date asc, id asc"); expect(sent.limit).toBe(50);
    expect(out[0]).toMatchObject({ id: 5, partnerId: 10, writeDate: "2026-09-09T13:00:00.000Z", amountResidual: "10.00" });
  });
  it("registerPayment: confirma pelo residual antes×depois; residual que não caiu → 409 não-transiente", async () => {
    const ok = client([
      () => line(100),                                                     // antes
      () => res(200, "[7]"),                                               // create → wizard 7
      () => res(200, JSON.stringify({ type: "ir.actions.act_window", res_id: 55 })),
      () => line(0, true),                                                 // depois: conciliada
      () => res(200, JSON.stringify([{ id: 100, payment_state: "in_payment" }])),
    ]);
    expect(await ok.registerPayment({ moveLineId: 1001, amount: "100.00", paymentDate: "2026-09-10" })).toEqual({ paymentId: 55, paymentState: "in_payment" });
    const parcial = client([() => line(200), () => res(200, "[8]"), () => res(200, "{}"), () => line(100), () => res(200, JSON.stringify([{ id: 100, payment_state: "partial" }]))]);
    expect(await parcial.registerPayment({ moveLineId: 1001, amount: "100.00", paymentDate: "2026-09-10" })).toEqual({ paymentId: null, paymentState: "partial" });   // caiu 100 de 200: aplicado
    const naoCaiu = client([() => line(100), () => res(200, "[9]"), () => res(200, "{}"), () => line(100)]);
    const err = await naoCaiu.registerPayment({ moveLineId: 1001, amount: "100.00", paymentDate: "2026-09-10" }).catch((e) => e as HttpError);
    expect(err).toBeInstanceOf(HttpError); expect((err as HttpError).status).toBe(409); expect((err as HttpError).transient).toBe(false);
    expect(String(err)).toMatch(/baixa NÃO confirmada/);
    await expect(client([() => line(100), () => res(200, JSON.stringify({ id: "x" }))]).registerPayment({ moveLineId: 1001, amount: "100.00", paymentDate: "2026-09-10" })).rejects.toThrow(/id numérico/);
  });
  it("erro 401 do Odoo é definitivo (não transiente); 500 é transiente", () => {
    expect(new HttpError("odoo", 401, {}).transient).toBe(false);
    expect(new HttpError("odoo", 503, {}).transient).toBe(true);
  });
});
