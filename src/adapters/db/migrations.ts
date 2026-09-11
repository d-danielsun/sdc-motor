// O motor não sobe num banco sem migração (lição U3 do QA): recusar no boot com mensagem > 500 nos webhooks.
//
// DUAS GUARDAS QUE ESTE ARQUIVO ADICIONOU (#7). Antes, `schema_migrations` guardava só o nome:
//   1. Editar uma migration já aplicada passava batido, e o banco discordava do disco em silêncio
//      — o pior tipo de divergência, porque só aparece no próximo ambiente novo.
//   2. Um arquivo cujo nome ordene ANTES do último aplicado entrava fora de ordem (dois PRs em
//      paralelo criando 0008 e 0009, o 0009 mergeando primeiro).
// As duas recusam aplicar, com o nome do arquivo na mensagem.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

type Q = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
export const MIGRATIONS_DIR = path.resolve(process.cwd(), "db/migrations");

export async function listMigrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
}

export const sha256 = (conteudo: string): string => createHash("sha256").update(conteudo, "utf8").digest("hex");

interface Aplicada { name: string; content_sha256: string | null }

/** O que já foi aplicado, com o hash quando houver. Tabela ausente = nada aplicado. */
async function aplicadas(db: Q): Promise<Aplicada[]> {
  try {
    return (await db.query("select name, content_sha256 from schema_migrations order by name")).rows as unknown as Aplicada[];
  } catch (e) {
    const cod = (e as { code?: string }).code;
    if (cod === "42P01") return [];                                    // tabela não existe: tudo pendente
    if (cod === "42703") {                                             // coluna não existe: banco antes da 0008
      return (await db.query("select name from schema_migrations order by name")).rows.map((r) => ({ name: String(r.name), content_sha256: null }));
    }
    throw e;
  }
}

export async function pendingMigrations(db: Q, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = await listMigrationFiles(dir);
  const nomes = new Set((await aplicadas(db)).map((a) => a.name));
  return files.filter((f) => !nomes.has(f));
}

export class MigrationDivergente extends Error {}

/** Confere que o disco corresponde ao que o banco diz ter aplicado, e que a ordem não foi furada.
 *  Devolve os arquivos aplicados cujo hash ainda está nulo (banco de antes da 0008), para backfill. */
