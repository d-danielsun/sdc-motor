// ItauGateway stub + seleção GATEWAY + recusa de boot. Probes P7 (boot), P8, P9.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AsaasGateway } from "../../src/adapters/asaas/gateway.js";
import { FakeAsaas } from "../../src/adapters/fakes/fakeAsaas.js";
import { ItauClient } from "../../src/adapters/itau/config.js";
import { ItauGateway } from "../../src/adapters/itau/gateway.js";
import { ItauConfigError } from "../../src/adapters/itau/transport.js";
import { assertGatewayBoot, readEnv } from "../../src/app/wiring.js";
import { GatewayNotReady } from "../../src/core/gateway.js";
import { gerarPki, type Pki } from "../itau-fixtures.js";

let pki: Pki;
beforeAll(() => { pki = gerarPki(); });
afterAll(() => pki?.cleanup());

const BASE = { ASAAS_WEBHOOK_TOKEN: "t".repeat(32), ODOO_WEBHOOK_KEY: "k".repeat(32) };
const itauEnv = () => ({ ...BASE, GATEWAY: "itau", ITAU_CLIENT_ID: "cid", ITAU_CLIENT_SECRET: "sec", ITAU_CERT_PEM: pki.clientCert, ITAU_KEY_PEM: pki.clientKey });
const gw = () => new ItauGateway(new ItauClient({ clientId: "cid", clientSecret: "s", tokenUrl: "https://127.0.0.1:1/t", cert: pki.clientCert, key: pki.clientKey, extraCa: null }, { env: {} }));
const configCom = (v: unknown) => ({ config: { get: async <T>() => v as T, set: async () => undefined } });

describe("ItauGateway (stub até a Cobrança V2)", () => {
  it("P8: criar cobrança → GatewayNotReady 'aguardando Cobrança V2' e nenhuma chamada de rede", async () => {
    let chamadas = 0;
    const transport = async () => { chamadas++; return { status: 200, body: "{}", headers: {} }; };
    const g = new ItauGateway(new ItauClient({ clientId: "cid", clientSecret: "s", tokenUrl: "https://127.0.0.1:1/t", cert: pki.clientCert, key: pki.clientKey, extraCa: null }, { transport }));
    const e = await g.createCharge({ customer: "c", value: "10.00", dueDate: "2026-10-20", externalReference: "odoo:move_line:1", description: "x" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(GatewayNotReady);
    expect((e as Error).message).toMatch(/^aguardando Cobrança V2 do Itaú: criar cobrança$/);
    expect(chamadas).toBe(0);   // nenhum endpoint de boleto existe: nem o token é pedido
  });

  it("toda operação de cliente, cobrança e liquidação lança GatewayNotReady com o motivo", async () => {
    const g = gw();
    const ops: Array<() => Promise<unknown>> = [
      () => g.findCustomerByExternalRef("r"), () => g.findCustomerByDocument("1"),
      () => g.createCustomer({ name: "n", cpfCnpj: "1", externalReference: "r", notificationDisabled: true }), () => g.updateCustomer("i", {}),
      () => g.getCharge("i"), () => g.findChargeByExternalRef("r"), () => g.cancelCharge("i"),
      async () => { for await (const _ of g.listCharges({ status: "RECEIVED" })) { /* nada */ } },
      async () => g.parseSettlementEvent({}), () => g.getEventQueue("q"), () => g.resumeEventQueue("q"),
    ];
    for (const op of ops) {
      const e = await op().then(() => null, (x: unknown) => x);
      expect(e, String(op)).toBeInstanceOf(GatewayNotReady);
      expect((e as Error).message).toMatch(/^aguardando (Cobrança V2 do Itaú|o Itaú definir o aviso de pagamento)/);
    }
    expect(g.name).toBe("itau");
    expect(g.canIssue).toBe(false);
  });

  it("GATEWAY default é asaas; valor desconhecido é recusado", () => {
    expect(readEnv({ ...BASE, ASAAS_API_KEY: "$aact_hmlg_x" }).GATEWAY).toBe("asaas");
    expect(() => readEnv({ ...BASE, ASAAS_API_KEY: "$aact_hmlg_x", GATEWAY: "bradesco" })).toThrow(/GATEWAY inválido/);
  });

  it("GATEWAY=itau lê a config do Itaú no boot e dispensa ASAAS_API_KEY", () => {
    const env = readEnv(itauEnv());
    expect(env.GATEWAY).toBe("itau");
    expect(env.ITAU?.clientId).toBe("cid");
    expect(env.warnings.some((w) => w.includes("GatewayNotReady"))).toBe(true);
  });

  it("P7 no boot: GATEWAY=itau sem cert/key → recusa subir", () => {
    const { ITAU_CERT_PEM: _c, ...semCert } = itauEnv();
    expect(() => readEnv(semCert)).toThrow(ItauConfigError);
  });

  it("P9: GATEWAY=itau com a ida ligada por env → boot recusa", () => {
    for (const v of ["true", "1", "TRUE", "sim"]) expect(() => readEnv({ ...itauEnv(), IDA_ENABLED: v }), v).toThrow(/desligue a ida/);
    expect(readEnv({ ...itauEnv(), IDA_ENABLED: "false" }).GATEWAY).toBe("itau");
  });

  it("P9: GATEWAY=itau com a ida ligada em app_config → boot recusa; desligada sobe; Asaas nunca é barrado aqui", async () => {
    await expect(assertGatewayBoot(gw(), configCom(true))).rejects.toThrow(/aguardando Cobrança V2/);
    await expect(assertGatewayBoot(gw(), configCom("qualquer"))).rejects.toThrow(/ida está ligada/);
    await expect(assertGatewayBoot(gw(), configCom(false))).resolves.toBeUndefined();
    await expect(assertGatewayBoot(gw(), configCom(null))).resolves.toBeUndefined();
    await expect(assertGatewayBoot(new AsaasGateway(new FakeAsaas()), configCom(true))).resolves.toBeUndefined();
  });
});
