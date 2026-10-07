// Itaú: solicitação/renovação do certificado dinâmico e alerta de vencimento, contra servidor local.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ItauCertificateError, diasParaVencer, renovar, situacaoCertificado, solicitar } from "../../src/adapters/itau/certificate.js";
import { readItauConfig } from "../../src/adapters/itau/config.js";
import { ItauConfigError, createBootstrapTransport, createMtlsTransport } from "../../src/adapters/itau/transport.js";
import { gerarPki, servidorItau, type Pki } from "../itau-fixtures.js";

let pki: Pki;
beforeAll(() => { pki = gerarPki(); });
afterAll(() => pki?.cleanup());

describe("Itaú certificado", () => {
  it("solicitar: POST text/plain com Bearer temporário, sem cert de cliente; devolve o texto cru", async () => {
    const srv = await servidorItau(pki, () => ({ status: 200, body: "-----BEGIN CERTIFICATE-----\nMIIfake\n-----END CERTIFICATE-----\nsecret: xyz" }), { exigirCliente: false });
    try {
      const out = await solicitar(pki.csr, "token-temp", { transport: createBootstrapTransport({ extraCa: pki.ca }, {}), baseUrl: srv.base });
      expect(out).toContain("secret: xyz");
      const [p] = srv.pedidos;
      expect(p).toMatchObject({ method: "POST", url: "/seguranca/v1/certificado/solicitacao", body: pki.csr, clientCn: null });
      expect(p!.headers["content-type"]).toBe("text/plain");
      expect(p!.headers.authorization).toBe("Bearer token-temp");
    } finally { await srv.close(); }
  });

  it("renovar: POST na rota de renovação COM mTLS", async () => {
    const srv = await servidorItau(pki, () => ({ status: 200, body: "novo" }));
    try {
      const out = await renovar(pki.csr, "tok-sts", { transport: createMtlsTransport({ cert: pki.clientCert, key: pki.clientKey, extraCa: pki.ca }, {}), baseUrl: srv.base });
      expect(out).toBe("novo");
      expect(srv.pedidos[0]).toMatchObject({ url: "/seguranca/v1/certificado/renovacao", clientCn: "client-id-teste" });
      expect(srv.pedidos[0]!.headers.authorization).toBe("Bearer tok-sts");
    } finally { await srv.close(); }
  });

  it("resposta de erro vira ItauCertificateError com status e corpo; CSR inválido nem sai", async () => {
    const srv = await servidorItau(pki, () => ({ status: 400, body: '{"erro":"csr"}' }), { exigirCliente: false });
    try {
      const t = createBootstrapTransport({ extraCa: pki.ca }, {});
      const e = await solicitar(pki.csr, "tok", { transport: t, baseUrl: srv.base }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ItauCertificateError);
      expect((e as ItauCertificateError).status).toBe(400);
      await expect(solicitar("não é csr", "tok", { transport: t, baseUrl: srv.base })).rejects.toThrow(/CSR/);
      await expect(solicitar(pki.csr + pki.clientKey, "tok", { transport: t, baseUrl: srv.base })).rejects.toThrow(/chave privada/);
      expect(srv.pedidos).toHaveLength(1);
    } finally { await srv.close(); }
  });

  it("diasParaVencer e janela de renovação (30 → 1 dia antes)", () => {
    const agora = new Date();
    const d45 = diasParaVencer(pki.clientCert, agora);
    const d10 = diasParaVencer(pki.shortCert, agora);
    expect(d45).toBeGreaterThanOrEqual(44); expect(d45).toBeLessThanOrEqual(45);
    expect(d10).toBeGreaterThanOrEqual(9); expect(d10).toBeLessThanOrEqual(10);
    expect(situacaoCertificado(d45)).toBe("ok");
    expect(situacaoCertificado(d10)).toBe("renovar");
    expect(situacaoCertificado(0)).toBe("renovar");
    expect(situacaoCertificado(diasParaVencer(pki.clientCert, new Date(agora.getTime() + 60 * 86_400_000)))).toBe("vencido");
  });

  it("config: lê PEM ou arquivo; sem cert/key recusa", () => {
    const certFile = path.join(pki.dir, "cert-env.crt");
    writeFileSync(certFile, pki.clientCert);
    const base = { ITAU_CLIENT_ID: "c", ITAU_CLIENT_SECRET: "s" };
    const cfg = readItauConfig({ ...base, ITAU_CERT_FILE: certFile, ITAU_KEY_PEM: pki.clientKey });
    expect(cfg.cert).toBe(pki.clientCert);
    expect(cfg.tokenUrl).toBe("https://sts.itau.com.br/api/oauth/token");
    expect(() => readItauConfig({ ...base, ITAU_KEY_PEM: pki.clientKey })).toThrow(ItauConfigError);
    expect(() => readItauConfig({ ...base, ITAU_CERT_PEM: pki.clientCert })).toThrow(/ITAU_KEY_PEM ou ITAU_KEY_FILE/);
    expect(() => readItauConfig({ ...base, ITAU_CERT_FILE: "/nao/existe.crt", ITAU_KEY_PEM: pki.clientKey })).toThrow(/ENOENT/);
    expect(() => readItauConfig({ ITAU_CERT_PEM: pki.clientCert, ITAU_KEY_PEM: pki.clientKey })).toThrow(/ITAU_CLIENT_ID/);
  });
});
