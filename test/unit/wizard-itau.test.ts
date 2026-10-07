// BLOQ-2 e R4: o passo de rede do wizard do Itaú (scripts/itau-sts.sh), com um curl falso no PATH. Nada sai da máquina.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HELPER = resolve("scripts/itau-sts.sh");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Pasta com um curl falso: grava argv e stdin, escreve o corpo em -o e imprime o status. */
function sandbox(o: { status?: string; body?: string } = {}) {
  const d = mkdtempSync(join(tmpdir(), "wiz-itau-")); dirs.push(d);
  const curl = join(d, "curl");
  writeFileSync(curl, `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${d}/argv"; cat > "${d}/stdin"; echo x >> "${d}/calls"
out=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-o" ]] && out="$2"; shift; done
printf '%s' '${o.body ?? "CERT+SECRET"}' > "$out"; printf '%s' '${o.status ?? "200"}'
`);
  chmodSync(curl, 0o755);
  writeFileSync(join(d, "req.csr"), "CSR");
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [HELPER, ...args], { env: { ...process.env, PATH: `${d}:${process.env.PATH}`, ...env }, encoding: "utf8" });
  const calls = () => (existsSync(join(d, "calls")) ? readFileSync(join(d, "calls"), "utf8").trim().split("\n").length : 0);
  return { d, run, calls, resp: join(d, "resp.txt") };
}

describe("wizard Itaú — solicitação do certificado (BLOQ-2)", () => {
  it("resposta já obtida e não vazia → NÃO refaz o POST e não toca no arquivo", () => {
    const s = sandbox({ body: "RECUSADO" });
    writeFileSync(s.resp, "SECRET-ORIGINAL");
    const r = s.run(["solicitar", "https://sts.invalid", join(s.d, "req.csr"), s.resp], { ITAU_TOKEN_TEMPORARIO: "tok" });
    expect(r.status).toBe(0);
    expect(s.calls()).toBe(0);
    expect(readFileSync(s.resp, "utf8")).toBe("SECRET-ORIGINAL");
  });

  it("sem resposta → faz o POST, grava com permissão 600, sem sobra de temporário, token fora do argv", () => {
    const s = sandbox();
    const r = s.run(["solicitar", "https://sts.invalid", join(s.d, "req.csr"), s.resp], { ITAU_TOKEN_TEMPORARIO: "tok-secreto" });
    expect(r.status).toBe(0);
    expect(s.calls()).toBe(1);
    expect(readFileSync(s.resp, "utf8")).toBe("CERT+SECRET");
    expect(statSync(s.resp).mode & 0o777).toBe(0o600);
    expect(readdirSync(s.d).filter((f) => f.startsWith("resp.txt."))).toEqual([]);
    expect(readFileSync(join(s.d, "argv"), "utf8")).not.toContain("tok-secreto");
    expect(readFileSync(join(s.d, "stdin"), "utf8")).toContain("tok-secreto");
  });

  it("resposta vazia (tentativa anterior sem corpo) → pode refazer o POST", () => {
    const s = sandbox();
    writeFileSync(s.resp, "");
    expect(s.run(["solicitar", "https://sts.invalid", join(s.d, "req.csr"), s.resp], { ITAU_TOKEN_TEMPORARIO: "t" }).status).toBe(0);
    expect(s.calls()).toBe(1);
  });

  it("banco recusa → sai com erro e guarda o corpo da recusa sem apagar nada", () => {
    const s = sandbox({ status: "401", body: "nope" });
    const r = s.run(["solicitar", "https://sts.invalid", join(s.d, "req.csr"), s.resp], { ITAU_TOKEN_TEMPORARIO: "t" });
    expect(r.status).not.toBe(0);
    expect(existsSync(s.resp)).toBe(false);   // a recusa não ocupa o lugar da resposta boa
  });
});

describe("wizard Itaú — segredos fora do argv (R4)", () => {
  it("token de teste: client_secret vai por stdin, não por argumento", () => {
    const s = sandbox({ body: '{"access_token":"x"}' });
    const r = s.run(["token", "https://sts.invalid", "c.crt", "c.key", join(s.d, "corpo")], { ITAU_CLIENT_ID: "cid", ITAU_CLIENT_SECRET: "sec-123" });
    expect(r.stdout.trim()).toBe("200");
    expect(readFileSync(join(s.d, "argv"), "utf8")).not.toContain("sec-123");
    expect(readFileSync(join(s.d, "stdin"), "utf8")).toContain("sec-123");
  });

  it("o wizard usa o helper e não interpola segredo em linha de comando", () => {
    const w = readFileSync("scripts/wizard-sdc-itau.sh", "utf8").split("# STAGES")[1]!;
    expect(w).toContain("itau-sts.sh");
    expect(w).not.toMatch(/Bearer \$\{?ITAU_TOKEN/);
    expect(w).not.toMatch(/client_secret=\$\{?ITAU_CLIENT_SECRET/);
    expect(w).not.toMatch(/password=\$\{?ITAU_CLIENT_SECRET/);
  });
});
