// Popula um banco de DEMONSTRAÇÃO com cenários nomeados. Uso: npm run demo -- <cenário>
//
// POR QUE ISTO EXISTE. Sem seed, o console nasce vazio e a pessoa do financeiro veria uma
// exceção pela primeira vez em produção, no dia em que ela importa. Aqui ela vê antes: as
// quatro que o motor abre de verdade, cada uma com o dado que a explica.
//
// COMO SEMEIA. Pelas portas reais: os fakes do Odoo e do Asaas rodam em processo e o
// repositório é o Postgres de verdade, então o estado que fica no banco é o mesmo que o
// motor produziria. Nenhum INSERT à mão, nenhuma chamada de rede. Se o comportamento do
// motor mudar, o demo muda com ele — ou o teste em test/db/demo.test.ts quebra.
//
// AS DATAS SÃO RELATIVAS A HOJE de propósito: o aging só faz sentido assim, e um seed com
// datas fixas envelhece e passa a mostrar tudo em "31_mais" depois de dois meses.
import { pathToFileURL } from "node:url";
import pg from "pg";
import { fixedClock, todayBrt } from "../adapters/clock.js";
import { createLockPool, createPool } from "../adapters/db/pool.js";
import { applyMigrations } from "../adapters/db/migrations.js";
import { createPgRepo } from "../adapters/db/repo.js";
import { FakeAsaas } from "../adapters/fakes/fakeAsaas.js";
import { FakeOdoo } from "../adapters/fakes/fakeOdoo.js";
import { CONFIG_KEYS } from "../core/console.js";
import type { Deps } from "../core/ports.js";
import { handleInvoice } from "../core/usecases/handleInvoice.js";
import { processAsaasEvents } from "../core/usecases/processAsaasEvents.js";
import { watchdog } from "../core/usecases/watchdog.js";

export const CENARIOS = ["ciclo-feliz", "sem-cpf", "divergente", "juros", "fila-parada", "tudo"] as const;
export type Cenario = (typeof CENARIOS)[number];
export const DESCRICAO: Record<Cenario, string> = {
  "ciclo-feliz": "1 fatura, 2 parcelas, boletos criados, 1 paga e baixada (conciliação com diferença zero)",
  "sem-cpf": "fatura de cliente sem CPF/CNPJ → exceção customer_missing_document, nenhuma cobrança criada",
  divergente: "pagamento de R$ 90 para cobrança de R$ 100 → amount_divergent, sem baixa",
  juros: "pagamento de R$ 103,10 com originalValue R$ 100 → writeoff_needed, pronto para aceitar",
  "fila-parada": "webhook do Asaas interrompido → queue_interrupted aberta e penalizações registradas",
  tudo: "todos os anteriores, mais 3 cobranças vencidas para o aging mostrar as 4 faixas",
};

/** Documentos fictícios com dígito verificador válido — o Asaas recusa documento inválido. */
export const DOCS = {
  padaria: "11222333000181",
  transportes: "22333444000181",
  serralheria: "33444555000181",
  mercado: "44555666000181",
  autonomo: "11144477735",
} as const;

export interface DemoCtx {
  deps: Deps;
  odoo: FakeOdoo;
  asaas: FakeAsaas;
  /** YYYY-MM-DD de hoje (BRT), congelado no início da execução. */
  hoje: string;
  /** data deslocada em dias corridos a partir de hoje: dia(-45) é 45 dias atrás. */
  dia(n: number): string;
}

export interface Resumo {
  cenario: Cenario;
  cobrancas: number;
  cobrancasAbertas: number;
  conciliacoes: number;
  excecoesAbertas: Record<string, number>;
  aging: Array<{ bucket: string; count: number; amount: string }>;
}

// ── guardas ──────────────────────────────────────────────────────────────────

/** O nome do banco tem que terminar em `_demo`. O demo TRUNCA tudo: apontar para `motor`
 *  (dev) ou `motor_test` apagaria trabalho ou a suíte. Falha fechado, com a URL redigida. */
