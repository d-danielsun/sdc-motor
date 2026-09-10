// API do console (/api/v1). Auth: Bearer CONSOLE_TOKEN (portátil); no Supabase, o gateway troca por JWT do Auth com a mesma allowlist [Q7].
// Envelope de erro único: { ok:false, code, error } — code decide o status.
import { Hono } from "hono";
import type { Context } from "hono";
import type { ConsoleQueries } from "../core/console.js";
import { CONSOLE_CONFIG_KEYS, type ActionResult, type ErrorCode } from "../core/console.js";
import type { Deps } from "../core/ports.js";
import type { ChargeStatus, ExceptionType } from "../core/types.js";
import { acceptWriteoff, enableCustomerNotifications, healthReport, isIsoDate, reprocessException, resolveException, setConsoleConfig } from "../core/usecases/console.js";
import { safeEqual } from "./server.js";

export interface ConsoleDeps { deps: Deps; queries: ConsoleQueries; token: string | null }

const STATUS_BY_CODE: Record<ErrorCode | "internal" | "unauthorized", number> = { not_found: 404, invalid_state: 409, invalid_input: 400, upstream: 502, config: 500, busy: 409, internal: 500, unauthorized: 401 };
const EXC_STATUSES = ["open", "resolved", "ignored"] as const;
const EXC_TYPES: ExceptionType[] = ["customer_missing_document", "charge_create_failed", "payment_unmatched", "amount_divergent", "reversal_pending", "queue_interrupted", "stale_heartbeat", "api_key_expiring", "writeoff_needed", "webhook_penalized", "integration_error"];
const CHARGE_STATUSES: ChargeStatus[] = ["pending", "created", "confirmed", "received", "settled", "cancelled", "refunded", "exception"];

class BadInput extends Error { constructor(msg: string) { super(msg); } }
const intParam = (v: string | undefined, name: string, o: { min?: number; max?: number } = {}): number | undefined => {
  if (v === undefined || v === "") return undefined;
  if (!/^\d+$/.test(v)) throw new BadInput(`${name} deve ser inteiro`);
  const n = Number(v);
  if (!Number.isSafeInteger(n) || (o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max)) throw new BadInput(`${name} fora da faixa`);
  return n;
};
const idParam = (v: string): number => { const n = intParam(v, "id", { min: 1 }); if (n === undefined) throw new BadInput("id obrigatório"); return n; };
const dateParam = (v: string | undefined, name: string): string | undefined => { if (v === undefined || v === "") return undefined; if (!isIsoDate(v)) throw new BadInput(`${name} deve ser YYYY-MM-DD`); return v; };
const enumParam = <T extends string>(v: string | undefined, name: string, allowed: readonly T[]): T | undefined => { if (v === undefined || v === "") return undefined; if (!(allowed as readonly string[]).includes(v)) throw new BadInput(`${name} inválido`); return v as T; };
const send = (c: Context, r: ActionResult) => c.json(r, r.ok ? 200 : (STATUS_BY_CODE[r.code] as 400 | 404 | 409 | 500 | 502));
const who = (c: Context) => (c.req.header("x-user") ?? "console").replace(/[^\w.@+-]/g, "").slice(0, 64) || "console";   // asserção do cliente — ver README
async function jsonObject(c: Context): Promise<Record<string, unknown>> {
  let b: unknown;
  try { b = await c.req.json(); } catch { throw new BadInput("bad json"); }
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw new BadInput("expected JSON object");
  return b as Record<string, unknown>;
}

export function createConsoleApi(cd: ConsoleDeps): Hono {
  const api = new Hono();
  api.onError((e, c) => {
    if (e instanceof BadInput) return c.json({ ok: false, code: "invalid_input", error: e.message }, 400);
    cd.deps.log("console: erro não tratado", { path: c.req.path, error: e.message });
    return c.json({ ok: false, code: "internal", error: "internal error" }, 500);
  });
  api.notFound((c) => c.json({ ok: false, code: "not_found", error: "not found" }, 404));
  api.use("*", async (c, next) => {
    if (!cd.token) return c.json({ ok: false, code: "config", error: "console desabilitado: CONSOLE_TOKEN ausente" }, 503);
    const auth = c.req.header("authorization") ?? "";
    if (!safeEqual(auth.startsWith("Bearer ") ? auth.slice(7) : null, cd.token)) return c.json({ ok: false, code: "unauthorized", error: "unauthorized" }, 401);
    await next();
  });

  api.get("/exceptions", async (c) => c.json(await cd.queries.exceptions({
    status: enumParam(c.req.query("status"), "status", EXC_STATUSES), type: enumParam(c.req.query("type"), "type", EXC_TYPES),
    limit: intParam(c.req.query("limit"), "limit", { min: 1, max: 200 }), offset: intParam(c.req.query("offset"), "offset", { min: 0 }),
  })));
  api.get("/exceptions/:id", async (c) => { const r = await cd.queries.exception(idParam(c.req.param("id"))); return r ? c.json(r) : c.json({ ok: false, code: "not_found", error: "not found" }, 404); });
  api.post("/exceptions/:id/resolve", async (c) => send(c, await resolveException(cd.deps, idParam(c.req.param("id")), who(c), "resolved")));
  api.post("/exceptions/:id/ignore", async (c) => send(c, await resolveException(cd.deps, idParam(c.req.param("id")), who(c), "ignored")));
  api.post("/exceptions/:id/reprocess", async (c) => send(c, await reprocessException(cd.deps, idParam(c.req.param("id")), who(c))));
  api.post("/exceptions/:id/accept-writeoff", async (c) => send(c, await acceptWriteoff(cd.deps, idParam(c.req.param("id")), who(c))));

  api.get("/charges", async (c) => {
    const statuses = c.req.query("status")?.split(",").filter(Boolean);
    for (const s of statuses ?? []) enumParam(s, "status", CHARGE_STATUSES);
    const q = c.req.query("q");
    if (q !== undefined && q.length > 100) throw new BadInput("q muito longo");
    return c.json(await cd.queries.charges({
      status: statuses as ChargeStatus[] | undefined, dueFrom: dateParam(c.req.query("due_from"), "due_from"), dueTo: dateParam(c.req.query("due_to"), "due_to"),
      partnerId: intParam(c.req.query("partner"), "partner", { min: 1 }), q: q || undefined,
      limit: intParam(c.req.query("limit"), "limit", { min: 1, max: 200 }), offset: intParam(c.req.query("offset"), "offset", { min: 0 }),
    }));
  });
  api.get("/charges/:id", async (c) => { const r = await cd.queries.charge(idParam(c.req.param("id"))); return r ? c.json(r) : c.json({ ok: false, code: "not_found", error: "not found" }, 404); });

  api.get("/dashboard", async (c) => c.json({ today: cd.deps.clock.today(), aging: await cd.queries.aging(cd.deps.clock.today()) }));
  api.get("/health-report", async (c) => c.json(await healthReport(cd.deps, cd.queries)));

  api.get("/config", async (c) => {
    const out: Record<string, unknown> = {};
    for (const k of CONSOLE_CONFIG_KEYS) out[k] = await cd.deps.repo.config.get(k);
    return c.json(out);
  });
  api.put("/config/:key", async (c) => send(c, await setConsoleConfig(cd.deps, c.req.param("key"), (await jsonObject(c)).value)));
  api.post("/customers/enable-notifications", async (c) => send(c, await enableCustomerNotifications(cd.deps)));
  return api;
}
