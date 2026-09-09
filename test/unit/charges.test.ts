import { describe, expect, it } from "vitest";
import { canTransition } from "../../src/core/charges.js";
import { backoff } from "../../src/core/usecases/retry.js";
import { daysAgo } from "../../src/core/usecases/reconcileDaily.js";
import { isBusinessHoursBrt } from "../../src/core/usecases/watchdog.js";
import { normalizeDocument } from "../../src/core/customers.js";

describe("máquina de estados", () => {
  it("caminho feliz e proibições", () => {
    expect(canTransition("created", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "received")).toBe(true);
    expect(canTransition("received", "cancelled")).toBe(false);
    expect(canTransition("cancelled", "created")).toBe(true); // PAYMENT_RESTORED
    expect(canTransition("refunded", "received")).toBe(false);
  });
});
describe("utilitários", () => {
  it("backoff 1/5/15 e desiste na 5ª", () => {
    const t = new Date("2026-09-10T12:00:00Z");
    expect(backoff(1, t)?.toISOString()).toBe("2026-09-10T12:01:00.000Z");
    expect(backoff(2, t)?.toISOString()).toBe("2026-09-10T12:05:00.000Z");
    expect(backoff(3, t)?.toISOString()).toBe("2026-09-10T12:15:00.000Z");
    expect(backoff(5, t)).toBeNull();
  });
  it("daysAgo em data civil", () => expect(daysAgo("2026-09-01", 3)).toBe("2026-08-29"));
  it("horário comercial BRT", () => {
    expect(isBusinessHoursBrt(new Date("2026-09-10T13:00:00Z"))).toBe(true);   // qui 10h BRT
    expect(isBusinessHoursBrt(new Date("2026-09-10T23:30:00Z"))).toBe(false);  // qui 20h30 BRT
    expect(isBusinessHoursBrt(new Date("2026-09-12T15:00:00Z"))).toBe(false);  // sáb
  });
  it("documento: só CPF/CNPJ com tamanho certo", () => {
    expect(normalizeDocument("529.982.247-25")).toBe("52998224725");
    expect(normalizeDocument("19.950.162/0001-19")).toBe("19950162000119");
    expect(normalizeDocument("123")).toBeNull();
    expect(normalizeDocument(null)).toBeNull();
  });
});
