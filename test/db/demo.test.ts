// O demo é o que a pessoa do financeiro vê antes de ver produção. Se um cenário parar de
// produzir a exceção que ele promete, a demonstração mente — então cada cenário tem teste.
// Roda contra o banco de teste, chamando as mesmas funções que o CLI chama.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../../src/adapters/db/pool.js";
import {
  CENARIOS, assertDemoUrl, cicloFeliz, criarCtx, demoDeps, deslocar, divergente, filaParada,
  juros, resetDemoDb, resumir, semCpf, semear, vencidas, type DemoCtx,
} from "../../src/cli/demo.js";
import { DB_URL, dbReachable } from "../helpers.js";

const hoje = new Date().toISOString().slice(0, 10);
let pool: ReturnType<typeof createPool>;

beforeAll(async () => {
  if (!(await dbReachable())) throw new Error(`Postgres inacessível em ${DB_URL} — rode: npm run db:up && npm run db:migrate:test`);
  pool = createPool(DB_URL);
});
afterAll(async () => { await pool?.end(); });

/** Um contexto de demo limpo, apontado para o banco de TESTE (o CLI aponta para o `_demo`). */
async function ctxLimpo(): Promise<DemoCtx> {
  await resetDemoDb(pool, hoje);
  const { deps } = demoDeps(pool, hoje);
  return criarCtx(deps, hoje);
}

describe("guarda do banco (AC3)", () => {
  it("só aceita banco terminado em _demo", () => {
    expect(() => assertDemoUrl("postgres://motor:motor@localhost:55432/motor_demo")).not.toThrow();
    expect(() => assertDemoUrl("postgres://motor:motor@localhost:55432/outro_demo")).not.toThrow();
  });
  it("recusa o banco de desenvolvimento e o de teste, dizendo por quê", () => {
    for (const banco of ["motor", "motor_test", "postgres", ""]) {
      expect(() => assertDemoUrl(`postgres://motor:motor@localhost:55432/${banco}`)).toThrow(/_demo/);
    }
    expect(() => assertDemoUrl("postgres://motor:motor@localhost:55432/motor")).toThrow(/TRUNCA/);
  });
  it("recusa URL que não é URL", () => {
    expect(() => assertDemoUrl("nao-e-url")).toThrow();
  });
});

describe("datas relativas a hoje (AC2)", () => {
  it("desloca em dias corridos sem escorregar de fuso", () => {
    expect(deslocar("2026-03-01", -1)).toBe("2026-02-28");
    expect(deslocar("2026-02-28", 1)).toBe("2026-03-01");
    expect(deslocar("2024-02-28", 1)).toBe("2024-02-29");   // ano bissexto
    expect(deslocar("2026-12-31", 1)).toBe("2027-01-01");
    expect(deslocar("2026-09-10", 0)).toBe("2026-09-10");
    // horário de verão brasileiro já não existe, mas a conta é em UTC de propósito
    expect(deslocar("2026-10-18", -45)).toBe("2026-09-03");
  });
});

describe("cenários (AC5)", () => {
  let ctx: DemoCtx;
  beforeEach(async () => { ctx = await ctxLimpo(); });

  it("ciclo-feliz: 2 boletos, 1 baixado com diferença zero", async () => {
    await cicloFeliz(ctx);
    const r = await resumir(pool, "ciclo-feliz", hoje);
    expect(r.cobrancas).toBe(2);
    expect(r.conciliacoes).toBe(1);
    expect(r.excecoesAbertas).toEqual({});
    const c1 = await ctx.deps.repo.charges.getByMoveLine(1001);
    const c2 = await ctx.deps.repo.charges.getByMoveLine(1002);
    expect(c1?.status).toBe("received");
    expect(c2?.status).toBe("created");
    // diferença zero: recebido igual ao esperado, sem política de diferença
    const rec = (await pool.query("select amount_received, amount_expected, diff_policy from reconciliations")).rows[0];
    expect(rec.amount_received).toBe(rec.amount_expected);
    expect(rec.diff_policy).toBeNull();
    // e a parcela foi baixada no Odoo, uma vez só
    expect(ctx.odoo.payments).toHaveLength(1);
    expect(ctx.odoo.lines.get(1001)?.reconciled).toBe(true);
  });

  it("sem-cpf: exceção de documento e NENHUMA cobrança criada", async () => {
    await semCpf(ctx);
    const r = await resumir(pool, "sem-cpf", hoje);
    expect(r.cobrancas).toBe(0);
    expect(r.excecoesAbertas).toEqual({ customer_missing_document: 1 });
    const cliente = (await pool.query("select sync_status from customers_map where odoo_partner_id=20")).rows[0];
    expect(cliente.sync_status).toBe("blocked_no_document");
  });

  it("divergente: paga menos → amount_divergent e nada de baixa", async () => {
    await divergente(ctx);
    const r = await resumir(pool, "divergente", hoje);
    expect(r.cobrancas).toBe(1);
    expect(r.conciliacoes).toBe(0);
    expect(r.excecoesAbertas).toEqual({ amount_divergent: 1 });
    expect(ctx.odoo.payments).toHaveLength(0);
    const exc = (await pool.query("select detail from exceptions where type='amount_divergent'")).rows[0].detail;
    expect(exc).toMatchObject({ received: "90.00", expected: "100.00" });
  });

  it("juros: paga com juros → writeoff_needed pronto para aceitar, sem baixa automática", async () => {
    await juros(ctx);
    const r = await resumir(pool, "juros", hoje);
    expect(r.conciliacoes).toBe(0);
    expect(r.excecoesAbertas).toEqual({ writeoff_needed: 1 });
    expect(ctx.odoo.payments).toHaveLength(0);
    const exc = (await pool.query("select ref_table, ref_id, detail from exceptions where type='writeoff_needed'")).rows[0];
    expect(exc.ref_table).toBe("charges");
    expect(exc.detail).toMatchObject({ policy: "juros_multa", received: "103.10", expected: "100.00" });
    // o botão "aceitar" do console age sobre esta cobrança (ref_id vem do pg como string)
    expect(await ctx.deps.repo.charges.getByMoveLine(4001)).toMatchObject({ id: Number(exc.ref_id) });
  });

  it("fila-parada: queue_interrupted aberta com a contagem de penalizações", async () => {
    await filaParada(ctx);
    const r = await resumir(pool, "fila-parada", hoje);
    expect(r.cobrancas).toBe(0);
    expect(Object.keys(r.excecoesAbertas).sort()).toEqual(["queue_interrupted", "webhook_penalized"]);
    const exc = (await pool.query("select detail from exceptions where type='queue_interrupted'")).rows[0].detail as { penalizedRequestsCount: number };
    expect(exc.penalizedRequestsCount).toBe(15);
    expect(await ctx.deps.repo.config.get("ASAAS_WEBHOOK_ID")).toBeTruthy();
  });

  it("vencidas: 3 cobranças abertas, uma em cada faixa de atraso", async () => {
    await vencidas(ctx);
    const r = await resumir(pool, "tudo", hoje);
    expect(r.cobrancasAbertas).toBe(3);
    expect(r.aging.map((a) => a.count)).toEqual([0, 1, 1, 1]);
  });
});

