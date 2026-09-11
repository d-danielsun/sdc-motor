// HTTP do motor. Dois webhooks que respondem 200 rápido e um health. Toda lógica está no núcleo.
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { bodyLimit } from "hono/body-limit";
import { normalizeAsaasEvent } from "../core/asaasPayload.js";
import { RAW_PAYLOAD_MAX } from "../core/limits.js";
import type { Repo } from "../core/ports.js";

export interface ServerDeps {
  repo: Repo; asaasWebhookToken: string; odooWebhookKey: string;
  log: (msg: string, ctx?: Record<string, unknown>) => void;
  console?: Hono;
  /** Arquivos da SPA do console. Ausente = não serve nada em /console (Supabase serve pelo CDN). */
  staticRoot?: string;
}

/** Comparação em tempo constante por hash: tamanho diferente ou multibyte nunca lança (review 09/09). */
export const safeEqual = (a: string | undefined | null, b: string): boolean => {
  if (!a) return false;
  const h = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(h(a), h(b));
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const BODY_LIMIT = 256 * 1024;

export function createServer(d: ServerDeps): Hono {
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: BODY_LIMIT, onError: (c) => c.json({ ok: false, code: "invalid_input", error: "body too large" }, 413) }));
  app.onError((e, c) => { d.log("erro não tratado", { path: c.req.path, error: e.message }); return c.json({ ok: false, code: "internal", error: "internal error" }, 500); });
  app.notFound((c) => c.json({ ok: false, code: "not_found", error: "not found" }, 404));

  app.get("/health", async (c) => {
    try {
      const ida = await d.repo.config.get<boolean>("IDA_ENABLED");
      return c.json({ ok: true, idaEnabled: ida === true });
    } catch (e) {
      d.log("health: banco indisponível", { error: (e as Error).message });
      return c.json({ ok: false, code: "db_unavailable", error: "banco indisponível ou sem migração" }, 503);
    }
  });

  // Asaas → nós. Sempre 200 (inclusive duplicado/irrelevante/malformado): 15 falhas interrompem a fila.
  app.post("/webhook-asaas", async (c) => {
    if (!safeEqual(c.req.header("asaas-access-token"), d.asaasWebhookToken)) return c.json({ ok: false, code: "unauthorized", error: "unauthorized" }, 401);
    const raw = await c.req.text();
    try {
      let body: unknown = null;
      try { body = JSON.parse(raw); } catch { /* malformado: guardamos cru abaixo */ }
      const ev = normalizeAsaasEvent(body);
      if (ev) {
        const id = await d.repo.asaasEvents.insert({ asaasEventId: ev.id, eventType: ev.event, asaasPaymentId: ev.payment.id, payload: body });
        d.log("webhook asaas", { event: ev.event, id: ev.id, payment: ev.payment.id, inserted: id !== null });
      } else {
        const eventId = `raw:${createHash("sha256").update(raw).digest("hex")}`;
        const id = await d.repo.asaasEvents.insert({ asaasEventId: eventId, eventType: "UNPARSEABLE", asaasPaymentId: null, payload: { raw: raw.slice(0, RAW_PAYLOAD_MAX) } });
        if (id !== null) {
          await d.repo.asaasEvents.mark(id, "error", { error: "payload não reconhecido" });
          await d.repo.exceptions.openOnce({ type: "integration_error", refTable: "webhook_events", refId: id, detail: { reason: "webhook do Asaas com payload não reconhecido (mudança de formato?)", bytes: raw.length } });
        }
        d.log("webhook asaas malformado", { id: eventId });
      }
    } catch (e) {
      // Banco fora: sem persistir, o evento se perderia num 200. 503 faz o Asaas tentar de novo.
      d.log("webhook asaas: falha ao persistir", { error: (e as Error).message });
      return c.json({ ok: false, code: "db_unavailable", error: "temporarily unavailable" }, 503);
    }
    return c.json({ ok: true });
  });

  // Odoo → nós. A URL é o segredo (token no ?k=); só gravamos _model/_id e respondemos em <300 ms.
  app.post("/webhook-odoo", async (c) => {
    if (!safeEqual(c.req.query("k"), d.odooWebhookKey)) return c.json({ ok: false, code: "not_found", error: "not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ ok: false, code: "invalid_input", error: "bad json" }, 400); }
    if (!isObject(body)) return c.json({ ok: false, code: "invalid_input", error: "expected JSON object" }, 400);
    const model = body._model, id = body._id;
    if (typeof model !== "string" || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      return c.json({ ok: false, code: "invalid_input", error: "expected _model (string) and _id (positive int)" }, 400);
    }
    try {
      const idaEnabled = (await d.repo.config.get<boolean>("IDA_ENABLED")) === true;
      const status = model !== "account.move" || !idaEnabled ? "ignored" : "pending";
      const eventId = await d.repo.odooEvents.insert({ odooModel: model, odooId: id, odooAction: typeof body._action === "string" ? body._action.slice(0, 200) : null, payload: { _model: model, _id: id, _action: body._action ?? null }, status });
      // eventId null = já havia notificação PENDENTE para esta fatura. O Odoo dispara por
      // gravação, não por transição, então isso é o caso comum, não erro. 200 de qualquer jeito:
      // o Odoo desiste em 1s e não reenvia.
      d.log(eventId === null ? "webhook odoo: notificação colapsada (já havia pendente)" : "webhook odoo", { model, id, eventId, status });
      return c.json({ ok: true });
    } catch (e) {
      d.log("webhook odoo: falha ao persistir", { error: (e as Error).message });
      return c.json({ ok: false, code: "db_unavailable", error: "temporarily unavailable" }, 503);   // o Odoo não reenvia; a varredura de 15 min cobre
    }
  });

  if (d.console) app.route("/api/v1", d.console);

  // SPA do console. Sem build e sem framework: três arquivos estáticos que conversam com a
  // /api/v1. O redirect existe porque `/console` sem barra faria os caminhos relativos
  // resolverem para a raiz.
  if (d.staticRoot) {
    app.get("/console", (c) => c.redirect("/console/", 302));
    app.use("/console/*", serveStatic({ root: d.staticRoot, rewriteRequestPath: (p) => p.replace(/^\/console/, "") || "/" }));
    // Rota do hash router que chega sem arquivo (F5 em /console/qualquer-coisa) cai no index.
    app.get("/console/*", serveStatic({ root: d.staticRoot, path: "/index.html" }));
  }
  return app;
}
