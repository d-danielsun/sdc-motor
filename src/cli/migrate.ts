// Aplica db/migrations/*.sql em ordem, uma transação por arquivo, com lock entre processos (dois containers subindo).
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { MIGRATIONS_DIR, pendingMigrations } from "../adapters/db/migrations.js";
import { DEFAULT_DATABASE_URL } from "../adapters/db/pool.js";

async function main() {
  const e = process.env;
  const url = e.DATABASE_URL ?? (e.PGHOST ? `postgres://${encodeURIComponent(e.PGUSER ?? "motor")}:${encodeURIComponent(e.PGPASSWORD ?? "")}@${e.PGHOST}:${e.PGPORT ?? "5432"}/${e.PGDATABASE ?? "motor"}` : DEFAULT_DATABASE_URL);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('sdc-motor:migrate'))");
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const pending = await pendingMigrations(client);
    for (const f of pending) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, f), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [f]);
        await client.query("commit");
        console.log(`applied ${f}`);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
    console.log(`ok — ${pending.length} applied now`);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('sdc-motor:migrate'))").catch(() => undefined);
    await client.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
