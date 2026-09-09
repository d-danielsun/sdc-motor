// Aplica db/migrations/*.sql em ordem, uma transação por arquivo, registrando em schema_migrations.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgres://motor:motor@localhost:55432/motor";
const dir = path.resolve(process.cwd(), "db/migrations");

async function main() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const applied = new Set(
      (await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = await readFile(path.join(dir, f), "utf8");
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
    console.log(`ok — ${files.length} migrations, ${files.length - applied.size} applied now`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
