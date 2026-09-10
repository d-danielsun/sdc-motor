import { describe, expect, it } from "vitest";
import { classifyReceipt } from "../../src/core/receive.js";
import { asaasId, normalizeAsaasEvent, normalizeAsaasPayment } from "../../src/core/asaasPayload.js";
import type { AsaasPayment } from "../../src/core/types.js";

const base: AsaasPayment = {
  id: "pay_1", customer: "cus_1", status: "RECEIVED", billingType: "BOLETO", value: "100.00", netValue: "98.01", originalValue: null, interestValue: null,
  dueDate: "2026-09-10", paymentDate: "2026-09-10", clientPaymentDate: "2026-09-10", creditDate: "2026-09-10", externalReference: "odoo:move_line:1",
  bankSlipUrl: null, invoiceUrl: null, invoiceNumber: null, nossoNumero: null, deleted: false,
};
const opts = { toleranceCents: 1, jurosMultaAuto: false };

describe("classifyReceipt", () => {
  it("valor exato → ok", () => expect(classifyReceipt(base, "100.00", opts)).toEqual({ ok: true, policy: null }));
  it("dentro da tolerância → ok", () => expect(classifyReceipt({ ...base, value: "100.01" }, "100.00", opts).ok).toBe(true));
  it("recebido em dinheiro → ok com política in_cash", () => expect(classifyReceipt({ ...base, status: "RECEIVED_IN_CASH" }, "100.00", opts)).toEqual({ ok: true, policy: "in_cash" }));
  it("juros/multa do Asaas (originalValue == esperado) → writeoff_needed até Q3", () => {
    const p = { ...base, value: "102.50", originalValue: "100.00", interestValue: "2.50" };
    expect(classifyReceipt(p, "100.00", opts)).toEqual({ ok: false, reason: "writeoff_needed", policy: "juros_multa" });
    expect(classifyReceipt(p, "100.00", { ...opts, jurosMultaAuto: true })).toEqual({ ok: true, policy: "juros_multa" });
  });
  it("a maior sem originalValue → divergente; a menor → divergente", () => {
    expect(classifyReceipt({ ...base, value: "150.00" }, "100.00", opts)).toMatchObject({ ok: false, reason: "amount_divergent" });
    expect(classifyReceipt({ ...base, value: "90.00" }, "100.00", opts)).toMatchObject({ ok: false, reason: "amount_divergent" });
  });
});

describe("normalização tolerante do payload (nunca lança)", () => {
  it("aceita campo desconhecido e number/string", () => {
    const p = normalizeAsaasPayment({ id: "pay_x", value: 12.3, novoCampo: { a: 1 }, netValue: "12.00", status: "RECEIVED" });
    expect(p).toMatchObject({ id: "pay_x", value: "12.30", netValue: "12.00", originalValue: null, deleted: false });
  });
  it("sem id/value, value inválido, id com caractere de path → null", () => {
    expect(normalizeAsaasPayment({ foo: 1 })).toBeNull();
    for (const v of ["abc", "", "1.234", "12,50", NaN, null]) expect(normalizeAsaasPayment({ id: "pay_1", value: v }), String(v)).toBeNull();
    expect(normalizeAsaasPayment({ id: "pay_1/../webhooks/x", value: 10 })).toBeNull();
    expect(normalizeAsaasEvent({ id: "evt", event: "PAYMENT_RECEIVED" })).toBeNull();
    expect(normalizeAsaasEvent("lixo")).toBeNull();
    expect(normalizeAsaasEvent([])).toBeNull();
  });
  it("asaasId só aceita o charset conhecido", () => {
    expect(asaasId("pay_b64p10j83x0jfs7y")).toBe("pay_b64p10j83x0jfs7y");
    expect(asaasId("228858f9-ea17-4764-b4ea-689d6c92a36b")).toBeTruthy();
    expect(asaasId("pay?x=1")).toBeNull(); expect(asaasId("a".repeat(65))).toBeNull(); expect(asaasId(7)).toBe("7");
  });
});
