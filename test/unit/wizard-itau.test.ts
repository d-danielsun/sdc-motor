// BLOQ-2 e R4: o passo de rede do wizard do Itaú (scripts/itau-sts.sh), com um curl falso no PATH. Nada sai da máquina.
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { gerarPki, type Pki } from "../itau-fixtures.js";

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

// N5: o wizard INTEIRO, com respostas por stdin, curl e op falsos no PATH. Nada sai da máquina.
describe("wizard Itaú — retomada depois que a resposta da solicitação sumiu (N5)", () => {
  let pki: Pki;
  beforeAll(() => { pki = gerarPki(); });
  afterAll(() => pki?.cleanup());

  /** Pasta de trabalho com o par RSA do e-mail; `op` falso: sem sessão, ou com os itens "Itaú SDC - …" guardados. */
  function wizard(o: { op: "sem-sessao" | "com-itens" }) {
    const s = sandbox();
    const work = join(s.d, "work"); mkdirSync(work);
    execFileSync("openssl", ["genrsa", "-out", join(work, "private.pem"), "2048"], { stdio: "pipe" });
    execFileSync("openssl", ["rsa", "-in", join(work, "private.pem"), "-pubout", "-out", join(work, "public.pem")], { stdio: "pipe" });
    const op = join(s.d, "op");
    writeFileSync(op, `#!/usr/bin/env bash\necho "$*" >> "${s.d}/op-calls"\n${o.op === "com-itens" ? "exit 0" : "exit 1"}\n`);
    chmodSync(op, 0o755);
    const run = (respostas: string[]) => spawnSync("bash", [resolve("scripts/wizard-sdc-itau.sh")], {
      input: respostas.join("\n") + "\n", encoding: "utf8", timeout: 20_000,
      env: { PATH: `${s.d}:${process.env.PATH}`, HOME: s.d, ITAU_WORKDIR: work, ITAU_ENV_FILE: join(s.d, "env.local"), ITAU_STS: "https://sts.invalid" },
    });
    return { ...s, work, run, cert: join(work, "itau-cert.crt"), key: join(work, "itau-cert.key") };
  }
  //                 banner  agência  conta      pausas 1–3   client id
  const ATE_O_ID = ["",      "1234",  "12345-6", "", "", "",  "cid-teste"];
  const PEDE_TOKEN = "Token temporário (não aparece na tela)";

  it("certificado e chave já salvos no disco → não pede o token consumido, não refaz o POST, não regera a chave", () => {
    const w = wizard({ op: "sem-sessao" });
    writeFileSync(w.cert, pki.clientCert); writeFileSync(w.key, pki.clientKey);
    //                        pausa 3  pausa 4  secret     pausa 5  pausa 6  testar token?  pausa 7
    const r = w.run([...ATE_O_ID, "",  "",      "sec-xyz", "",      "",      "n",           ""]);
    expect(r.stdout).not.toContain(PEDE_TOKEN);
    expect(r.stdout).toMatch(/certificado já foi emitido/);
    expect(r.stdout).not.toContain("Sobrescrever?");   // regerar a chave inutilizaria o certificado emitido
    expect(r.stdout).not.toContain("Enviar a solicitação agora?");
    expect(w.calls()).toBe(0);
    expect(readFileSync(w.key, "utf8")).toBe(pki.clientKey);
    expect(r.stdout).toContain("certificado corresponde à chave gerada");
    expect(r.status).toBe(0);
  });

  it("guardados só no 1Password → para com o comando exato de restauração, sem pedir token nem chamar o banco", () => {
    const w = wizard({ op: "com-itens" });
    const r = w.run([...ATE_O_ID, "", "", "", "", "", "", ""]);
    expect(r.stdout).not.toContain(PEDE_TOKEN);
    expect(r.stdout).toMatch(/op document get "Itaú SDC - certificado" --out-file/);
    expect(r.stdout).toMatch(/op document get "Itaú SDC - chave do certificado" --out-file/);
    expect(r.status).toBe(1);
    expect(w.calls()).toBe(0);
    expect(existsSync(w.key)).toBe(false);   // parou antes de gerar chave nova
  });

  it("certificado no disco que NÃO é o da chave → não conta como emitido: o fluxo normal segue pedindo o token", () => {
    const w = wizard({ op: "sem-sessao" });
    writeFileSync(w.cert, pki.clientCert); writeFileSync(w.key, pki.otherKey);
    //                        token  pausa 3  sobrescrever?  pausa 4  enviar?
    const r = w.run([...ATE_O_ID, "tok", "",   "y",           "",      "n"]);
    expect(r.stdout).toContain(PEDE_TOKEN);
    expect(r.status).toBe(0);
    expect(w.calls()).toBe(0);
  });

  it("nada salvo (primeira vez) → pede o token como sempre", () => {
    const w = wizard({ op: "sem-sessao" });
    //                        token  pausa 3  pausa 4  enviar?
    const r = w.run([...ATE_O_ID, "tok", "",   "",      "n"]);
    expect(r.stdout).toContain(PEDE_TOKEN);
    expect(r.stdout).not.toMatch(/certificado já foi emitido/);
    expect(r.status).toBe(0);
    expect(w.calls()).toBe(0);
  });
});
