// O motor não sobe num banco sem migração (lição U3 do QA): recusar no boot com mensagem > 500 nos webhooks.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
export const MIGRATIONS_DIR = path.resolve(process.cwd(), "db/migrations");

export async function listMigrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
}

export async function pendingMigrations(db: Q, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = await listMigrationFiles(dir);
  let applied = new Set<string>();
  try {
    applied = new Set((await db.query("select name from schema_migrations")).rows.map((r) => String(r.name)));
  } catch (e) {
    if ((e as { code?: string }).code !== "42P01") throw e;   // só "tabela não existe" significa "tudo pendente"
  }
  return files.filter((f) => !applied.has(f));
}

export async function assertMigrated(db: Q): Promise<void> {
  const pending = await pendingMigrations(db);
  if (pending.length) throw new Error(`banco sem migração aplicada: ${pending.join(", ")} — rode \`npm run db:migrate\` antes de subir o motor`);
}

/** Aplica as migrations pendentes: uma transação por arquivo, com advisory lock entre processos
 *  (dois containers subindo ao mesmo tempo). Usada pelo CLI de migração e pelo modo demo. */
export async function applyMigrations(db: Q, o: { dir?: string; onApplied?: (f: string) => void } = {}): Promise<string[]> {
  const dir = o.dir ?? MIGRATIONS_DIR;
  await db.query("select pg_advisory_lock(hashtext('sdc-motor:migrate'))");
  try {
    await db.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const pending = await pendingMigrations(db, dir);
    for (const f of pending) {
      const sql = await readFile(path.join(dir, f), "utf8");
      await db.query("begin");
      try {
        await db.query(sql);
        await db.query("insert into schema_migrations (name) values ($1)", [f]);
        await db.query("commit");
        o.onApplied?.(f);
      } catch (e) {
        await db.query("rollback");
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
    return pending;
  } finally {
    await db.query("select pg_advisory_unlock(hashtext('sdc-motor:migrate'))").catch(() => undefined);
  }
}
