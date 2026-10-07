// Token OAuth do Itaú: client_credentials no STS, sobre mTLS. Cache em memória ≤ 270 s
// (o token vive 300 s); pedidos simultâneos compartilham UMA chamada; recusa do STS vira erro
// claro, sem retry em loop (credencial errada não melhora tentando de novo).
import { randomUUID } from "node:crypto";
import type { ItauResponse, ItauTransport } from "./transport.js";

export const ITAU_TOKEN_URL = "https://sts.itau.com.br/api/oauth/token";
export const TOKEN_CACHE_MAX_S = 270;

export class ItauAuthError extends Error {
  constructor(readonly status: number, msg: string) { super(msg); this.name = "ItauAuthError"; }
}

export interface ItauAuthConfig {
  clientId: string; clientSecret: string; tokenUrl?: string;
  transport: ItauTransport;
  now?: () => number;
}

export class ItauTokenProvider {
  private cache: { token: string; exp: number } | null = null;
  private inflight: Promise<string> | null = null;
  constructor(private readonly cfg: ItauAuthConfig) {
    if (!cfg.clientId || !cfg.clientSecret) throw new Error("Itaú: ITAU_CLIENT_ID e ITAU_CLIENT_SECRET são obrigatórios");
  }
  private now(): number { return (this.cfg.now ?? Date.now)(); }

  /** Token válido; `force` ignora o cache (usado UMA vez depois de um 401 da API). */
  async getToken(force = false): Promise<string> {
    if (!force && this.cache && this.cache.exp > this.now()) return this.cache.token;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchToken().finally(() => { this.inflight = null; });
    return this.inflight;
  }
  invalidate(): void { this.cache = null; }

  private async fetchToken(): Promise<string> {
    const form = new URLSearchParams({ grant_type: "client_credentials", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }).toString();
    const r = await this.cfg.transport(this.cfg.tokenUrl ?? ITAU_TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form });
    if (r.status !== 200) {
      this.cache = null;
      throw new ItauAuthError(r.status, r.status === 401 || r.status === 403
        ? `Itaú STS recusou as credenciais (HTTP ${r.status}): confira ITAU_CLIENT_ID/ITAU_CLIENT_SECRET e se o certificado é o emitido para este Client ID`
        : `Itaú STS falhou (HTTP ${r.status})`);
    }
    let j: { access_token?: unknown; expires_in?: unknown };
    try { j = JSON.parse(r.body) as typeof j; } catch { throw new ItauAuthError(r.status, "Itaú STS devolveu resposta não-JSON"); }
    if (typeof j.access_token !== "string" || !j.access_token) throw new ItauAuthError(r.status, "Itaú STS respondeu sem access_token");
    const expiresIn = typeof j.expires_in === "number" ? j.expires_in : 300;
    const ttl = Math.max(0, Math.min(TOKEN_CACHE_MAX_S, expiresIn - 30));
    this.cache = { token: j.access_token, exp: this.now() + ttl * 1000 };
    return j.access_token;
  }
}

/** Headers de toda chamada de API do Itaú. flowID é UUID novo por chamada. */
export function itauHeaders(o: { token: string; clientId: string; correlationId?: string }): Record<string, string> {
  return {
    authorization: `Bearer ${o.token}`,
    "x-itau-apikey": o.clientId,
    "x-itau-correlationID": o.correlationId ?? randomUUID(),
    "x-itau-flowID": randomUUID(),
    accept: "application/json",
  };
}

/** Chamada autenticada: em 401 da API, renova o token UMA vez e repete; segundo 401 devolve como veio. */
export async function itauAuthedRequest(
  auth: ItauTokenProvider, transport: ItauTransport, clientId: string,
  url: string, req: { method?: string; headers?: Record<string, string>; body?: string; correlationId?: string } = {},
): Promise<ItauResponse> {
  const call = async (force: boolean) => {
    const token = await auth.getToken(force);
    return transport(url, { method: req.method, body: req.body, headers: { ...itauHeaders({ token, clientId, correlationId: req.correlationId }), ...req.headers } });
  };
  const r = await call(false);
  if (r.status !== 401) return r;
  auth.invalidate();
  return call(true);
}