export function assertDemoUrl(url: string): void {
  let nome: string;
  try {
    nome = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("DATABASE_URL não é uma URL válida");
  }
  if (!nome.endsWith("_demo")) {
    throw new Error(
      `o demo só roda em banco terminado em "_demo", e a DATABASE_URL aponta para "${nome || "(sem banco)"}".\n` +
        `Ele TRUNCA todas as tabelas — em "motor" apagaria o desenvolvimento, em "motor_test" a suíte.\n` +
        `Use: DATABASE_URL=postgres://motor:motor@localhost:55432/motor_demo npm run demo -- tudo`,
    );
  }
}

/** Zera o banco e recoloca o app_config no default do registro, com a ida ligada e a data de
 *  corte no passado (sem ela o motor não emite nada — é fail closed de propósito). */
export async function resetDemoDb(pool: ReturnType<typeof createPool>, hoje: string): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'",
  );
  // Descoberto do catálogo em vez de lista fixa: migration nova entra no reset sozinha.
  if (rows.length > 0) {
    const alvo = rows.map((r) => `"${r.tablename}"`).join(", ");
    await pool.query(`truncate ${alvo} restart identity cascade`);
  }
  const corte = deslocar(hoje, -365);
  const overrides: Record<string, unknown> = { IDA_ENABLED: true, GO_LIVE_CUTOFF_DATE: corte };
  for (const [k, v] of Object.entries(CONFIG_KEYS)) {
    await pool.query("insert into app_config (key, value) values ($1, $2::jsonb)", [k, JSON.stringify(k in overrides ? overrides[k] : v)]);
  }
}

