// R2: a promise do transporte nunca fica pendente — conexão que cai depois dos headers, ou corpo que trava, rejeita
// (e solta o inflight do token). Servidor HTTPS local com mTLS de verdade; nada sai da máquina.
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ItauTokenProvider } from "../../src/adapters/itau/auth.js";
import { createMtlsTransport } from "../../src/adapters/itau/transport.js";
import { gerarPki, type Pki } from "../itau-fixtures.js";

let pki: Pki;
beforeAll(() => { pki = gerarPki(); });
afterAll(() => pki?.cleanup());

/** Servidor que manda os headers e um pedaço do corpo, e então derruba a conexão ou trava. */
async function servidor(modo: "derruba" | "trava") {
  const srv = https.createServer({ key: pki.serverKey, cert: pki.serverCert, ca: pki.ca, requestCert: true, rejectUnauthorized: true }, (req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
      res.write('{"access_token":"x');
      if (modo === "derruba") setTimeout(() => res.socket?.destroy(), 20);
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `https://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((ok) => { srv.closeAllConnections(); srv.close(() => ok()); }) };
}

const transporte = (timeoutMs = 2000) => createMtlsTransport({ cert: pki.clientCert, key: pki.clientKey, extraCa: pki.ca, timeoutMs }, {});

describe("transporte Itaú — promise sempre termina (R2)", () => {
  it("conexão cai depois dos headers → rejeita como transiente", async () => {
    const s = await servidor("derruba");
    try {
      await expect(transporte()(`${s.base}/t`)).rejects.toMatchObject({ transient: true });
    } finally { await s.close(); }
  }, 5000);

  it("corpo trava depois dos headers → rejeita por timeout", async () => {
    const s = await servidor("trava");
    try {
      await expect(transporte(200)(`${s.base}/t`)).rejects.toMatchObject({ transient: true });
    } finally { await s.close(); }
  }, 5000);

  it("falha no meio do corpo solta o inflight do token: a próxima chamada tenta de novo", async () => {
    const s = await servidor("derruba");
    try {
      const auth = new ItauTokenProvider({ clientId: "c", clientSecret: "s", tokenUrl: `${s.base}/t`, transport: transporte() });
      await expect(auth.getToken()).rejects.toBeTruthy();
      await expect(auth.getToken()).rejects.toBeTruthy();   // não reaproveita uma promise presa
    } finally { await s.close(); }
  }, 5000);
});