export async function verificarIntegridade(db: Q, dir = MIGRATIONS_DIR): Promise<{ semHash: Array<{ name: string; hash: string }> }> {
  const jaAplicadas = await aplicadas(db);
  if (jaAplicadas.length === 0) return { semHash: [] };
  const files = await listMigrationFiles(dir);
  const ultimaAplicada = jaAplicadas.map((a) => a.name).sort().at(-1) as string;
  const semHash: Array<{ name: string; hash: string }> = [];

  for (const a of jaAplicadas) {
    if (!files.includes(a.name)) {
      throw new MigrationDivergente(`a migration ${a.name} está aplicada no banco mas não existe em ${dir} — o banco e o código são de versões diferentes`);
    }
    const hash = sha256(await readFile(path.join(dir, a.name), "utf8"));
    if (a.content_sha256 === null) { semHash.push({ name: a.name, hash }); continue; }
    if (a.content_sha256 !== hash) {
      throw new MigrationDivergente(
        `a migration ${a.name} foi EDITADA depois de aplicada:\n` +
        `  no banco: ${a.content_sha256}\n` +
        `  no disco: ${hash}\n` +
        `Migration é forward-only: crie uma nova em vez de mexer numa aplicada. Se a edição foi ` +
        `cosmética e o banco já está certo, atualize o hash à mão em schema_migrations.`,
      );
    }
  }

  // Ordem estrita: arquivo pendente que ordene antes do último aplicado entraria fora de ordem.
  for (const f of files) {
    if (jaAplicadas.some((a) => a.name === f)) continue;
    if (f < ultimaAplicada) {
      throw new MigrationDivergente(
        `a migration ${f} ordena ANTES de ${ultimaAplicada}, que já está aplicada — aplicá-la agora ` +
        `rodaria fora de ordem. Renomeie-a para depois da última aplicada (em desenvolvimento, ` +
        `\`npm run db:reset\` resolve).`,
      );
    }
  }
  return { semHash };
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
    // Duas linhas, duas falhas diferentes que já aconteceram:
    //
    // O `create table` traz `content_sha256` porque num banco NOVO o insert da própria 0001 precisa
    // da coluna — a 0008 só roda depois. Peguei isso migrando um banco descartável do zero.
    //
    // O `alter table` existe porque `create table if not exists` é NO-OP num banco que já tem a
    // tabela: num ambiente anterior à 0008, a coluna nunca era criada, o backfill rodava antes da
    // 0008 e o upgrade quebrava com `column "content_sha256" does not exist`. Ou seja: este PR não
    // deployava em NENHUM ambiente existente. Achado do verificador da #15 e reproduzido num banco
    // montado à mão no estado anterior — nenhum teste pegaria, porque os bancos locais já tinham
    // a 0008 aplicada.
    await db.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now(), content_sha256 text)");
    await db.query("alter table schema_migrations add column if not exists content_sha256 text");

    // Integridade ANTES de aplicar qualquer coisa: se o disco discorda do banco, aplicar mais
    // migrations em cima só piora. Roda depois do create table para não estourar em banco novo.
    const { semHash } = await verificarIntegridade(db, dir);
    for (const { name, hash } of semHash) {
      // Backfill de banco anterior à 0008: assume-se que o disco corresponde ao que foi aplicado
      // (verdade hoje), porque a alternativa seria recusar subir em todo ambiente existente.
      await db.query("update schema_migrations set content_sha256 = $2 where name = $1 and content_sha256 is null", [name, hash]);
    }

    const pending = await pendingMigrations(db, dir);
    for (const f of pending) {
      const sql = await readFile(path.join(dir, f), "utf8");
      await db.query("begin");
      try {
        await db.query(sql);
        await db.query("insert into schema_migrations (name, content_sha256) values ($1, $2)", [f, sha256(sql)]);
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

// ── Tripwire de leitura (#4) ─────────────────────────────────────────────────

/** Chaves que a 0001 semeia. Se as migrations rodaram, elas EXISTEM no banco — então não
 *  enxergá-las não é "banco vazio", é o motor lendo através de uma parede. */
const CANARIOS = ["IDA_ENABLED", "TOLERANCE_BRL", "GO_LIVE_CUTOFF_DATE", "ASAAS_WEBHOOK_ID", "ASAAS_PENALIZED_LAST"];

export class LeituraBloqueada extends Error {}

/**
 * Recusa subir quando o motor não consegue LER o que o banco tem.
 *
 * POR QUE ISTO EXISTE. RLS está ligado em todas as tabelas e não há policy para o role do motor.
 * Funciona hoje porque o role é dono da tabela, e dono ignora RLS. Trocar para um role de
 * aplicação com menos privilégio — o que qualquer revisão de segurança vai pedir — faz
 * `getByMoveLine` e `pending` devolverem VAZIO em vez de erro. E vazio, para este motor, significa
 * "esta parcela ainda não tem boleto": ele emitiria a segunda cobrança da mesma parcela, em
 * silêncio, para cliente real.
 *
 * Falhar no boot é barato. Descobrir isso pela fatura duplicada do cliente, não.
 */
export async function assertLeitura(db: Q, log?: (msg: string) => void): Promise<void> {
  const { rows } = await db.query("select key from app_config where key = any($1::text[])", [CANARIOS]);
  if (rows.length >= CANARIOS.length) return;
  // Ver ALGUMAS chaves prova que a leitura funciona: o que falta é dado, não acesso. Recusar aqui
  // seria falso positivo — e a suíte de teste apaga `app_config` de propósito, o que travaria
  // qualquer `npm run job` depois dela. Aviso alto, mas o motor sobe.
  if (rows.length > 0) {
    const faltando = CANARIOS.filter((k) => !rows.some((r) => r.key === k));
    log?.(`app_config está incompleto: faltam ${faltando.join(", ")}. A leitura funciona (${rows.length} de ${CANARIOS.length} visíveis), então isto é dado apagado, não RLS. O motor sobe com os defaults do código.`);
    return;
  }

  // Diagnóstico: sem isto, a mensagem seria "não consigo ler" e a pessoa ficaria adivinhando.
  let quem = "?", temSelect = "?", ehDono = "?", rlsLigado = "?";
  try {
    const d = (await db.query(`select current_user as quem,
        has_table_privilege(current_user, 'app_config', 'select') as tem_select,
        pg_has_role(current_user, (select relowner from pg_class where relname = 'app_config'), 'member') as eh_dono,
        (select relrowsecurity from pg_class where relname = 'app_config') as rls`)).rows[0] as Record<string, unknown>;
    quem = String(d.quem); temSelect = String(d.tem_select); ehDono = String(d.eh_dono); rlsLigado = String(d.rls);
  } catch { /* diagnóstico é bônus: a recusa vale mesmo sem ele */ }

  const causa = temSelect === "false"
    ? `o role \`${quem}\` NÃO tem privilégio de SELECT em app_config — é permissão, não RLS. Rode: grant select on all tables in schema public to ${quem};`
    : ehDono === "false" && rlsLigado === "true"
      ? `o role \`${quem}\` tem SELECT mas NÃO é dono da tabela, e RLS está ligado sem policy para ele — o Postgres devolve zero linhas, sem erro. Use o role dono, ou dê BYPASSRLS a ele, ou crie policies.`
      : `o role \`${quem}\` não enxergou NENHUMA das ${CANARIOS.length} chaves que a migration 0001 semeia. Banco certo? Rode \`select current_database()\` e confira se aponta para o banco migrado.`;

  throw new LeituraBloqueada(
    `o motor consegue conectar mas NÃO consegue ler o que o banco tem, e subir assim faria ele ` +
    `emitir boleto duplicado em silêncio (leitura vazia parece "ainda não cobrado").\n\n${causa}\n\n` +
    `Isto NÃO é falta de migration: as migrations estão aplicadas (senão a mensagem seria outra).`,
  );
}
