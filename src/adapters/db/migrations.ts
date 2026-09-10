// O motor não sobe num banco sem migração (lição U3 do QA): recusar no boot com mensagem > 500 nos webhooks.
import { readdir } from "node:fs/promises";
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
