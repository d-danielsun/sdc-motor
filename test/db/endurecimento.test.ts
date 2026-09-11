// Endurecimento técnico (#15): fecha #4, #5, #6, #7 e #8. Cada teste aqui corresponde a uma forma
// de o motor errar em SILÊNCIO — que é a única classe de erro que assusta neste projeto.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { reconcileDaily } from "../../src/core/index.js";
import { requeueAllByType, enableCustomerNotifications, healthReport } from "../../src/core/usecases/console.js";
import { createConsoleQueries } from "../../src/adapters/db/console.js";
import { CNPJ_OK, dbReachable, seedInvoice, world, type World } from "../helpers.js";

let w: World | undefined;
beforeAll(async () => {
  if (!(await dbReachable())) throw new Error("Postgres inacessível — npm run db:up && npm run db:migrate:test");
});
afterEach(async () => { const atual = w; w = undefined; await atual?.close(); });

// ── #6: token de posse na reserva ────────────────────────────────────────────
describe("token de posse na reserva de evento (#6)", () => {
  it("a reserva devolve um token, e o mark com token velho NÃO sobrescreve (AC2)", async () => {
    w = await world();
    const id = (await w.deps.repo.asaasEvents.insert({ asaasEventId: "e1", eventType: "PAYMENT_RECEIVED", asaasPaymentId: "pay_1", payload: {} }))!;

    const [primeira] = await w.deps.repo.asaasEvents.pending(10, w.deps.clock.now());
    expect(primeira?.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    const tokenVelho = primeira!.claimToken;

    // O TTL expira e outro worker assume: token novo, mesmo evento. O relógio do mundo de teste é
    // FIXO, então envelhecer contra o `now()` do Postgres não teria efeito — quem decide é o clock.
    await w.pool.query("update webhook_events set locked_at = $2 where id=$1", [id, new Date(w.deps.clock.now().getTime() - 20 * 60_000)]);
    const [segunda] = await w.deps.repo.asaasEvents.pending(10, w.deps.clock.now());
    expect(segunda?.claimToken).not.toBe(tokenVelho);

    // O novo dono termina o trabalho.
    expect(await w.deps.repo.asaasEvents.mark(id, "done", { claimToken: segunda!.claimToken })).toBe(true);

    // Agora o worker velho acorda — pausa de GC, container congelado — e tenta gravar o resultado
    // dele. Antes do token, isto sobrescrevia o trabalho do novo dono.
    expect(await w.deps.repo.asaasEvents.mark(id, "error", { error: "eu achei que ainda era meu", claimToken: tokenVelho })).toBe(false);
    const estado = (await w.pool.query("select process_status, error from webhook_events where id=$1", [id])).rows[0];
    expect(estado).toMatchObject({ process_status: "done", error: null });
  });

  it("touch com token velho também não renova a reserva de outro", async () => {
    w = await world();
    const id = (await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: 500, odooAction: null, payload: {} }))!;
    const [a] = await w.deps.repo.odooEvents.pending(10, w.deps.clock.now());
    await w.pool.query("update odoo_events set locked_at = $2 where id=$1", [id, new Date(w.deps.clock.now().getTime() - 20 * 60_000)]);
    const [b] = await w.deps.repo.odooEvents.pending(10, w.deps.clock.now());

    expect(await w.deps.repo.odooEvents.touch(id, new Date(), a!.claimToken)).toBe(false);
    expect(await w.deps.repo.odooEvents.touch(id, new Date(), b!.claimToken)).toBe(true);
  });

  it("duas notificações do Odoo para a mesma fatura viram UMA linha pendente (AC3)", async () => {
    w = await world();
    const primeiro = await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: 777, odooAction: "write", payload: { _id: 777 } });
    const segundo = await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: 777, odooAction: "write", payload: { _id: 777 } });
    expect(primeiro).toBeGreaterThan(0);
    expect(segundo).toBeNull();   // colapsada: o Odoo dispara por gravação, não por transição
    expect(Number((await w.pool.query("select count(*)::int as n from odoo_events where odoo_id=777")).rows[0].n)).toBe(1);

    // Depois de processada, uma notificação nova da mesma fatura É aceita: o índice é parcial.
    await w.deps.repo.odooEvents.mark(primeiro!, "done");
    expect(await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: 777, odooAction: "write", payload: {} })).toBeGreaterThan(0);
  });

  it("o webhook do Odoo responde 200 mesmo quando a notificação é colapsada", async () => {
    w = await world();
    const corpo = JSON.stringify({ _model: "account.move", _id: 888 });
    const chamar = () => w!.app().request("/webhook-odoo?k=" + "k".repeat(32), { method: "POST", body: corpo, headers: { "content-type": "application/json" } });
    expect((await chamar()).status).toBe(200);
    expect((await chamar()).status).toBe(200);   // o Odoo desiste em 1s: 200 sempre
    expect(Number((await w.pool.query("select count(*)::int as n from odoo_events where odoo_id=888")).rows[0].n)).toBe(1);
  });
});

