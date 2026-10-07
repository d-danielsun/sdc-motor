// Itaú: token OAuth via mTLS contra um STS falso local (HTTPS com cert de cliente obrigatório).
// Probes P5, P6, P7 + headers x-itau-* + 401 da API → renova uma vez.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ItauAuthError, ItauTokenProvider, TOKEN_CACHE_MAX_S, itauAuthedRequest, itauHeaders } from "../../src/adapters/itau/auth.js";
import { ItauClient } from "../../src/adapters/itau/config.js";
import { ItauConfigError, createBootstrapTransport, createMtlsTransport } from "../../src/adapters/itau/transport.js";
import { gerarPki, servidorItau, type Pki } from "../itau-fixtures.js";

let pki: Pki;
beforeAll(() => { pki = gerarPki(); });
afterAll(() => pki?.cleanup());

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tokenOk = (n: number, expiresIn = 300) => ({ status: 200, body: JSON.stringify({ access_token: `tok-${n}`, token_type: "Bearer", expires_in: expiresIn }) });

function montar(base: string, now: () => number = Date.now) {
  const transport = createMtlsTransport({ cert: pki.clientCert, key: pki.clientKey, extraCa: pki.ca }, {});
  return { transport, auth: new ItauTokenProvider({ clientId: "client-id-teste", clientSecret: "segredo", tokenUrl: `${base}/api/oauth/token`, transport, now }) };
}

