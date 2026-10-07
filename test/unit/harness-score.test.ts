// R5: o harness (docs/sprint-itau/harness/score.sh) tem que reprovar quando o vitest sai ≠ 0 ou o JSON não parseia.
// `npm` e `npx` são falsos no PATH: o score real não roda a suíte aqui dentro (seria recursão).
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Roda o score.sh com um vitest falso que imprime `saida` e sai com `exit`. */
function score(saida: string, exit: number) {
  const d = mkdtempSync(join(tmpdir(), "score-")); dirs.push(d);
  writeFileSync(join(d, "saida"), saida);
  writeFileSync(join(d, "npm"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(d, "npx"), `#!/usr/bin/env bash\ncat "${d}/saida"\nexit ${exit}\n`);
  for (const f of ["npm", "npx"]) chmodSync(join(d, f), 0o755);
  return spawnSync("bash", ["docs/sprint-itau/harness/score.sh"], { encoding: "utf8", env: { ...process.env, PATH: `${d}:${process.env.PATH}` } });
}
const VERDE = 'ruído antes do json\n{"numPassedTests":300,"numFailedTests":0}\n';

describe("harness score.sh — exit code do vitest (R5)", () => {
  it("JSON verde mas vitest saiu ≠ 0 (erro fora de teste, suíte que não carregou) → hard-fail", () => {
    const r = score(VERDE, 1);
    expect(r.stdout).toMatch(/FAIL vitest saiu com 1/);
    expect(r.stdout).toContain("HARD-FAILS: presentes");
    expect(r.status).not.toBe(0);
  });

  it("JSON não parseável → hard-fail dizendo isso, mesmo com exit 0", () => {
    const r = score("Error: Cannot find module\n", 0);
    expect(r.stdout).toMatch(/FAIL JSON do vitest não parseável/);
    expect(r.stdout).toContain("HARD-FAILS: presentes");
    expect(r.status).not.toBe(0);
  });

  it("saída vazia → hard-fail", () => {
    const r = score("", 0);
    expect(r.stdout).toMatch(/FAIL JSON do vitest não parseável/);
    expect(r.status).not.toBe(0);
  });

  it("JSON verde e exit 0 → os checks do vitest passam, com a contagem lida do JSON", () => {
    const r = score(VERDE, 0);
    expect(r.stdout).toMatch(/ok {3}vitest saiu com 0/);
    expect(r.stdout).toMatch(/ok {3}testes verdes \(300\)/);
    expect(r.stdout).not.toMatch(/FAIL (vitest|JSON|testes|contagem)/);
  });

  it("teste vermelho no JSON continua reprovando", () => {
    const r = score('{"numPassedTests":299,"numFailedTests":1}\n', 1);
    expect(r.stdout).toMatch(/FAIL testes vermelhos \(1\)/);
    expect(r.status).not.toBe(0);
  });
});
