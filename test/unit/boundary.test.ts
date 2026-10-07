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

// Pivô Itaú: o núcleo depende só da porta neutra (src/core/gateway.ts). Tipos e client do Asaas
// moram em src/adapters/asaas. Nomes legados que espelham colunas `asaas_*` (asaasPaymentId,
// repo.asaasEvents) são permitidos — ver docs/sprint-itau/implementation-notes.md.
describe("fronteira do gateway", () => {
  it("src/core não importa adapters/asaas nem usa tipos Asaas*", () => {
    const bad: string[] = [];
    for (const f of files(path.resolve("src/core"))) {
      const src = readFileSync(f, "utf8");
      for (const re of [/adapters\/asaas/, /\bAsaas[A-Z]\w*/, /\bdeps\.asaas\b/, /\basaas\s*:\s*AsaasClient/]) if (re.test(src)) bad.push(`${path.relative(process.cwd(), f)} ~ ${re}`);
    }
    expect(bad).toEqual([]);
  });
  it("Deps expõe o gateway pela porta, não o client do Asaas", () => {
    const ports = readFileSync(path.resolve("src/core/ports.ts"), "utf8");
    expect(ports).toMatch(/gateway:\s*ChargeGateway/);
    expect(ports).not.toMatch(/interface AsaasClient/);
  });
});
