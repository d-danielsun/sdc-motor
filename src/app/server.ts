// HTTP do motor. Dois webhooks que respondem 200 rápido e um health. Toda lógica está no núcleo.
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Repo } from "../core/ports.js";
import { normalizeAsaasEvent } from "../core/asaasPayload.js";

export interface ServerDeps { repo: Repo; asaasWebhookToken: string; odooWebhookKey: string; log: (msg: string, ctx?: Record<string, unknown>) => void; console?: Hono }

export const safeEqual = (a: string | undefined | null, b: string): boolean => {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

export function createServer(d: ServerDeps): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const ida = await d.repo.config.get<boolean>("IDA_ENABLED");
    return c.json({ ok: true, idaEnabled: ida === true });
  });

  // Asaas → nós. Sempre 200 (inclusive duplicado/irrelevante/malformado): 15 falhas interrompem a fila.
  app.post("/webhook-asaas", async (c) => {
    if (!safeEqual(c.req.header("asaas-access-token"), d.asaasWebhookToken)) return c.json({ error: "unauthorized" }, 401);
    const raw = await c.req.text();
    let body: unknown = null;
    try { body = JSON.parse(raw); } catch { /* malformado: guardamos cru abaixo */ }
    const ev = normalizeAsaasEvent(body);
    if (ev) {
      const inserted = await d.repo.asaasEvents.insert({ asaasEventId: ev.id, eventType: ev.event, asaasPaymentId: ev.payment.id, payload: body });
      d.log("webhook asaas", { event: ev.event, id: ev.id, payment: ev.payment.id, inserted });
    } else {
      const { createHash } = await import("node:crypto");
      const id = `raw:${createHash("sha256").update(raw).digest("hex")}`;
      const inserted = await d.repo.asaasEvents.insert({ asaasEventId: id, eventType: "UNPARSEABLE", asaasPaymentId: null, payload: { raw: raw.slice(0, 20_000) } });
      if (inserted) await d.repo.asaasEvents.mark((await d.repo.asaasEvents.pending(1000, new Date(8640000000000000))).find((e) => e.asaasEventId === id)!.id, "error", { error: "payload não reconhecido" });
      d.log("webhook asaas malformado", { id });
    }
    return c.json({ ok: true });
  });

  // Odoo → nós. A URL é o segredo (token no ?k=); só gravamos _model/_id e respondemos em <300 ms.
  app.post("/webhook-odoo", async (c) => {
    if (!safeEqual(c.req.query("k"), d.odooWebhookKey)) return c.notFound();
    let body: Record<string, unknown>;
    try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "bad json" }, 400); }
    const model = body._model, id = body._id;
    if (typeof model !== "string" || typeof id !== "number") {
      await d.repo.audit.log({ direction: "odoo_in", endpoint: "/webhook-odoo", responseStatus: 400, requestSummary: Object.keys(body) });
      return c.json({ error: "expected _model (string) and _id (int)" }, 400);
    }
    const idaEnabled = (await d.repo.config.get<boolean>("IDA_ENABLED")) === true;
    const eventId = await d.repo.odooEvents.insert({ odooModel: model, odooId: id, odooAction: typeof body._action === "string" ? body._action : null, payload: body, status: idaEnabled ? "pending" : "ignored" });
    d.log("webhook odoo", { model, id, eventId, idaEnabled });
    return c.json({ ok: true });
  });

  if (d.console) app.route("/api/v1", d.console);
  return app;
}
