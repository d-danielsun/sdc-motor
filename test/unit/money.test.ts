import { describe, expect, it } from "vitest";
import { add, eq, fromCents, money, safeMoney, sub, toCents } from "../../src/core/money.js";

describe("money (centavos inteiros)", () => {
  it("converte string e number sem erro de float", () => {
    expect(toCents("123.45")).toBe(12345);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(money(123.4)).toBe("123.40");
    expect(money("7")).toBe("7.00");
    expect(fromCents(-5)).toBe("-0.05");
  });
  it("soma/subtrai/compara", () => {
    expect(add("0.10", "0.20")).toBe("0.30");
    expect(sub("100.00", "0.99")).toBe("99.01");
    expect(eq("1.5", "1.50")).toBe(true);
  });
  it("rejeita lixo e valores fora da faixa (numeric(14,2))", () => {
    for (const v of ["R$ 10", "1.234", "12,50", "", "abc", NaN, Infinity, "1".repeat(13)]) expect(() => toCents(v as never), String(v)).toThrow();
    expect(() => toCents("-1.5")).not.toThrow(); expect(toCents(" 1 ")).toBe(100);
  });
  it("safeMoney nunca lança", () => {
    expect(safeMoney("abc")).toBeNull(); expect(safeMoney(NaN)).toBeNull(); expect(safeMoney({})).toBeNull(); expect(safeMoney("1.234")).toBeNull();
    expect(safeMoney(12.3)).toBe("12.30");
  });
});