// ── #5: reenfileirar em lote e janela por data de crédito ────────────────────
describe("reenfileirar em lote (#5)", () => {
  it("volta para pending só os eventos em error, e NÃO resolve a exceção (AC6)", async () => {
    w = await world();
    const ids: number[] = [];
    for (const n of [1, 2, 3]) {
      const id = (await w.deps.repo.asaasEvents.insert({ asaasEventId: `e${n}`, eventType: "PAYMENT_RECEIVED", asaasPaymentId: `pay_${n}`, payload: {} }))!;
      ids.push(id);
      await w.deps.repo.exceptions.open({ type: "payment_unmatched", refTable: "webhook_events", refId: id, detail: {} });
    }
    await w.deps.repo.asaasEvents.mark(ids[0]!, "error", { error: "odoo fora" });
    await w.deps.repo.asaasEvents.mark(ids[1]!, "error", { error: "odoo fora" });
    // o terceiro NÃO está em erro: continua pendente e não deve ser tocado
    const antes = (await w.pool.query("select attempts, next_attempt_at from webhook_events where id=$1", [ids[2]])).rows[0];

    const r = await requeueAllByType(w.deps, "payment_unmatched");
    expect(r).toMatchObject({ ok: true, action: "requeued", detail: { requeued: 2, skipped: 1 } });

    const estados = (await w.pool.query("select id, process_status, attempts, error, claim_token from webhook_events order by id")).rows;
    expect(estados.map((e) => e.process_status)).toEqual(["pending", "pending", "pending"]);
    expect(estados.slice(0, 2).every((e) => e.attempts === 0 && e.error === null && e.claim_token === null)).toBe(true);
    expect((await w.pool.query("select attempts, next_attempt_at from webhook_events where id=$1", [ids[2]])).rows[0]).toEqual(antes);

    // A exceção continua ABERTA: quem resolve é o worker ao processar, ou uma pessoa.
    expect(Number((await w.pool.query("select count(*)::int as n from exceptions where status='open'")).rows[0].n)).toBe(3);
  });

  it("tipo inválido devolve 400 no envelope padrão, sem tocar em nada", async () => {
    w = await world();
    expect(await requeueAllByType(w.deps, "nao_existe")).toMatchObject({ ok: false, code: "invalid_input" });
    const semTipo = await w.api("/exceptions/requeue-all", { method: "POST" });
    expect(semTipo.status).toBe(400);
    expect(semTipo.body).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("pela API: reenfileira e responde o que fez", async () => {
    w = await world();
    const id = (await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: 42, odooAction: null, payload: {} }))!;
    await w.deps.repo.odooEvents.mark(id, "error", { error: "asaas fora" });
    await w.deps.repo.exceptions.open({ type: "charge_create_failed", refTable: "odoo_events", refId: id, detail: {} });
    const r = await w.api("/exceptions/requeue-all?type=charge_create_failed", { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, action: "requeued", detail: { requeued: 1, skipped: 0 } });
  });

  it("pagamento fora da janela de pagamento mas dentro da de CRÉDITO é conciliado (AC7)", async () => {
    // O caso real: boleto pago numa quinta, creditado na terça. Quando vira RECEIVED, o
    // paymentDate já saiu da janela — e é justo aí que a rede de segurança precisa pegá-lo.
    w = await world({ today: "2026-09-20" });
    seedInvoice(w);
    const { syncInvoices } = await import("../../src/core/index.js");
    await syncInvoices(w.deps);
    const pay = [...w.asaas.payments.values()][0]!;

    // pago há 10 dias (fora do lookback de 3), creditado ontem (dentro)
    w.asaas.confirm(pay.id, { paymentDate: "2026-09-10" });
    w.asaas.setStatus(pay.id, "RECEIVED", { creditDate: "2026-09-19" });

    const s = await reconcileDaily(w.deps, { lookbackDays: 3 });
    expect(s.byCreditDate).toBe(1);
    expect(s.received).toBe(1);
    expect(Number((await w.pool.query("select count(*)::int as n from reconciliations")).rows[0].n)).toBe(1);
  });

  it("o mesmo pagamento nos dois passes é contado uma vez só", async () => {
    w = await world({ today: "2026-09-20" });
    seedInvoice(w);
    const { syncInvoices } = await import("../../src/core/index.js");
    await syncInvoices(w.deps);
    const pay = [...w.asaas.payments.values()][0]!;
    w.asaas.confirm(pay.id, { paymentDate: "2026-09-19" });   // dentro das DUAS janelas
    w.asaas.setStatus(pay.id, "RECEIVED", { creditDate: "2026-09-19" });

    const s = await reconcileDaily(w.deps, { lookbackDays: 3 });
    expect(s.received).toBe(1);
    expect(s.byCreditDate).toBe(0);   // ganhou pelo primeiro passe, não é recontado
    expect(Number((await w.pool.query("select count(*)::int as n from reconciliations")).rows[0].n)).toBe(1);
  });
});

