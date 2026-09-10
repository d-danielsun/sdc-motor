// A borda HTTP: timeout/rede viram erro transiente, e a trilha de auditoria registra tudo sem nunca derrubar a chamada.
import { describe, expect, it } from "vitest";
import { HttpError, audited, httpJson } from "../../src/adapters/http.js";
import type { Repo } from "../../src/core/ports.js";

const falha = (name: string, msg = "boom") => (async () => { throw Object.assign(new Error(msg), { name }); }) as unknown as typeof fetch;
const trilha = (log: Repo["audit"]["log"]): Repo["audit"] => ({ log, purgeOlderThan: async () => 0 });

describe("httpJson na borda", () => {
  it("timeout e erro de rede viram HttpError status 0 transiente (quem chamou re-tenta)", async () => {
    const t = await httpJson("odoo", "https://x", { fetchImpl: falha("TimeoutError"), timeoutMs: 5 }).catch((e) => e as HttpError);
    expect(t).toBeInstanceOf(HttpError);
    expect((t as HttpError).status).toBe(0); expect((t as HttpError).transient).toBe(true);
    expect(String(t)).toMatch(/timeout 5ms/);
    const n = await httpJson("asaas", "https://x", { fetchImpl: falha("TypeError", "fetch failed: ECONNREFUSED") }).catch((e) => e as HttpError);
    expect((n as HttpError).transient).toBe(true);
    expect(String(n)).toMatch(/ECONNREFUSED/);
  });
  it("corpo vazio com 200 é JSON válido (null); 4xx não-JSON continua 4xx, não 502", async () => {
    const vazio = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    expect(await httpJson("asaas", "https://x", { fetchImpl: vazio })).toMatchObject({ status: 200, body: null });
    const html404 = (async () => new Response("<html>nope</html>", { status: 404, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    expect(await httpJson("odoo", "https://x", { fetchImpl: html404 })).toMatchObject({ status: 404 });
  });
});

describe("trilha de auditoria (audited)", () => {
  it("registra endpoint/status no sucesso e na falha, e um banco fora não derruba a chamada", async () => {
    const rows: unknown[] = [];
    const audit = trilha(async (e) => { rows.push(e); });
    await audited(audit, "asaas_out", "GET /payments/:id", { id: 1 }, async () => ({ status: 200, body: {}, durationMs: 7 }));
    await audited(audit, "odoo_out", "account.move.search_read", ["domain"], async () => { throw new HttpError("odoo", 503, null); }).catch(() => undefined);
    await new Promise((r) => setImmediate(r));
    expect(rows).toMatchObject([
      { direction: "asaas_out", endpoint: "GET /payments/:id", responseStatus: 200, durationMs: 7 },
      { direction: "odoo_out", endpoint: "account.move.search_read", responseStatus: 503 },
    ]);
    const quebrado = trilha(async () => { throw new Error("banco fora"); });
    await expect(audited(quebrado, "asaas_out", "POST /payments", null, async () => ({ status: 200, body: null, durationMs: 1 }))).resolves.toMatchObject({ status: 200 });
    await expect(audited(null, "asaas_out", "POST /payments", null, async () => ({ status: 200, body: null, durationMs: 1 }))).resolves.toMatchObject({ status: 200 });
  });
});
