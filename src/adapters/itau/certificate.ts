// Certificado dinâmico do Itaú: solicitação (primeiro cert, token temporário, sem mTLS) e
// renovação (com mTLS). Devolve o texto da resposta sem interpretar além do necessário — o
// formato exato da resposta (certificado + Client Secret exibido uma vez) não é parseado aqui.
import { X509Certificate } from "node:crypto";
import type { ItauTransport } from "./transport.js";

export const ITAU_STS_BASE = "https://sts.itau.com.br";
export const RENOVAR_JANELA_DIAS = { de: 30, ate: 1 } as const;

export class ItauCertificateError extends Error {
  constructor(readonly status: number, readonly body: string, msg: string) { super(msg); this.name = "ItauCertificateError"; }
}

const assertCsr = (csrPem: string) => {
  if (!/-----BEGIN CERTIFICATE REQUEST-----/.test(csrPem)) throw new Error("Itaú: isso não é um CSR PEM (falta BEGIN CERTIFICATE REQUEST)");
  if (/PRIVATE KEY/.test(csrPem)) throw new Error("Itaú: o texto contém chave privada — envie só o CSR");
};

async function enviar(transport: ItauTransport, url: string, csrPem: string, token: string, op: string): Promise<string> {
  assertCsr(csrPem);
  if (!token) throw new Error(`Itaú: token ausente para ${op}`);
  const r = await transport(url, { method: "POST", headers: { "content-type": "text/plain", authorization: `Bearer ${token}` }, body: csrPem });
  if (r.status < 200 || r.status >= 300) throw new ItauCertificateError(r.status, r.body, `Itaú: ${op} do certificado falhou (HTTP ${r.status})`);
  return r.body;
}

/** POST /seguranca/v1/certificado/solicitacao — `transport` SEM cert de cliente (createBootstrapTransport). */
export function solicitar(csrPem: string, tokenTemporario: string, o: { transport: ItauTransport; baseUrl?: string }): Promise<string> {
  return enviar(o.transport, `${o.baseUrl ?? ITAU_STS_BASE}/seguranca/v1/certificado/solicitacao`, csrPem, tokenTemporario, "solicitação");
}

/** POST /seguranca/v1/certificado/renovacao — `transport` mTLS com o certificado ATUAL (createMtlsTransport). */
export function renovar(csrPem: string, token: string, o: { transport: ItauTransport; baseUrl?: string }): Promise<string> {
  return enviar(o.transport, `${o.baseUrl ?? ITAU_STS_BASE}/seguranca/v1/certificado/renovacao`, csrPem, token, "renovação");
}

/** Dias inteiros até o vencimento (negativo = vencido). Vencido = emitir tudo do zero. */
export function diasParaVencer(certPem: string, now: Date = new Date()): number {
  const fim = new Date(new X509Certificate(certPem).validTo).getTime();
  return Math.floor((fim - now.getTime()) / 86_400_000);
}

/** Situação para o alerta: renovar entre 30 e 1 dia antes do vencimento. */
export function situacaoCertificado(dias: number): "ok" | "renovar" | "vencido" {
  if (dias < 0) return "vencido";
  return dias <= RENOVAR_JANELA_DIAS.de ? "renovar" : "ok";
}
