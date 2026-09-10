// Aplica db/migrations/*.sql em ordem. A lógica vive em adapters/db/migrations.ts (applyMigrations),
// compartilhada com o modo demo: uma transação por arquivo, com lock entre processos.
import pg from "pg";
import { applyMigrations } from "../adapters/db/migrations.js";
import { DEFAULT_DATABASE_URL } from "../adapters/db/pool.js";

async function main() {
  const e = process.env;
  const url = e.DATABASE_URL ?? (e.PGHOST ? `postgres://${encodeURIComponent(e.PGUSER ?? "motor")}:${encodeURIComponent(e.PGPASSWORD ?? "")}@${e.PGHOST}:${e.PGPORT ?? "5432"}/${e.PGDATABASE ?? "motor"}` : DEFAULT_DATABASE_URL);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const applied = await applyMigrations(client, { onApplied: (f) => console.log(`applied ${f}`) });
    console.log(`ok — ${applied.length} applied now`);
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
