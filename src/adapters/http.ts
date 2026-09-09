// fetch com timeout e erro tipado; base dos adaptadores Asaas e Odoo.
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
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetchImpl(url, { ...rest, signal: ctl.signal });
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* corpo não-JSON: fica como texto */ }
    return { status: res.status, body, durationMs: Date.now() - t0 };
  } catch (e) {
    throw new HttpError(service, 0, null, `${service}: ${(e as Error).name === "AbortError" ? `timeout ${timeoutMs}ms` : (e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
