// fetch com timeout, sem seguir redirect, e JSON obrigatório em sucesso. Base dos adaptadores Asaas e Odoo.
// Lição do QA (U1): uma base Odoo expirada devolve 303 → HTML 200; aceitar isso como sucesso gerou "baixa" falsa.
import type { Repo } from "../core/ports.js";

export const USER_AGENT = "sdc-motor/0.1";
export interface HttpResult { status: number; body: unknown; durationMs: number }

export class HttpError extends Error {
  readonly transient: boolean;
  constructor(readonly service: string, readonly status: number, readonly body: unknown, msg?: string) {
    super(msg ?? `${service} HTTP ${status}: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
    this.transient = status === 0 || status === 408 || status === 429 || status >= 500;
  }
}

export async function httpJson(service: string, url: string, init: RequestInit & { timeoutMs?: number; fetchImpl?: typeof fetch } = {}): Promise<HttpResult> {
  const { timeoutMs = 20_000, fetchImpl = fetch, ...rest } = init;
  const t0 = Date.now();
  let res: Response, text: string;
  try {
    res = await fetchImpl(url, { ...rest, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (e) {
    const name = (e as Error).name;
    throw new HttpError(service, 0, null, `${service}: ${name === "TimeoutError" || name === "AbortError" ? `timeout ${timeoutMs}ms` : (e as Error).message}`);
  }
  const durationMs = Date.now() - t0;
  if (res.status >= 300 && res.status < 400) {
    throw new HttpError(service, res.status, text.slice(0, 300), `${service}: redirect ${res.status} para ${res.headers.get("location") ?? "?"} — URL/base errada ou expirada`);
  }
  let body: unknown = text;
  let isJson = false;
  try { body = text ? JSON.parse(text) : null; isJson = true; } catch { /* não-JSON */ }
  if (res.status < 400 && !isJson) {
    throw new HttpError(service, 502, text.slice(0, 300), `${service}: resposta ${res.status} não é JSON (${(res.headers.get("content-type") ?? "?").split(";")[0]}) — servidor devolvendo HTML?`);
  }
  return { status: res.status, body, durationMs };
}

/** Trilha de auditoria de chamadas de saída: nunca derruba a chamada, e registra também falha/timeout. */
export async function audited<T extends HttpResult>(audit: Repo["audit"] | null | undefined, direction: "odoo_out" | "asaas_out", endpoint: string, requestSummary: unknown, call: () => Promise<T>): Promise<T> {
  let status = 0, durationMs = 0;
  try {
    const r = await call();
    status = r.status; durationMs = r.durationMs;
    return r;
  } catch (e) {
    if (e instanceof HttpError) status = e.status;
    throw e;
  } finally {
    void audit?.log({ direction, endpoint, requestSummary, responseStatus: status, durationMs }).catch(() => undefined);
  }
}
