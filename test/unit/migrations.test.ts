// Integridade das migrations (#7). Unitário de propósito: o alvo é a decisão de RECUSAR, e ela
// depende só do que o banco diz ter aplicado mais o que está no disco. Com banco de verdade estes
// testes teriam que compartilhar `schema_migrations` com as migrations reais do repo, e um teste
// que insere linha lá suja o próximo — foi exatamente o que aconteceu na primeira tentativa.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MigrationDivergente, listMigrationFiles, pendingMigrations, sha256, verificarIntegridade } from "../../src/adapters/db/migrations.js";

/** Banco falso: devolve as linhas de `schema_migrations` que o teste quiser. */
const banco = (linhas: Array<{ name: string; content_sha256: string | null }>) => ({
  query: async (sql: string) => {
    if (/from schema_migrations/.test(sql)) return { rows: linhas as unknown as Array<Record<string, unknown>> };
    return { rows: [] };
  },
});

const pasta = async (arquivos: Record<string, string>) => {
  const d = await mkdtemp(path.join(tmpdir(), "mig-"));
  for (const [nome, sql] of Object.entries(arquivos)) await writeFile(path.join(d, nome), sql);
  return d;
};

describe("hash do conteúdo (#7)", () => {
  it("disco igual ao banco: passa", async () => {
    const d = await pasta({ "0001_a.sql": "select 1;" });
    await expect(verificarIntegridade(banco([{ name: "0001_a.sql", content_sha256: sha256("select 1;") }]), d)).resolves.toEqual({ semHash: [] });
  });

  it("editar uma migration já aplicada é recusado, com os DOIS hashes (AC4)", async () => {
    const antes = "select 1;", depois = "select 2;   -- alguém editou depois de aplicada";
    const d = await pasta({ "0001_a.sql": depois });
    const erro = await verificarIntegridade(banco([{ name: "0001_a.sql", content_sha256: sha256(antes) }]), d).then(() => null).catch((e: unknown) => e as Error);
    expect(erro).toBeInstanceOf(MigrationDivergente);
    expect(erro!.message).toContain("0001_a.sql");
    expect(erro!.message).toContain(sha256(antes));    // o que o banco tem
    expect(erro!.message).toContain(sha256(depois));   // o que está no disco
    expect(erro!.message).toContain("forward-only");   // e o que fazer em vez disso
  });

  it("hash nulo (banco anterior à 0008) vira backfill, não recusa", async () => {
    const d = await pasta({ "0001_a.sql": "select 1;", "0002_b.sql": "select 2;" });
    const r = await verificarIntegridade(banco([
      { name: "0001_a.sql", content_sha256: null },
      { name: "0002_b.sql", content_sha256: sha256("select 2;") },
    ]), d);
    expect(r.semHash).toEqual([{ name: "0001_a.sql", hash: sha256("select 1;") }]);
  });

  it("migration aplicada que sumiu do disco é recusada — banco e código de versões diferentes", async () => {
    const d = await pasta({ "0001_a.sql": "select 1;" });
    await expect(verificarIntegridade(banco([
      { name: "0001_a.sql", content_sha256: sha256("select 1;") },
      { name: "0002_sumiu.sql", content_sha256: "abc" },
    ]), d)).rejects.toThrow(/0002_sumiu\.sql.*não existe/s);
  });

  it("espaço em branco conta: o hash é do arquivo, não da intenção", async () => {
    const d = await pasta({ "0001_a.sql": "select 1;\n" });
    await expect(verificarIntegridade(banco([{ name: "0001_a.sql", content_sha256: sha256("select 1;") }]), d)).rejects.toThrow(MigrationDivergente);
  });
});

describe("ordem estrita (#7)", () => {
  it("arquivo novo que ordene ANTES da última aplicada é recusado (AC5)", async () => {
    // O caso real: dois PRs em paralelo criam 0008 e 0009, e o 0009 mergeia primeiro.
    const d = await pasta({ "0008_meu.sql": "select 8;", "0009_dela.sql": "select 9;" });
    const erro = await verificarIntegridade(banco([{ name: "0009_dela.sql", content_sha256: sha256("select 9;") }]), d).then(() => null).catch((e: unknown) => e as Error);
    expect(erro).toBeInstanceOf(MigrationDivergente);
    expect(erro!.message).toContain("0008_meu.sql");
    expect(erro!.message).toContain("0009_dela.sql");
    expect(erro!.message).toContain("db:reset");   // a saída em desenvolvimento
  });

  it("arquivo novo DEPOIS da última aplicada passa", async () => {
    const d = await pasta({ "0009_dela.sql": "select 9;", "0010_minha.sql": "select 10;" });
    await expect(verificarIntegridade(banco([{ name: "0009_dela.sql", content_sha256: sha256("select 9;") }]), d)).resolves.toEqual({ semHash: [] });
  });

  it("banco vazio aceita qualquer coisa: não há ordem a furar", async () => {
    const d = await pasta({ "0003_c.sql": "select 3;" });
    await expect(verificarIntegridade(banco([]), d)).resolves.toEqual({ semHash: [] });
  });
});

describe("as migrations DESTE repo", () => {
  it("estão numeradas em ordem, sem repetir número, e cada uma tem um down (a partir da 0003)", async () => {
    const files = await listMigrationFiles();
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect([...files].sort()).toEqual(files);   // listMigrationFiles já ordena, mas é o invariante
    const numeros = files.map((f) => f.slice(0, 4));
    expect(new Set(numeros).size, `número de migration repetido: ${numeros}`).toBe(numeros.length);

    // A 0001 e a 0002 não têm down por desenho (desfazer a 0001 é apagar o banco).
    const downs = await listMigrationFiles(path.resolve("db/migrations/down"));
    for (const f of files.filter((x) => x.slice(0, 4) >= "0003")) {
      expect(downs, `falta o down de ${f}`).toContain(f);
    }
  });

  it("pendingMigrations não repete o que já está aplicado", async () => {
    const files = await listMigrationFiles();
    const todas = files.map((name) => ({ name, content_sha256: null }));
    expect(await pendingMigrations(banco(todas))).toEqual([]);
    expect(await pendingMigrations(banco(todas.slice(0, -1)))).toEqual([files.at(-1)]);
    expect(await pendingMigrations(banco([]))).toEqual(files);
  });
});
