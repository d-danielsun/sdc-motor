// Transporte HTTPS do Itaú. mTLS por construção: sem certificado e chave o transporte nem existe.
// Adaptado do relay em produção (api-contacorrente): https.Agent com cert/key, CA estrita
// (raízes do Node + CA extra opcional), rejectUnauthorized sempre true, TLS ≥ 1.2.
import { X509Certificate, createPrivateKey } from "node:crypto";
import https from "node:https";
import tls from "node:tls";

export interface ItauResponse { status: number; body: string; headers: Record<string, string | string[] | undefined> }
export interface ItauRequest { method?: string; headers?: Record<string, string>; body?: string }
export type ItauTransport = (url: string, req?: ItauRequest) => Promise<ItauResponse>;

export const ITAU_TIMEOUT_MS = 15_000;

export class ItauConfigError extends Error {
  constructor(msg: string) { super(msg); this.name = "ItauConfigError"; }
}

export interface MtlsMaterial { cert: string; key: string; extraCa?: string | null; timeoutMs?: number }

function request(agent: https.Agent, timeoutMs: number): ItauTransport {
  return (url, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
    if (!url.startsWith("https://")) { reject(new ItauConfigError(`Itaú: só HTTPS (${url.slice(0, 40)})`)); return; }
    const h = { ...headers, ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}) };
    const req = https.request(url, { method, headers: h, agent, timeout: timeoutMs }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("Itaú: timeout"), { transient: true })));
    req.on("error", (e) => reject(Object.assign(e, { transient: true })));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const caList = (extraCa?: string | null) => (extraCa ? [...tls.rootCertificates, extraCa] : undefined);

/** Transporte mTLS. Recusa construir sem cert/key, com chave que não confere, ou com validação de CA desligada. */
export function createMtlsTransport(m: Partial<MtlsMaterial>, env: NodeJS.ProcessEnv = process.env): ItauTransport {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new ItauConfigError("Itaú: NODE_TLS_REJECT_UNAUTHORIZED=0 desliga a validação de CA — recusado");
  if (!m.cert || !m.key) throw new ItauConfigError("Itaú: certificado e chave (ITAU_CERT_PEM|ITAU_CERT_FILE, ITAU_KEY_PEM|ITAU_KEY_FILE) são obrigatórios — o cliente não sobe sem mTLS");
  let ok: boolean;
  try { ok = new X509Certificate(m.cert).checkPrivateKey(createPrivateKey(m.key)); }
  catch (e) { throw new ItauConfigError(`Itaú: certificado/chave ilegível: ${(e as Error).message}`); }
  if (!ok) throw new ItauConfigError("Itaú: a chave NÃO confere com o certificado");
  const agent = new https.Agent({ cert: m.cert, key: m.key, ca: caList(m.extraCa), rejectUnauthorized: true, minVersion: "TLSv1.2", keepAlive: true });
  return request(agent, m.timeoutMs ?? ITAU_TIMEOUT_MS);
}

/** Transporte SEM certificado de cliente — só para a solicitação do PRIMEIRO certificado
 *  (ainda não existe cert; o banco autentica pelo token temporário). Nada mais usa isto. */
export function createBootstrapTransport(o: { extraCa?: string | null; timeoutMs?: number } = {}, env: NodeJS.ProcessEnv = process.env): ItauTransport {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new ItauConfigError("Itaú: NODE_TLS_REJECT_UNAUTHORIZED=0 desliga a validação de CA — recusado");
  const agent = new https.Agent({ ca: caList(o.extraCa), rejectUnauthorized: true, minVersion: "TLSv1.2" });
  return request(agent, o.timeoutMs ?? ITAU_TIMEOUT_MS);
}