/** Soma dias corridos a uma data YYYY-MM-DD, em UTC (sem horário, sem fuso no meio). */
export function deslocar(dia: string, dias: number): string {
  const d = new Date(`${dia}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

// ── os cenários ──────────────────────────────────────────────────────────────

/** Emite os boletos de uma fatura pelo caminho real da ida (mesma função que a varredura usa). */
async function emitir(ctx: DemoCtx, invoiceId: number): Promise<void> {
  const inv = await ctx.odoo.getInvoice(invoiceId);
  if (!inv) throw new Error(`demo: fatura ${invoiceId} não existe no fake`);
  await handleInvoice(ctx.deps, inv);
}

/** Entrega um PAYMENT_RECEIVED ao motor pelo caminho real da volta (fila + worker). */
async function liquidar(ctx: DemoCtx, asaasPaymentId: string, o: { value?: string; interest?: string; paymentDate?: string } = {}): Promise<void> {
  const evento = ctx.asaas.confirm(asaasPaymentId, { ...o, paymentDate: o.paymentDate ?? ctx.hoje });
  await ctx.deps.repo.asaasEvents.insert({ asaasEventId: evento.id, eventType: evento.event, asaasPaymentId, payload: evento });
  await processAsaasEvents(ctx.deps);
}

async function pagamentoDa(ctx: DemoCtx, moveLineId: number): Promise<string> {
  const c = await ctx.deps.repo.charges.getByMoveLine(moveLineId);
  if (!c?.asaasPaymentId) throw new Error(`demo: a parcela ${moveLineId} não gerou cobrança com boleto`);
  return c.asaasPaymentId;
}

export async function cicloFeliz(ctx: DemoCtx): Promise<void> {
  ctx.odoo.addPartner({ id: 10, name: "Padaria do Bairro Ltda", vat: DOCS.padaria, email: "financeiro@padariadobairro.com.br" });
  ctx.odoo.addInvoice({
    id: 100, name: "INV/2026/0001", partnerId: 10, invoiceDate: ctx.dia(-10),
    lines: [
      { id: 1001, dateMaturity: ctx.dia(5), amount: "1250.00" },
      { id: 1002, dateMaturity: ctx.dia(35), amount: "1250.00" },
    ],
  });
  await emitir(ctx, 100);
  // A 1ª parcela é paga em dia, pelo valor exato: conciliação com diferença zero.
  await liquidar(ctx, await pagamentoDa(ctx, 1001));
}

export async function semCpf(ctx: DemoCtx): Promise<void> {
  // vat null é o caso real mais comum: cadastro do Odoo incompleto. Nenhum boleto sai.
  ctx.odoo.addPartner({ id: 20, name: "Transportes Aurora ME", vat: null, email: "contato@transportesaurora.com.br" });
  ctx.odoo.addInvoice({ id: 200, name: "INV/2026/0002", partnerId: 20, invoiceDate: ctx.dia(-8), lines: [{ id: 2001, dateMaturity: ctx.dia(7), amount: "890.00" }] });
  await emitir(ctx, 200);
}

export async function divergente(ctx: DemoCtx): Promise<void> {
  ctx.odoo.addPartner({ id: 30, name: "Serralheria Ipê Ltda", vat: DOCS.serralheria, email: "ipe@serralheriaipe.com.br" });
  ctx.odoo.addInvoice({ id: 300, name: "INV/2026/0003", partnerId: 30, invoiceDate: ctx.dia(-6), lines: [{ id: 3001, dateMaturity: ctx.dia(3), amount: "100.00" }] });
  await emitir(ctx, 300);
  // Pagou R$ 90 numa cobrança de R$ 100: falta dinheiro, e o motor NÃO baixa por conta própria.
  await liquidar(ctx, await pagamentoDa(ctx, 3001), { value: "90.00" });
}

export async function juros(ctx: DemoCtx): Promise<void> {
  ctx.odoo.addPartner({ id: 40, name: "Mercado São Jorge Ltda", vat: DOCS.mercado, email: "contas@mercadosaojorge.com.br" });
  ctx.odoo.addInvoice({ id: 400, name: "INV/2026/0004", partnerId: 40, invoiceDate: ctx.dia(-20), lines: [{ id: 4001, dateMaturity: ctx.dia(-4), amount: "100.00" }] });
  await emitir(ctx, 400);
  // Pagou depois do vencimento: R$ 103,10, sendo R$ 3,10 de juros e multa do próprio Asaas.
  // Com JUROS_MULTA_AUTO desligado (o default), isso espera decisão humana: writeoff_needed.
  await liquidar(ctx, await pagamentoDa(ctx, 4001), { interest: "3.10" });
}

export async function filaParada(ctx: DemoCtx): Promise<void> {
  const wh = await ctx.asaas.createWebhook({
    name: "Salvei motor de cobrança",
    url: "https://motor.exemplo.com.br/webhook-asaas",
    email: "alertas@exemplo.com.br",
    authToken: "demo".repeat(8),
    events: ["PAYMENT_RECEIVED"],
  });
  await ctx.deps.repo.config.set("ASAAS_WEBHOOK_ID", wh.id);
  // 15 falhas seguidas e o Asaas interrompe a fila: a partir daí nenhum pagamento chega.
  // É a falha mais perigosa do sistema, porque é silenciosa — o watchdog é quem a grita.
  ctx.asaas.interrupt(wh.id, 15);
  await watchdog(ctx.deps);
}

/** 3 cobranças vencidas, uma em cada faixa de atraso, para o aging mostrar as 4 colunas. */
export async function vencidas(ctx: DemoCtx): Promise<void> {
  ctx.odoo.addPartner({ id: 50, name: "Oficina Duas Rodas Ltda", vat: DOCS.transportes, email: "oficina@duasrodas.com.br" });
  ctx.odoo.addInvoice({
    id: 500, name: "INV/2026/0005", partnerId: 50, invoiceDate: ctx.dia(-60),
    lines: [
      { id: 5001, dateMaturity: ctx.dia(-3), amount: "430.00" },   // faixa 1_7
      { id: 5002, dateMaturity: ctx.dia(-15), amount: "780.00" },  // faixa 8_30
      { id: 5003, dateMaturity: ctx.dia(-45), amount: "1520.00" }, // faixa 31_mais
    ],
  });
  await emitir(ctx, 500);
}

const PASSOS: Record<Cenario, Array<(ctx: DemoCtx) => Promise<void>>> = {
  "ciclo-feliz": [cicloFeliz],
  "sem-cpf": [semCpf],
  divergente: [divergente],
  juros: [juros],
  "fila-parada": [filaParada],
  tudo: [cicloFeliz, semCpf, divergente, juros, filaParada, vencidas],
};

/** Cria o banco de demonstração se ele não existir e aplica as migrations.
 *  O `db/init/` do compose só roda na PRIMEIRA inicialização do volume, então quem já tinha
 *  o Postgres de pé antes desta filha não teria o `motor_demo` — e a saída seria um
 *  `db:reset`, que apaga o banco de desenvolvimento. Aqui o demo se resolve sozinho. */
export async function garantirBanco(url: string): Promise<{ criado: boolean; migrations: string[] }> {
  const alvo = new URL(url);
  const nome = decodeURIComponent(alvo.pathname.replace(/^\//, ""));
  let criado = false;
  const sonda = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  try {
    await sonda.connect();
    await sonda.end();
  } catch (e) {
    // 3D000 = invalid_catalog_name: o servidor respondeu, só não existe esse banco.
    if ((e as { code?: string }).code !== "3D000") throw e;
    const manutencao = new URL(url);
    manutencao.pathname = "/postgres";
    const admin = new pg.Client({ connectionString: manutencao.href, connectionTimeoutMillis: 5_000 });
    await admin.connect();
    try {
      // Identificador não aceita parâmetro; o nome já foi validado por assertDemoUrl e só
      // pode conter o que o próprio Postgres aceita entre aspas duplas.
      await admin.query(`create database "${nome.replace(/"/g, '""')}"`);
      criado = true;
    } finally {
      await admin.end();
    }
  }
  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  try {
    return { criado, migrations: await applyMigrations(cliente) };
  } finally {
    await cliente.end();
  }
}