// ── #8: DTOs tipados, keyset e notificações como job ────────────────────────
describe("console tipado e paginação (#8)", () => {
  it("health-report devolve os três resumos com campos concretos (AC9)", async () => {
    w = await world();
    const { runJob } = await import("../../src/app/scheduler.js");
    await runJob(w.deps, "sync-invoices");
    await runJob(w.deps, "reconcile-daily");
    await runJob(w.deps, "watchdog");

    const h = await healthReport(w.deps, createConsoleQueries(w.pool));
    // Os campos existem de fato, não só no tipo: se o resumo gravado mudar de forma, isto quebra.
    expect(h.lastSync).toMatchObject({ ok: true, pages: expect.any(Number), invoices: expect.any(Number), created: expect.any(Number) });
    expect(h.lastReconcile).toMatchObject({ ok: true, scanned: expect.any(Number), byCreditDate: expect.any(Number), overdueChecked: expect.any(Number) });
    expect(h.lastWatchdog).toMatchObject({ ok: true, interrupted: false, staleHeartbeat: expect.any(Boolean) });
    expect(h.notificationsProgress).toBeNull();
  });

  it("keyset devolve a página seguinte sem repetir linha, e o offset antigo continua valendo (AC8)", async () => {
    w = await world();
    // 7 parcelas com vencimentos distintos: o suficiente para paginar de 3 em 3.
    seedInvoice(w, { lines: Array.from({ length: 7 }, (_, i) => ({ id: 2000 + i, dateMaturity: `2026-10-0${i + 1}`, amount: "10.00" })) });
    const { syncInvoices } = await import("../../src/core/index.js");
    await syncInvoices(w.deps);

    const p1 = (await w.api("/charges?limit=3")).body;
    expect(p1.data).toHaveLength(3);
    expect(p1.total).toBe(7);

    const ultimo = p1.data[2];
    const p2 = (await w.api(`/charges?limit=3&after_due_date=${ultimo.dueDate}&after_id=${ultimo.id}`)).body;
    expect(p2.data).toHaveLength(3);
    expect(p2.total).toBe(7);   // o total é do conjunto, não do que falta
    const ids1 = p1.data.map((c: { id: number }) => c.id);
    expect(p2.data.some((c: { id: number }) => ids1.includes(c.id)), "keyset repetiu linha").toBe(false);

    // o offset antigo continua funcionando e concorda com o keyset
    const offset = (await w.api("/charges?limit=3&offset=3")).body;
    expect(offset.data.map((c: { id: number }) => c.id)).toEqual(p2.data.map((c: { id: number }) => c.id));

    // a última página vem incompleta e a seguinte, vazia
    const u = p2.data[2];
    const p3 = (await w.api(`/charges?limit=3&after_due_date=${u.dueDate}&after_id=${u.id}`)).body;
    expect(p3.data).toHaveLength(1);
    const fim = p3.data[0];
    expect((await w.api(`/charges?limit=3&after_due_date=${fim.dueDate}&after_id=${fim.id}`)).body.data).toHaveLength(0);
  });

  it("meio cursor é erro explícito, e cursor com data inválida é 400", async () => {
    w = await world();
    expect((await w.api("/charges?after_due_date=2026-10-01")).status).toBe(400);
    expect((await w.api("/charges?after_id=5")).status).toBe(400);
    const r = await w.api("/charges?after_due_date=2026-99-99&after_id=5");
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: "invalid_input" });
  });

  it("enable-notifications responde 202 na hora e grava progresso retomável", async () => {
    w = await world();
    w.odoo.addPartner({ id: 10, name: "Cliente Um", vat: CNPJ_OK });
    const { ensureCustomer } = await import("../../src/core/customers.js");
    await ensureCustomer(w.deps, 10);

    const r = await w.api("/customers/enable-notifications", { method: "POST" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: true, action: "notifications_enabling", detail: { total: 1 } });

    // o trabalho roda em segundo plano; aqui exercitamos o caso de uso direto para afirmar o fim
    const p = await enableCustomerNotifications(w.deps);
    expect(p).toMatchObject({ total: 1, updated: 1, failed: 0, ok: true });
    expect(await w.deps.repo.config.get("NOTIFICATIONS_PROGRESS")).toMatchObject({ total: 1, updated: 1, ok: true });
    expect((await w.api("/health-report")).body.notificationsProgress).toMatchObject({ ok: true, updated: 1 });
  });

  it("retomar não rechama o Asaas para quem já está ligado", async () => {
    w = await world();
    w.odoo.addPartner({ id: 10, name: "Cliente Um", vat: CNPJ_OK });
    const { ensureCustomer } = await import("../../src/core/customers.js");
    await ensureCustomer(w.deps, 10);
    await enableCustomerNotifications(w.deps);

    let chamadas = 0;
    const original = w.asaas.updateCustomer.bind(w.asaas);
    w.asaas.updateCustomer = async (id, patch) => { chamadas++; return original(id, patch); };
    const p = await enableCustomerNotifications(w.deps);
    delete (w.asaas as { updateCustomer?: unknown }).updateCustomer;

    expect(p).toMatchObject({ total: 1, updated: 1, failed: 0 });
    expect(chamadas, "rechamou o Asaas para quem já estava ligado").toBe(0);
  });
});

