// O núcleo é portátil por construção: nenhum import de infra dentro de src/core.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FORBIDDEN = [/from\s+["']pg["']/, /from\s+["']hono/, /from\s+["']@supabase/, /\bDeno\./, /process\.env/, /\bfetch\(/, /from\s+["']\.\.\/adapters/, /from\s+["']\.\.\/\.\.\/adapters/, /from\s+["']\.\.\/app/];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = path.join(dir, f); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });
}

describe("fronteira do núcleo", () => {
  it("src/core não importa pg, hono, supabase, Deno, env, fetch nem adaptadores", () => {
    const bad: string[] = [];
    for (const f of files(path.resolve("src/core"))) {
      const src = readFileSync(f, "utf8");
      for (const re of FORBIDDEN) if (re.test(src)) bad.push(`${path.relative(process.cwd(), f)} ~ ${re}`);
    }
    expect(bad).toEqual([]);
  });
});
