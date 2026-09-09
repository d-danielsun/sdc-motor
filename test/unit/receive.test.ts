import { describe, expect, it } from "vitest";
import { classifyReceipt } from "../../src/core/receive.js";
import { normalizeAsaasEvent, normalizeAsaasPayment } from "../../src/core/asaasPayload.js";
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

describe("normalização tolerante do payload", () => {
  it("aceita campo desconhecido e number/string", () => {
    const p = normalizeAsaasPayment({ id: "pay_x", value: 12.3, novoCampo: { a: 1 }, netValue: "12.00", status: "RECEIVED" });
    expect(p).toMatchObject({ id: "pay_x", value: "12.30", netValue: "12.00", originalValue: null, deleted: false });
  });
  it("sem id/value → null (nunca lança)", () => {
    expect(normalizeAsaasPayment({ foo: 1 })).toBeNull();
    expect(normalizeAsaasEvent({ id: "evt", event: "PAYMENT_RECEIVED" })).toBeNull();
    expect(normalizeAsaasEvent("lixo")).toBeNull();
  });
});