describe("cenário 'tudo' (AC1)", () => {
  beforeEach(async () => { await resetDemoDb(pool, hoje); });

  it("deixa ≥6 cobranças, uma exceção de cada tipo e as 4 faixas de aging preenchidas", async () => {
    const { deps } = demoDeps(pool, hoje);
    const t0 = Date.now();
    await semear(criarCtx(deps, hoje), "tudo");
    const decorrido = Date.now() - t0;

    const r = await resumir(pool, "tudo", hoje);
    expect(r.cobrancas).toBeGreaterThanOrEqual(6);
    for (const tipo of ["customer_missing_document", "amount_divergent", "writeoff_needed", "queue_interrupted"]) {
      expect(r.excecoesAbertas[tipo], `faltou exceção ${tipo}`).toBeGreaterThanOrEqual(1);
    }
    expect(Object.keys(r.excecoesAbertas).length).toBeGreaterThanOrEqual(4);
    for (const faixa of r.aging) expect(faixa.count, `faixa ${faixa.bucket} vazia`).toBeGreaterThanOrEqual(1);
    expect(r.conciliacoes).toBe(1);
    // AC1 fala de 10 s no laptop com o compose local; o teto aqui é folgado de propósito
    // para não virar teste instável em máquina ocupada, mas ainda pega uma regressão real.
    expect(decorrido).toBeLessThan(10_000);
  });

  it("é idempotente por reset: rodar duas vezes dá a mesma estrutura (AC2)", async () => {
    const rodar = async () => {
      await resetDemoDb(pool, hoje);
      const { deps } = demoDeps(pool, hoje);
      await semear(criarCtx(deps, hoje), "tudo");
      // A comparação é sobre estrutura e deslocamento em dias, não sobre timestamps: as
      // datas são relativas a hoje por desenho.
      const linhas = (await pool.query(`select c.odoo_move_line_id, c.status, c.amount, c.due_date - $1::date as dias, c.external_ref
                                          from charges c order by c.odoo_move_line_id`, [hoje])).rows;
      const exc = (await pool.query("select type, status, ref_table from exceptions order by type, ref_table")).rows;
      const rec = (await pool.query("select amount_received, amount_expected, diff_policy from reconciliations order by id")).rows;
      return { linhas, exc, rec, resumo: await resumir(pool, "tudo", hoje) };
    };
    const a = await rodar();
    const b = await rodar();
    expect(b).toEqual(a);
    expect(a.linhas.length).toBeGreaterThan(0);
  });

  it("não faz uma única chamada de rede (AC4)", async () => {
    const original = globalThis.fetch;
    let chamadas = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      chamadas++;
      throw new Error(`o demo tentou falar com a rede: ${String(args[0])}`);
    }) as typeof fetch;
    try {
      const { deps } = demoDeps(pool, hoje);
      await semear(criarCtx(deps, hoje), "tudo");
    } finally {
      globalThis.fetch = original;
    }
    expect(chamadas).toBe(0);
  });

  it("todo cenário do catálogo tem passo e descrição", async () => {
    for (const c of CENARIOS) {
      await resetDemoDb(pool, hoje);
      const { deps } = demoDeps(pool, hoje);
      await expect(semear(criarCtx(deps, hoje), c), `cenário ${c} estourou`).resolves.toBeUndefined();
    }
  });
});
