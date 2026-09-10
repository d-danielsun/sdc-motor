import { describe, expect, it } from "vitest";
import { canTransition, fromStatesFor } from "../../src/core/charges.js";
import { backoff } from "../../src/core/usecases/retry.js";
import { daysAgo } from "../../src/core/usecases/reconcileDaily.js";
import { isBusinessHoursBrt } from "../../src/core/usecases/watchdog.js";
import { normalizeDocument } from "../../src/core/customers.js";
import { fixedClock, systemClock } from "../../src/adapters/clock.js";
import { fromOdooDatetime, toOdooDatetime } from "../../src/adapters/odoo/client.js";
import { isIsoDate } from "../../src/core/usecases/console.js";
import { isTransient } from "../../src/core/ports.js";
import { readEnv } from "../../src/app/wiring.js";

describe("máquina de estados", () => {
  it("caminho feliz e proibições", () => {
    expect(canTransition("created", "confirmed")).toBe(true);
    expect(canTransition("confirmed", "received")).toBe(true);
    expect(canTransition("received", "cancelled")).toBe(false);
    expect(canTransition("cancelled", "created")).toBe(true); // PAYMENT_RESTORED / fatura re-postada
    expect(canTransition("refunded", "received")).toBe(false);
    expect(fromStatesFor("cancelled").sort()).toEqual(["confirmed", "created"]);
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
  it("today() respeita America/Sao_Paulo nos dois relógios", () => {
    expect(fixedClock("2026-09-10T01:00:00.000Z").today()).toBe("2026-09-09");
    expect(fixedClock("2026-09-10T13:00:00.000Z").today()).toBe("2026-09-10");
    expect(systemClock.today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("datas do Odoo vão e voltam", () => {
    expect(fromOdooDatetime("2026-09-09 13:00:00")).toBe("2026-09-09T13:00:00.000Z");
    expect(fromOdooDatetime("2026-09-09T13:00:00.000Z")).toBe("2026-09-09T13:00:00.000Z");
    expect(toOdooDatetime("2026-09-09T13:00:00.000Z")).toBe("2026-09-09 13:00:00");
    expect(fromOdooDatetime("2026-09-09 13:00:05") > fromOdooDatetime("2026-09-09 12:59:59")).toBe(true);
  });
  it("erros de conexão do pg são transientes; 401/lógica não", () => {
    for (const code of ["ECONNREFUSED", "57P01", "40001", "53300", "08006"]) expect(isTransient(Object.assign(new Error("x"), { code })), code).toBe(true);
    expect(isTransient(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isTransient(Object.assign(new Error("x"), { code: "23505" }))).toBe(false);
    expect(isTransient(new Error("odoo: baixa NÃO confirmada"))).toBe(false);
  });
  it("readEnv monta DATABASE_URL a partir de PG* com senha escapada e avisa sobre pooler :6543", () => {
    const base = { ASAAS_API_KEY: "$aact_hmlg_x", ASAAS_WEBHOOK_TOKEN: "t".repeat(32), ODOO_WEBHOOK_KEY: "k".repeat(32) };
    expect(readEnv({ ...base, PGHOST: "db", PGPASSWORD: "p@ss/w#rd" }).DATABASE_URL).toBe("postgres://motor:p%40ss%2Fw%23rd@db:5432/motor");
    expect(readEnv({ ...base, DATABASE_URL: "postgres://u:p@x.pooler.supabase.com:6543/postgres" }).warnings.some((w) => w.includes("6543"))).toBe(true);
    expect(() => readEnv({ ...base, ASAAS_WEBHOOK_TOKEN: "curto" })).toThrow(/32/);
  });
  it("isIsoDate rejeita 2026-99-99", () => { expect(isIsoDate("2026-10-01")).toBe(true); expect(isIsoDate("2026-99-99")).toBe(false); expect(isIsoDate("garbage")).toBe(false); });
});
