import { createPool } from "../src/adapters/db/pool.js";
import { createPgRepo } from "../src/adapters/db/repo.js";
import { FakeAsaas } from "../src/adapters/fakes/fakeAsaas.js";
import { FakeOdoo } from "../src/adapters/fakes/fakeOdoo.js";
import { fixedClock } from "../src/adapters/clock.js";
import type { Deps } from "../src/core/ports.js";

export const DB_URL = process.env.DATABASE_URL ?? "postgres://motor:motor@localhost:55432/motor";
const TABLES = ["reconciliations", "exceptions", "charges", "customers_map", "webhook_events", "odoo_events", "sync_watermarks", "audit_log"];

export async function dbReachable(): Promise<boolean> {
  const pool = createPool(DB_URL);
  try { await pool.query("select 1"); return true; } catch { return false; } finally { await pool.end(); }
}

export interface World { deps: Deps; odoo: FakeOdoo; asaas: FakeAsaas; logs: Array<{ msg: string; ctx?: Record<string, unknown> }>; close: () => Promise<void> }

export async function world(o: { today?: string; idaEnabled?: boolean } = {}): Promise<World> {
  const pool = createPool(DB_URL);
  await pool.query(`truncate ${TABLES.join(", ")} restart identity cascade`);
  await pool.query("update app_config set value=$1::jsonb where key='IDA_ENABLED'", [JSON.stringify(o.idaEnabled ?? true)]);
  await pool.query("update app_config set value='null'::jsonb where key in ('GO_LIVE_CUTOFF_DATE','ASAAS_WEBHOOK_ID')");
  await pool.query("delete from app_config where key in ('ASAAS_REACTIVATED_AT','ODOO_API_KEY_CREATED_AT','JUROS_MULTA_AUTO')");
  await pool.query("update app_config set value='0'::jsonb where key='ASAAS_PENALIZED_LAST'");
  const repo = createPgRepo(pool);
  const odoo = new FakeOdoo();
  const asaas = new FakeAsaas();
  const logs: World["logs"] = [];
  const deps: Deps = { repo, odoo, asaas, clock: fixedClock(`${o.today ?? "2026-09-10"}T13:00:00.000Z`), log: (msg, ctx) => logs.push({ msg, ctx }) };
  return { deps, odoo, asaas, logs, close: () => pool.end() };
}

export const CPF_OK = "52998224725";
export const CNPJ_OK = "19950162000119";