// ── execução ─────────────────────────────────────────────────────────────────

export function criarCtx(deps: Deps, hoje: string): DemoCtx {
  return { deps, odoo: deps.odoo as FakeOdoo, asaas: deps.asaas as FakeAsaas, hoje, dia: (n) => deslocar(hoje, n) };
}

/** Monta as dependências do demo: repositório real, Odoo e Asaas falsos, relógio congelado. */
export function demoDeps(pool: ReturnType<typeof createPool>, hoje: string, lockPool?: ReturnType<typeof createPool>): { deps: Deps; odoo: FakeOdoo; asaas: FakeAsaas } {
  const odoo = new FakeOdoo();
  const asaas = new FakeAsaas();
  const repo = createPgRepo(pool, lockPool);
  // Relógio congelado ao meio-dia: o cenário não muda de resultado se rodar 23h59.
  const deps: Deps = { repo, odoo, asaas, clock: fixedClock(`${hoje}T15:00:00.000Z`), log: () => {} };
  return { deps, odoo, asaas };
}

export async function semear(ctx: DemoCtx, cenario: Cenario): Promise<void> {
  for (const passo of PASSOS[cenario]) await passo(ctx);
}

export async function resumir(pool: ReturnType<typeof createPool>, cenario: Cenario, hoje: string): Promise<Resumo> {
  const um = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0]?.n ?? 0);
  const cobrancas = await um("select count(*)::int as n from charges");
  const cobrancasAbertas = await um("select count(*)::int as n from charges where status in ('created','confirmed')");
  const conciliacoes = await um("select count(*)::int as n from reconciliations");
  const exc = (await pool.query<{ type: string; n: number }>("select type, count(*)::int as n from exceptions where status='open' group by type order by type")).rows;
  const aging = (
    await pool.query<{ bucket: string; count: number; amount: string }>(
      `select case when due_date >= $1::date then 'a_vencer' when $1::date - due_date <= 7 then '1_7' when $1::date - due_date <= 30 then '8_30' else '31_mais' end as bucket,
              count(*)::int as count, coalesce(sum(amount),0)::text as amount
         from charges where status in ('created','confirmed') group by 1`,
      [hoje],
    )
  ).rows;
  const ordem = ["a_vencer", "1_7", "8_30", "31_mais"];
  return {
    cenario,
    cobrancas,
    cobrancasAbertas,
    conciliacoes,
    excecoesAbertas: Object.fromEntries(exc.map((r) => [r.type, r.n])),
    aging: ordem.map((b) => aging.find((r) => r.bucket === b) ?? { bucket: b, count: 0, amount: "0.00" }),
  };
}