describe("Itaú auth (mTLS + client_credentials)", () => {
  it("pede o token com form client_credentials, apresentando o certificado de cliente", async () => {
    let n = 0;
    const sts = await servidorItau(pki, () => tokenOk(++n));
    try {
      const { auth } = montar(sts.base);
      expect(await auth.getToken()).toBe("tok-1");
      const [p] = sts.pedidos;
      expect(p!.method).toBe("POST");
      expect(p!.url).toBe("/api/oauth/token");
      expect(p!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(Object.fromEntries(new URLSearchParams(p!.body))).toEqual({ grant_type: "client_credentials", client_id: "client-id-teste", client_secret: "segredo" });
      expect(p!.clientCn).toBe("client-id-teste");   // o servidor viu o cert de cliente: mTLS de verdade
    } finally { await sts.close(); }
  });

  it("servidor que exige mTLS recusa a conexão sem certificado de cliente", async () => {
    const sts = await servidorItau(pki, () => tokenOk(1));
    try {
      const semCert = createBootstrapTransport({ extraCa: pki.ca }, {});
      await expect(semCert(`${sts.base}/api/oauth/token`, { method: "POST", body: "x" })).rejects.toThrow();
      expect(sts.pedidos).toHaveLength(0);
    } finally { await sts.close(); }
  });

  it("P5: STS responde 401 → erro claro, uma chamada só (sem loop de retry)", async () => {
    const sts = await servidorItau(pki, () => ({ status: 401, body: '{"error":"invalid_client"}' }));
    try {
      const { auth } = montar(sts.base);
      const e = await auth.getToken().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ItauAuthError);
      expect((e as ItauAuthError).status).toBe(401);
      expect((e as Error).message).toMatch(/recusou as credenciais.*ITAU_CLIENT_ID/);
      expect(sts.pedidos).toHaveLength(1);
      // Chamar de novo é uma nova tentativa explícita, não retry escondido: 1 pedido por chamada.
      await expect(auth.getToken()).rejects.toBeInstanceOf(ItauAuthError);
      expect(sts.pedidos).toHaveLength(2);
    } finally { await sts.close(); }
  });

  it("P6: cache ≤ 270 s; depois disso renova UMA vez; pedidos simultâneos → 1 chamada ao STS", async () => {
    let n = 0, t = 1_000_000;
    const sts = await servidorItau(pki, () => ({ ...tokenOk(++n, 3600), delayMs: 50 }));
    try {
      const { auth } = montar(sts.base, () => t);
      const simultaneos = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken(), auth.getToken()]);
      expect(simultaneos).toEqual(["tok-1", "tok-1", "tok-1", "tok-1"]);
      expect(sts.pedidos).toHaveLength(1);
      t += (TOKEN_CACHE_MAX_S - 1) * 1000;       // 269 s: ainda no cache (mesmo com expires_in 3600, teto 270)
      expect(await auth.getToken()).toBe("tok-1");
      expect(sts.pedidos).toHaveLength(1);
      t += 2000;                                 // 271 s: expirou
      const renovados = await Promise.all([auth.getToken(), auth.getToken()]);
      expect(renovados).toEqual(["tok-2", "tok-2"]);
      expect(sts.pedidos).toHaveLength(2);
    } finally { await sts.close(); }
  });

  it("expires_in curto encurta o cache (expires_in − 30 s)", async () => {
    let n = 0, t = 0;
    const sts = await servidorItau(pki, () => tokenOk(++n, 60));
    try {
      const { auth } = montar(sts.base, () => t);
      await auth.getToken();
      t += 31_000;
      expect(await auth.getToken()).toBe("tok-2");
    } finally { await sts.close(); }
  });

  it("headers x-itau-*: Bearer, apikey = client_id, correlationID, flowID UUID novo por chamada", () => {
    const a = itauHeaders({ token: "T", clientId: "CID", correlationId: "corr-1" });
    const b = itauHeaders({ token: "T", clientId: "CID" });
    expect(a).toMatchObject({ authorization: "Bearer T", "x-itau-apikey": "CID", "x-itau-correlationID": "corr-1" });
    expect(a["x-itau-flowID"]).toMatch(UUID);
    expect(b["x-itau-flowID"]).toMatch(UUID);
    expect(a["x-itau-flowID"]).not.toBe(b["x-itau-flowID"]);
    expect(b["x-itau-correlationID"]).toMatch(UUID);
  });

  it("401 da API → renova o token uma vez e repete; segundo 401 volta sem novo loop", async () => {
    let tokens = 0, api = 0;
    const srv = await servidorItau(pki, (p) => {
      if (p.url === "/api/oauth/token") return tokenOk(++tokens);
      api++;
      return p.headers.authorization === "Bearer tok-2" && api === 2 ? { status: 200, body: "{}" } : { status: 401, body: "{}" };
    });
    try {
      const { auth, transport } = montar(srv.base);
      const r = await itauAuthedRequest(auth, transport, "client-id-teste", `${srv.base}/qualquer`);
      expect(r.status).toBe(200);
      expect([tokens, api]).toEqual([2, 2]);
      const apiPedido = srv.pedidos.find((p) => p.url === "/qualquer")!;
      expect(apiPedido.headers["x-itau-apikey"]).toBe("client-id-teste");
      expect(String(apiPedido.headers["x-itau-flowid"])).toMatch(UUID);
      expect(apiPedido.headers["x-itau-correlationid"]).toBeTruthy();

      const r2 = await itauAuthedRequest(auth, transport, "client-id-teste", `${srv.base}/qualquer`);
      expect(r2.status).toBe(401);
      expect([tokens, api]).toEqual([3, 4]);    // 1 renovação + 1 repetição, nada além
    } finally { await srv.close(); }
  });

  it("P7: sem cert/key o cliente recusa subir e nunca chama o STS", async () => {
    let chamadas = 0;
    const transport = async () => { chamadas++; return { status: 200, body: "{}", headers: {} }; };
    const cfg = { clientId: "c", clientSecret: "s", tokenUrl: "https://127.0.0.1:1/t", extraCa: null };
    expect(() => new ItauClient({ ...cfg, cert: "", key: "" }, { transport })).toThrow(ItauConfigError);
    expect(() => new ItauClient({ ...cfg, cert: pki.clientCert, key: "" })).toThrow(/obrigatórios/);
    expect(() => createMtlsTransport({ cert: "", key: pki.clientKey }, {})).toThrow(/não sobe sem mTLS/);
    expect(() => createMtlsTransport({ cert: pki.clientCert, key: pki.otherKey }, {})).toThrow(/NÃO confere/);
    expect(() => createMtlsTransport({ cert: pki.clientCert, key: pki.clientKey }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" })).toThrow(/recusado/);
    expect(chamadas).toBe(0);
  });

  it("ItauClient monta transporte mTLS e faz a chamada autenticada ponta a ponta", async () => {
    let n = 0;
    const srv = await servidorItau(pki, (p) => (p.url === "/api/oauth/token" ? tokenOk(++n) : { status: 200, body: '{"ok":true}' }));
    try {
      const c = new ItauClient({ clientId: "client-id-teste", clientSecret: "s", tokenUrl: `${srv.base}/api/oauth/token`, cert: pki.clientCert, key: pki.clientKey, extraCa: pki.ca }, { env: {} });
      const r = await c.request(`${srv.base}/x`, { correlationId: "corr-9" });
      expect(r.status).toBe(200);
      expect(srv.pedidos.map((p) => p.clientCn)).toEqual(["client-id-teste", "client-id-teste"]);
      expect(srv.pedidos[1]!.headers["x-itau-correlationid"]).toBe("corr-9");
    } finally { await srv.close(); }
  });
});