// ── o que o verificador da #15 achou, virado em teste ───────────────────────
describe("achados do verificador (#15)", () => {
  it("P1: erro transitório com outra notificação pendente NÃO mata o worker", async () => {
    // A bomba: A reservada (sai do predicado do índice parcial) → o Odoo re-notifica a mesma
    // fatura → B entra como pendente → A falha transitoriamente → devolver A para `pending` colide
    // com B. O 23505 subia CRU de dentro do catch, matava o tick, e como o job `worker` roda o
    // Odoo ANTES do Asaas, a volta do dinheiro parava junto. A cada minuto, para sempre.
    w = await world();
    const { processOdooEvents } = await import("../../src/core/index.js");
    w.odoo.addInvoice({ id: 900, name: "INV/900", partnerId: 10, lines: [{ id: 9001, dateMaturity: "2026-10-01", amount: "10.00" }] });
    w.odoo.addPartner({ id: 10, name: "Cliente", vat: CNPJ_OK });
    const a = (await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: 900, odooAction: null, payload: {} }))!;
    await w.deps.repo.odooEvents.pending(10, w.deps.clock.now());   // A reservada
    const b = await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: 900, odooAction: null, payload: {} });
    expect(b).toBeGreaterThan(0);

    // A volta a ficar reservável e falha com erro transitório
    await w.pool.query("update odoo_events set locked_at = $2 where id=$1", [a, new Date(w.deps.clock.now().getTime() - 20 * 60_000)]);
    w.odoo.getInvoice = async () => { throw Object.assign(new Error("odoo 503"), { transient: true }); };

    await expect(processOdooEvents(w.deps), "o worker morreu — a bomba ainda está armada").resolves.toBeTruthy();
    const linhas = (await w.pool.query("select id, process_status, error from odoo_events order by id")).rows;
    // O lote pega as DUAS (A reservável de novo, B pendente): a primeira volta para a fila e a
    // segunda colide. O invariante é que ninguém morre e a colisão vira `ignored` com o motivo.
    const status = linhas.map((l) => String(l.process_status)).sort();
    expect(status, `estados inesperados: ${status}`).toEqual(["ignored", "pending"]);
    const ignorada = linhas.find((l) => l.process_status === "ignored");
    expect(String(ignorada?.error)).toContain("já existe notificação pendente");
    expect(a).toBeGreaterThan(0);
  });

  it("P1: o worker de Asaas roda mesmo quando o de Odoo tropeça na colisão", async () => {
    w = await world();
    const { runJob } = await import("../../src/app/scheduler.js");
    const a = (await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: 901, odooAction: null, payload: {} }))!;
    await w.deps.repo.odooEvents.pending(10, w.deps.clock.now());
    await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: 901, odooAction: null, payload: {} });
    await w.pool.query("update odoo_events set locked_at = $2 where id=$1", [a, new Date(w.deps.clock.now().getTime() - 20 * 60_000)]);
    w.odoo.getInvoice = async () => { throw Object.assign(new Error("odoo 503"), { transient: true }); };

    const r = await runJob(w.deps, "worker") as { asaas?: unknown } | null;
    expect(r, "o job worker inteiro caiu").not.toBeNull();
    expect(r?.asaas, "o processamento do Asaas nem chegou a rodar").toBeDefined();
  });

  it("P1: requeue-all que falha não escreve na tabela ERRADA", async () => {
    // As duas filas têm sequência própria começando em 1, então id colide o tempo todo. O catch
    // escrevia sempre em `odoo_events`: uma notificação sem relação nenhuma virava `ignored`, e o
    // boleto dela nunca era emitido.
    w = await world();
    const vitima = (await w.deps.repo.odooEvents.insert({ odooModel: "account.move", odooId: 950, odooAction: null, payload: {} }))!;
    const evento = (await w.deps.repo.asaasEvents.insert({ asaasEventId: "ev", eventType: "PAYMENT_RECEIVED", asaasPaymentId: "pay_x", payload: {} }))!;
    expect(vitima).toBe(evento);   // mesmo id nas duas tabelas: é o caso comum
    await w.deps.repo.asaasEvents.mark(evento, "error", { error: "odoo fora" });
    await w.deps.repo.exceptions.open({ type: "payment_unmatched", refTable: "webhook_events", refId: evento, detail: {} });

    // força a falha no caminho do webhook_events
    const original = w.deps.repo.asaasEvents.requeueFromError;
    w.deps.repo.asaasEvents.requeueFromError = async () => { throw new Error("erro transitório do banco"); };
    const r = await requeueAllByType(w.deps, "payment_unmatched");
    w.deps.repo.asaasEvents.requeueFromError = original;

    expect(r).toMatchObject({ ok: true, detail: { requeued: 0, skipped: 1 } });
    const intacta = (await w.pool.query("select process_status, error from odoo_events where id=$1", [vitima])).rows[0];
    expect(intacta, "a notificação do Odoo foi marcada por engano").toMatchObject({ process_status: "pending", error: null });
  });

  it("P2: marcar SEM token não sobrescreve evento reservado por outro", async () => {
    w = await world();
    const id = (await w.deps.repo.asaasEvents.insert({ asaasEventId: "e9", eventType: "PAYMENT_RECEIVED", asaasPaymentId: "pay_9", payload: {} }))!;
    // sem reserva: marcar sem token é legítimo (é o que o receptor do webhook faz)
    expect(await w.deps.repo.asaasEvents.mark(id, "ignored")).toBe(true);
    await w.deps.repo.asaasEvents.reset(id);

    const [reservado] = await w.deps.repo.asaasEvents.pending(10, w.deps.clock.now());
    // agora ESTÁ reservado: quem não tem o token não escreve
    expect(await w.deps.repo.asaasEvents.mark(id, "error", { error: "sem token" })).toBe(false);
    expect(await w.deps.repo.asaasEvents.touch(id, new Date())).toBe(false);
    expect(await w.deps.repo.asaasEvents.mark(id, "done", { claimToken: reservado!.claimToken })).toBe(true);
  });

  it("P2: tripwire não recusa banco saudável com uma chave apagada, mas avisa", async () => {
    w = await world();
    const { assertLeitura } = await import("../../src/adapters/db/migrations.js");
    const avisos: string[] = [];
    await w.pool.query("delete from app_config where key='ASAAS_PENALIZED_LAST'");
    await expect(assertLeitura(w.pool, (m) => avisos.push(m))).resolves.toBeUndefined();
    expect(avisos[0]).toContain("ASAAS_PENALIZED_LAST");
    expect(avisos[0]).toContain("não RLS");

    // mas NENHUMA chave visível continua sendo recusa: é a assinatura de RLS bloqueando
    await w.pool.query("delete from app_config");
    await expect(assertLeitura(w.pool)).rejects.toThrow(/NENHUMA das/);
  });

  it("P1: banco anterior à 0008 (sem a coluna de hash) migra em vez de quebrar", async () => {
    // O upgrade quebrava em TODO ambiente existente: `create table if not exists` é no-op, então a
    // coluna nunca era criada e o backfill rodava antes da 0008.
    w = await world();
    const { applyMigrations } = await import("../../src/adapters/db/migrations.js");
    // `if exists` porque uma rodada anterior pode ter deixado a coluna caída: teste que só passa
    // em banco limpo é teste que falha quando mais importa.
    await w.pool.query("alter table schema_migrations drop column if exists content_sha256");
    await expect(applyMigrations(w.pool)).resolves.toEqual([]);
    const n = Number((await w.pool.query("select count(*)::int as n from schema_migrations where content_sha256 is null")).rows[0].n);
    expect(n, "o backfill não preencheu os hashes").toBe(0);
  });
});
