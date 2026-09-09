// API do console (/api/v1). Auth: Bearer CONSOLE_TOKEN (portátil); no Supabase, o gateway troca por JWT do Auth com a mesma allowlist [Q7].
import { Hono } from "hono";
import type { ConsoleQueries, HealthReport } from "../core/console.js";
import type { Deps } from "../core/ports.js";
import type { ChargeStatus, ExceptionType } from "../core/types.js";
import { acceptWriteoff, enableCustomerNotifications, reprocessException, resolveException, setConsoleConfig } from "../core/usecases/console.js";
import { CONSOLE_CONFIG_KEYS } from "../core/console.js";
import { safeEqual } from "./server.js";

export interface ConsoleDeps { deps: Deps; queries: ConsoleQueries; token: string | null }

export function createConsoleApi(c: ConsoleDeps): Hono {
  const api = new Hono();
  api.use("*", async (ctx, next) => {
    if (!c.token) return ctx.json({ error: "console desabilitado: CONSOLE_TOKEN ausente" }, 503);
    const auth = ctx.req.header("authorization") ?? "";
    if (!safeEqual(auth.startsWith("Bearer ") ? auth.slice(7) : null, c.token)) return ctx.json({ error: "unauthorized" }, 401);
    await next();
  });
  const who = (ctx: { req: { header: (n: string) => string | undefined } }) => ctx.req.header("x-user") ?? "console";
  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));

  api.get("/exceptions", async (ctx) => ctx.json(await c.queries.exceptions({
    status: ctx.req.query("status") as "open" | "resolved" | "ignored" | undefined, type: ctx.req.query("type") as ExceptionType | undefined,
    limit: num(ctx.req.query("limit")), offset: num(ctx.req.query("offset")),
  })));
  api.get("/exceptions/:id", async (ctx) => { const r = await c.queries.exception(Number(ctx.req.param("id"))); return r ? ctx.json(r) : ctx.json({ error: "not found" }, 404); });
  api.post("/exceptions/:id/resolve", async (ctx) => { const r = await resolveException(c.deps, Number(ctx.req.param("id")), who(ctx), "resolved"); return ctx.json(r, r.ok ? 200 : 400); });
  api.post("/exceptions/:id/ignore", async (ctx) => { const r = await resolveException(c.deps, Number(ctx.req.param("id")), who(ctx), "ignored"); return ctx.json(r, r.ok ? 200 : 400); });
  api.post("/exceptions/:id/reprocess", async (ctx) => { const r = await reprocessException(c.deps, Number(ctx.req.param("id")), who(ctx)); return ctx.json(r, r.ok ? 200 : 400); });
  api.post("/exceptions/:id/accept-writeoff", async (ctx) => { const r = await acceptWriteoff(c.deps, Number(ctx.req.param("id")), who(ctx)); return ctx.json(r, r.ok ? 200 : 400); });

  api.get("/charges", async (ctx) => ctx.json(await c.queries.charges({
    status: ctx.req.query("status")?.split(",").filter(Boolean) as ChargeStatus[] | undefined,
    dueFrom: ctx.req.query("due_from"), dueTo: ctx.req.query("due_to"), partnerId: num(ctx.req.query("partner")), q: ctx.req.query("q"),
    limit: num(ctx.req.query("limit")), offset: num(ctx.req.query("offset")),
  })));
  api.get("/charges/:id", async (ctx) => { const r = await c.queries.charge(Number(ctx.req.param("id"))); return r ? ctx.json(r) : ctx.json({ error: "not found" }, 404); });

  api.get("/dashboard", async (ctx) => ctx.json({ today: c.deps.clock.today(), aging: await c.queries.aging(c.deps.clock.today()) }));

  api.get("/health-report", async (ctx) => {
    const { repo, asaas, clock } = c.deps;
    const open = await c.queries.exceptions({ status: "open", limit: 200 });
    const byType: Record<string, number> = {};
    for (const e of open.data) byType[e.type] = (byType[e.type] ?? 0) + 1;
    const whId = await repo.config.get<string | null>("ASAAS_WEBHOOK_ID");
    let wh: { interrupted: boolean; penalizedRequestsCount: number } | null = null;
    try { wh = whId ? await asaas.getWebhook(whId) : null; } catch { wh = null; }
    const keyCreated = await repo.config.get<string | null>("ODOO_API_KEY_CREATED_AT");
    const report: HealthReport = {
      idaEnabled: (await repo.config.get<boolean>("IDA_ENABLED")) === true,
      openCharges: await repo.charges.countOpen(), openExceptionsByType: byType,
      lastAsaasEventAt: (await repo.asaasEvents.lastReceivedAt())?.toISOString() ?? null, lastOdooEventAt: await c.queries.lastOdooEventAt(),
      lastSync: await repo.config.get("SYNC_LAST"), lastReconcile: await repo.config.get("RECONCILE_LAST"), lastWatchdog: await repo.config.get("WATCHDOG_LAST"),
      webhook: { id: whId, interrupted: wh?.interrupted ?? null, penalizedRequestsCount: wh?.penalizedRequestsCount ?? null },
      odooApiKeyAgeDays: keyCreated ? Math.floor((clock.now().getTime() - new Date(keyCreated).getTime()) / 86_400_000) : null,
    };
    return ctx.json(report);
  });

  api.get("/config", async (ctx) => {
    const out: Record<string, unknown> = {};
    for (const k of CONSOLE_CONFIG_KEYS) out[k] = await c.deps.repo.config.get(k);
    return ctx.json(out);
  });
  api.put("/config/:key", async (ctx) => {
    let body: { value?: unknown };
    try { body = (await ctx.req.json()) as { value?: unknown }; } catch { return ctx.json({ ok: false, error: "bad json" }, 400); }
    const r = await setConsoleConfig(c.deps, ctx.req.param("key"), body.value);
    return ctx.json(r, r.ok ? 200 : 400);
  });
  api.post("/customers/enable-notifications", async (ctx) => ctx.json(await enableCustomerNotifications(c.deps)));
  return api;
}