/** Credenciais para abrir o console. Enquanto a filha do console (#13) não existir, o acesso
 *  é o CONSOLE_TOKEN do ambiente — não há tabela de usuário para criar um usuário de demo. */
export async function credenciais(pool: ReturnType<typeof createPool>, env: NodeJS.ProcessEnv): Promise<{ modo: "console_users" | "token"; linhas: string[] }> {
  const existe = (await pool.query("select to_regclass('public.console_users') as t")).rows[0]?.t !== null;
  const porta = env.PORT ?? "8787";
  const url = `http://localhost:${porta}/`;
  if (existe) {
    return {
      modo: "console_users",
      linhas: [
        `console:  ${url}`,
        "usuário:  a tabela console_users existe neste banco, mas criar o usuário de demonstração",
        "          é da filha que a introduziu (#13). Crie por lá e volte a rodar o demo.",
      ],
    };
  }
  const token = env.CONSOLE_TOKEN ?? "";
  return {
    modo: "token",
    linhas: [
      `console:  ${url}`,
      token
        ? `acesso:   Authorization: Bearer ${"*".repeat(8)}… (o CONSOLE_TOKEN que já está no seu ambiente)`
        : "acesso:   defina CONSOLE_TOKEN (≥32 caracteres) antes de subir o motor — sem ele a API responde 503",
      "usuário:  login próprio chega com a filha #13; até lá o console é autenticado pelo token",
    ],
  };
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const nome = argv[0];
  if (!nome || !(CENARIOS as readonly string[]).includes(nome)) {
    console.error(`uso: npm run demo -- <cenário>\n`);
    for (const c of CENARIOS) console.error(`  ${c.padEnd(12)} ${DESCRICAO[c]}`);
    return 2;
  }
  const cenario = nome as Cenario;
  const url = env.DATABASE_URL ?? "";
  try {
    assertDemoUrl(url);
  } catch (e) {
    console.error(String((e as Error).message));
    return 2;
  }

  let preparo: { criado: boolean; migrations: string[] };
  try {
    preparo = await garantirBanco(url);
  } catch (e) {
    console.error(`não consegui preparar o banco de demonstração: ${String((e as Error).message)}`);
    console.error("o Postgres está de pé? `npm run db:up`");
    return 1;
  }

  const pool = createPool(url);
  const lockPool = createLockPool(url);
  const t0 = Date.now();
  try {
    // Dia civil de São Paulo, como todo o resto do motor (due_date e payment_date são
    // datas civis BRT). Em UTC, das 21h à meia-noite o demo semearia o dia seguinte.
    const hoje = todayBrt(new Date());
    await resetDemoDb(pool, hoje);
    const { deps } = demoDeps(pool, hoje, lockPool);
    await semear(criarCtx(deps, hoje), cenario);
    const r = await resumir(pool, cenario, hoje);
    const cred = await credenciais(pool, env);

    if (preparo.criado) console.log(`\nbanco de demonstração criado agora.`);
    if (preparo.migrations.length > 0) console.log(`migrations aplicadas: ${preparo.migrations.length}`);
    console.log(`\ncenário:  ${cenario} — ${DESCRICAO[cenario]}`);
    console.log(`banco:    ${new URL(url).pathname.replace(/^\//, "")}  ·  semeado em ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    console.log(`cobranças: ${r.cobrancas} (${r.cobrancasAbertas} abertas)   conciliações: ${r.conciliacoes}`);
    const exc = Object.entries(r.excecoesAbertas);
    console.log(`exceções abertas: ${exc.length === 0 ? "nenhuma" : exc.map(([t, n]) => `${t}×${n}`).join("  ")}`);
    console.log(`aging: ${r.aging.map((a) => `${a.bucket}=${a.count} (R$ ${a.amount})`).join("  ")}\n`);
    for (const l of cred.linhas) console.log(l);
    console.log(`\npara subir o motor neste banco:\n  DATABASE_URL=${url} npm start\n`);
    return 0;
  } catch (e) {
    console.error(`demo falhou: ${String((e as Error).message)}`);
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
    await lockPool.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
