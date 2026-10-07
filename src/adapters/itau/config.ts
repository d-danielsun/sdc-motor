// Configuração do Itaú por env e montagem do cliente (transporte mTLS + token).
// Sem cert/key o cliente recusa construir: nunca existe chamada ao Itaú sem mTLS.
import { readFileSync } from "node:fs";
import { ITAU_TOKEN_URL, ItauTokenProvider, itauAuthedRequest } from "./auth.js";
import { ItauConfigError, createMtlsTransport, type ItauResponse, type ItauTransport } from "./transport.js";

export interface ItauConfig {
  clientId: string; clientSecret: string; tokenUrl: string;
  cert: string; key: string; extraCa: string | null;
}

function pemOuArquivo(e: NodeJS.ProcessEnv, pemVar: string, fileVar: string): string {
  const v = e[pemVar];
  if (v) return v.replace(/\\n/g, "\n");
  const f = e[fileVar];
  if (!f) throw new ItauConfigError(`Itaú: ${pemVar} ou ${fileVar} é obrigatório — o cliente não sobe sem mTLS`);
  try { return readFileSync(f, "utf8"); }
  catch (err) { throw new ItauConfigError(`Itaú: não consegui ler ${fileVar} (${(err as NodeJS.ErrnoException).code ?? "erro de leitura"})`); }
}

export function readItauConfig(e: NodeJS.ProcessEnv = process.env): ItauConfig {
  const req = (k: string) => { const v = e[k]; if (!v) throw new ItauConfigError(`Itaú: env ${k} ausente`); return v; };
  let extraCa: string | null = null;
  if (e.ITAU_EXTRA_CA_PEM || e.ITAU_EXTRA_CA_FILE) extraCa = pemOuArquivo(e, "ITAU_EXTRA_CA_PEM", "ITAU_EXTRA_CA_FILE");
  return {
    clientId: req("ITAU_CLIENT_ID"), clientSecret: req("ITAU_CLIENT_SECRET"),
    tokenUrl: e.ITAU_TOKEN_URL || ITAU_TOKEN_URL,
    cert: pemOuArquivo(e, "ITAU_CERT_PEM", "ITAU_CERT_FILE"),
    key: pemOuArquivo(e, "ITAU_KEY_PEM", "ITAU_KEY_FILE"),
    extraCa,
  };
}

/** Cliente Itaú: token com cache e chamada autenticada. Só auth/headers — nenhum endpoint de cobrança. */
export class ItauClient {
  readonly auth: ItauTokenProvider;
  readonly transport: ItauTransport;
  constructor(readonly cfg: ItauConfig, o: { transport?: ItauTransport; now?: () => number; env?: NodeJS.ProcessEnv } = {}) {
    // Mesmo com transporte injetado (teste), cert e key são exigidos: P7 vale para qualquer montagem.
    if (!cfg.cert || !cfg.key) throw new ItauConfigError("Itaú: certificado e chave são obrigatórios — o cliente não sobe sem mTLS");
    this.transport = o.transport ?? createMtlsTransport({ cert: cfg.cert, key: cfg.key, extraCa: cfg.extraCa }, o.env);
    this.auth = new ItauTokenProvider({ clientId: cfg.clientId, clientSecret: cfg.clientSecret, tokenUrl: cfg.tokenUrl, transport: this.transport, now: o.now });
  }
  request(url: string, req: { method?: string; headers?: Record<string, string>; body?: string; correlationId?: string } = {}): Promise<ItauResponse> {
    return itauAuthedRequest(this.auth, this.transport, this.cfg.clientId, url, req);
  }
}
