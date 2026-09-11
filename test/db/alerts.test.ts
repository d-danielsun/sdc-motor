// Alerta crítico contra Postgres real. O que este arquivo protege: uma fila parada avisa UMA
// vez, avisa de novo 6h depois se continuar parada, e um Resend fora do ar não derruba o job.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { watchdog } from "../../src/core/index.js";
import { SILENCIO_LONGO_MINUTOS, SILENCIO_PADRAO_MINUTOS, alertaFilaInterrompida, alertar, linkDoAlerta } from "../../src/core/usecases/notify.js";
import { dbReachable, world, type World } from "../helpers.js";

let w: World | undefined;
beforeAll(async () => {
  if (!(await dbReachable())) throw new Error("Postgres inacessível — npm run db:up && npm run db:migrate:test");
});
afterEach(async () => { const atual = w; w = undefined; await atual?.close(); });

/** Webhook registrado e interrompido: a condição que o watchdog detecta.
 *
 *  Atenção ao ciclo real: o watchdog PEDE a reativação da fila, então o tick seguinte já vê
 *  `interrupted=false`. Se o endpoint continuar falhando, o Asaas interrompe de novo depois de
 *  mais 15 falhas — é isso que `voltaAParar` reproduz. Testar sem isso mediria uma condição
 *  que na prática não persiste. */
async function filaParada(mundo: World, penalizado = 15) {
  const wh = await mundo.asaas.createWebhook({ name: "motor", url: "https://motor.exemplo.com.br/webhook-asaas", email: "alertas@exemplo.com.br", authToken: "t".repeat(32), events: ["PAYMENT_RECEIVED"] });
  await mundo.deps.repo.config.set("ASAAS_WEBHOOK_ID", wh.id);
  mundo.asaas.interrupt(wh.id, penalizado);
  return wh;
}
const linhas = async (mundo: World) => mundo.deps.repo.alerts.recentes();
/** O Asaas interrompe de novo: o endpoint continua ruim depois da reativação. */
async function voltaAParar(mundo: World) {
  const id = await mundo.deps.repo.config.get<string>("ASAAS_WEBHOOK_ID");
  mundo.asaas.interrupt(String(id), 15);
}

describe("alertas críticos (#14)", () => {
  it("fila interrompida → 1 e-mail no mesmo tick do watchdog (AC2)", async () => {
    w = await world();
    await filaParada(w);
    const s = await watchdog(w.deps);

    expect(s.interrupted).toBe(true);
    expect(s.alertas.queue_interrupted).toBe("enviado");
    expect(w.notify.enviados).toHaveLength(1);
    expect(w.notify.ultimo?.assunto).toBe("Motor SDC: fila do Asaas interrompida");
    // o e-mail diz o que o motor já fez, não só que algo aconteceu
    expect(w.notify.ultimo?.corpo).toContain("pediu a reativação");
    expect(w.notify.ultimo?.corpo).toMatch(/14 dias/);
    const [linha] = await linhas(w);
    expect(linha).toMatchObject({ ok: true, error: null, recipients: "financeiro@exemplo.com.br" });
    expect(linha?.alertKey).toMatch(/^queue_interrupted:/);
  });

  it("watchdog de novo dentro da janela NÃO manda outro (AC2)", async () => {
    w = await world();
    await filaParada(w);
    await watchdog(w.deps);
    await voltaAParar(w);
    const s2 = await watchdog(w.deps);
    expect(s2.alertas.queue_interrupted).toBe("silenciado");
    expect(w.notify.enviados).toHaveLength(1);
    expect(await linhas(w)).toHaveLength(1);
  });

  it("oito processos no mesmo instante mandam UM e-mail só (AC2)", async () => {
    w = await world();
    const wh = await filaParada(w);
    const alerta = alertaFilaInterrompida({ webhookId: wh.id, penalizedRequestsCount: 15, reativado: false });

    // AQUECER O POOL É O QUE FAZ ESTE TESTE VALER. A versão anterior dele passava com a
    // implementação ERRADA: com o pool frio, o `pg` abre e autentica 8 conexões TCP, e essa
    // diferença de latência serializava as statements por acidente. O verificador da #14
    // mostrou isso. Com as conexões já abertas, as 8 chegam juntas de verdade.
    await Promise.all(Array.from({ length: 8 }, () => w!.pool.query("select 1")));

    const resultados = await Promise.all(Array.from({ length: 8 }, () => alertar(w!.deps, alerta)));
    expect(resultados.filter((r) => r === "enviado"), "mais de um processo ganhou a reserva").toHaveLength(1);
    expect(resultados.filter((r) => r === "silenciado")).toHaveLength(7);
    expect(w.notify.enviados).toHaveLength(1);
    expect(await linhas(w)).toHaveLength(1);
  });

  it("a reserva trava mesmo com duas conexões separadas, não só com um pool (AC2)", async () => {
    // O caso real do dia em que o motor rodar em duas réplicas, ou em container + cron. É o
    // teste que a implementação anterior não sobrevivia: 2 linhas para o mesmo evento.
    w = await world();
    const chave = `prova-concorrencia-${Date.now()}`;
    const reservar = () => w!.deps.repo.alerts.reservar({ alertKey: chave, channel: "fake", recipients: "a@exemplo.com.br", janelaMinutos: 360 });
    await Promise.all(Array.from({ length: 6 }, () => w!.pool.query("select 1")));
    const ids = await Promise.all(Array.from({ length: 6 }, reservar));
    expect(ids.filter((id) => id !== null)).toHaveLength(1);
    expect(Number((await w.pool.query("select count(*)::int as n from alerts_sent where alert_key=$1", [chave])).rows[0].n)).toBe(1);
  });

  it("passada a janela de 6h com a condição presente, avisa de novo (AC3)", async () => {
    w = await world();
    await filaParada(w);
    await watchdog(w.deps);
    expect(w.notify.enviados).toHaveLength(1);

    // Envelhece a linha para além da janela — é o que o tempo faria.
    await w.pool.query(`update alerts_sent set sent_at = now() - ($1 || ' minutes')::interval`, [String(SILENCIO_PADRAO_MINUTOS + 1)]);
    await voltaAParar(w);
    const s = await watchdog(w.deps);
    expect(s.alertas.queue_interrupted).toBe("enviado");
    expect(w.notify.enviados).toHaveLength(2);
    expect(await linhas(w)).toHaveLength(2);
  });

  it("janela deslizante, não balde fixo: 1 minuto antes de fechar ainda silencia", async () => {
    w = await world();
    await filaParada(w);
    await watchdog(w.deps);
    await w.pool.query(`update alerts_sent set sent_at = now() - ($1 || ' minutes')::interval`, [String(SILENCIO_PADRAO_MINUTOS - 1)]);
    await voltaAParar(w);
    const s = await watchdog(w.deps);
    expect(s.alertas.queue_interrupted).toBe("silenciado");
    expect(w.notify.enviados).toHaveLength(1);
  });

  it("Resend fora do ar → o job termina e a linha fica ok=false com o erro (AC4)", async () => {
    w = await world();
    await filaParada(w);
    w.notify.falharCom = "resend 500: internal error";

    const s = await watchdog(w.deps);
    expect(s.ok).toBe(true);                     // o watchdog terminou normalmente
    expect(s.interrupted).toBe(true);
    expect(s.alertas.queue_interrupted).toBe("falhou");
    expect(w.notify.enviados).toHaveLength(0);
    const [linha] = await linhas(w);
    expect(linha?.ok).toBe(false);
    expect(linha?.error).toContain("resend 500");
    // e a exceção do console foi aberta de qualquer jeito: o alerta é o extra, não a fonte
    expect(await w.deps.repo.exceptions.hasOpen("queue_interrupted")).toBe(true);
  });

  it("falha de envio consome a janela: não inunda enquanto o canal está fora", async () => {
    w = await world();
    await filaParada(w);
    w.notify.falharCom = "resend 500";
    await watchdog(w.deps);
    w.notify.falharCom = null;
    await voltaAParar(w);
    const s = await watchdog(w.deps);
    // A linha com ok=false segura a janela — troca consciente: perder um aviso, não mandar dez.
    expect(s.alertas.queue_interrupted).toBe("silenciado");
    expect(w.notify.enviados).toHaveLength(0);
  });

  it("dois destinatários separados por vírgula recebem os dois (AC5)", async () => {
    w = await world({ destinatarios: ["um@exemplo.com.br", "dois@exemplo.com.br"] });
    await filaParada(w);
    await watchdog(w.deps);
    expect(w.notify.enviados).toHaveLength(1);
    expect((await linhas(w))[0]?.recipients).toBe("um@exemplo.com.br, dois@exemplo.com.br");
  });

  it("sem destinatário nenhum, nada é enviado e nada é registrado", async () => {
    w = await world({ destinatarios: [] });
    await filaParada(w);
    const s = await watchdog(w.deps);
    expect(s.alertas.queue_interrupted).toBe("sem_destinatario");
    expect(await linhas(w)).toHaveLength(0);
    expect(w.logs.some((l) => l.msg.includes("sem destinatário"))).toBe(true);
  });

  it("o e-mail leva link clicável para a exceção que acabou de abrir (AC6)", async () => {
    w = await world();
    await w.deps.repo.config.set("CONSOLE_PUBLIC_URL", "https://motor.exemplo.com.br");
    await filaParada(w);
    await watchdog(w.deps);

    const exc = (await w.pool.query("select id from exceptions where type='queue_interrupted'")).rows[0];
    const esperado = `https://motor.exemplo.com.br/console/#/excecoes/${exc.id}`;
    expect(w.notify.ultimo?.link).toBe(esperado);
    expect(w.notify.ultimo?.corpo).toContain(esperado);
  });

  it("sem CONSOLE_PUBLIC_URL o e-mail sai sem link, em vez de sair com link quebrado", async () => {
    w = await world();
    await filaParada(w);
    await watchdog(w.deps);
    expect(w.notify.ultimo?.link).toBeNull();
    expect(w.notify.ultimo?.corpo).not.toContain("Abra no console");
  });

  it("job que falha manda alerta e a segunda falha na janela não manda (integration_error)", async () => {
    w = await world();
    const { createJobRunner } = await import("../../src/app/scheduler.js");
    w.odoo.searchInvoices = async () => { throw new Error("odoo 503 na varredura"); };
    const runner = createJobRunner(w.deps);

    expect(await runner.run("sync-invoices")).toBeNull();   // job falhou, sem derrubar nada
    expect(w.notify.enviados).toHaveLength(1);
    expect(w.notify.ultimo?.assunto).toContain("sync-invoices");
    expect(w.notify.ultimo?.corpo).toContain("odoo 503");

    expect(await runner.run("sync-invoices")).toBeNull();
    expect(w.notify.enviados).toHaveLength(1);              // mesma janela, mesmo job
    expect((await linhas(w))[0]?.alertKey).toBe("integration_error:sync-invoices");
  });

  it("cada job tem a própria janela: um alerta não silencia o outro", async () => {
    w = await world();
    const { createJobRunner } = await import("../../src/app/scheduler.js");
    w.odoo.searchInvoices = async () => { throw new Error("odoo fora") };
    w.asaas.getWebhook = async () => { throw new Error("asaas fora") };
    await w.deps.repo.config.set("ASAAS_WEBHOOK_ID", "wh_qualquer");
    const runner = createJobRunner(w.deps);
    await runner.run("sync-invoices");
    await runner.run("watchdog");
    expect(w.notify.enviados).toHaveLength(2);
    expect((await linhas(w)).map((l) => l.alertKey).sort()).toEqual(["integration_error:sync-invoices", "integration_error:watchdog"]);
  });

  it("chave do Odoo velha avisa com janela de 24h, não de 6h", async () => {
    w = await world();
    const noventa = new Date(w.deps.clock.now().getTime() - 80 * 24 * 3_600_000).toISOString();
    await w.deps.repo.config.set("ODOO_API_KEY_CREATED_AT", noventa);
    const s = await watchdog(w.deps);
    expect(s.apiKeyDays).toBe(80);
    expect(s.alertas.api_key_expiring).toBe("enviado");
    expect(w.notify.ultimo?.assunto).toContain("chave de API do Odoo");

    // 7h depois (passaria da janela padrão) ainda silencia; passadas 24h, avisa.
    await w.pool.query(`update alerts_sent set sent_at = now() - interval '7 hours'`);
    expect((await watchdog(w.deps)).alertas.api_key_expiring).toBe("silenciado");
    await w.pool.query(`update alerts_sent set sent_at = now() - ($1 || ' minutes')::interval`, [String(SILENCIO_LONGO_MINUTOS + 1)]);
    expect((await watchdog(w.deps)).alertas.api_key_expiring).toBe("enviado");
  });

  it("silêncio prolongado em horário comercial avisa, fora dele não", async () => {
    // Quinta-feira 13h BRT, com cobrança aberta e nenhum evento: é o caso que importa.
    w = await world({ today: "2026-09-10" });
    const { seedInvoice } = await import("../helpers.js");
    const { syncInvoices } = await import("../../src/core/index.js");
    seedInvoice(w);
    await syncInvoices(w.deps);
    expect(await w.deps.repo.charges.countOpen()).toBeGreaterThan(0);

    const s = await watchdog(w.deps);
    expect(s.staleHeartbeat).toBe(true);
    expect(s.alertas.stale_heartbeat).toBe("enviado");
    expect(w.notify.ultimo?.corpo).toContain("cobrança(s) em aberto");

    // Domingo: mesma condição, nenhum alerta — ninguém acorda no fim de semana por dia parado.
    const dom = await world({ today: "2026-09-13" });
    try {
      const { seedInvoice: seed2 } = await import("../helpers.js");
      seed2(dom);
      await syncInvoices(dom.deps);
      const s2 = await watchdog(dom.deps);
      expect(s2.staleHeartbeat).toBe(false);
      expect(dom.notify.enviados).toHaveLength(0);
    } finally { await dom.close(); }
  });

  it("canal desligado (sem chave): nada é reservado e o log diz o que teria saído (AC1)", async () => {
    w = await world();
    await filaParada(w);
    w.notify.ativo = false;
    const s = await watchdog(w.deps);
    expect(s.ok).toBe(true);
    expect(s.alertas.queue_interrupted).toBe("sem_canal");
    expect(await linhas(w)).toHaveLength(0);   // nada foi tentado, nada é registrado
    expect(w.logs.some((l) => l.msg.includes("canal desligado"))).toBe(true);
  });

  it("cada job tem a própria exceção, e o e-mail linka a certa", async () => {
    w = await world();
    const { createJobRunner } = await import("../../src/app/scheduler.js");
    w.odoo.searchInvoices = async () => { throw new Error("erro do sync") };
    w.asaas.getWebhook = async () => { throw new Error("erro do watchdog") };
    await w.deps.repo.config.set("ASAAS_WEBHOOK_ID", "wh_x");
    const runner = createJobRunner(w.deps);
    await runner.run("sync-invoices");
    await runner.run("watchdog");
    // Antes os quatro jobs dividiam UMA exceção, e o e-mail de um levava ao erro de outro.
    const excs = (await w.pool.query("select ref_table, detail from exceptions where type='integration_error' order by ref_table")).rows;
    expect(excs.map((x) => x.ref_table)).toEqual(["jobs:sync-invoices", "jobs:watchdog"]);
    expect((excs[0]?.detail as { error: string }).error).toContain("erro do sync");
    expect((excs[1]?.detail as { error: string }).error).toContain("erro do watchdog");
  });

  it("sem canal nenhum o motor funciona igual (AC1)", async () => {
    w = await world();
    await filaParada(w);
    const semCanal = { ...w.deps, notify: undefined };
    const s = await watchdog(semCanal);
    expect(s.ok).toBe(true);
    expect(s.interrupted).toBe(true);
    expect(s.alertas.queue_interrupted).toBe("sem_canal");
    expect(await linhas(w)).toHaveLength(0);
    expect(await w.deps.repo.exceptions.hasOpen("queue_interrupted")).toBe(true);
  });

  it("openOnce devolve o id da exceção aberta, nova ou já existente", async () => {
    w = await world();
    const a = await w.deps.repo.exceptions.openOnce({ type: "stale_heartbeat", refTable: "webhook_events" });
    expect(a).toMatchObject({ nova: true });
    expect(a.id).toBeGreaterThan(0);
    const b = await w.deps.repo.exceptions.openOnce({ type: "stale_heartbeat", refTable: "webhook_events" });
    expect(b).toEqual({ id: a.id, nova: false });   // mesmo id: o e-mail linka a mesma tela
  });
});

describe("link do console", () => {
  it("aponta para a exceção quando há uma, e para a saúde quando não há", () => {
    expect(linkDoAlerta("https://m.exemplo.com.br", 42)).toBe("https://m.exemplo.com.br/console/#/excecoes/42");
    expect(linkDoAlerta("https://m.exemplo.com.br/", 42)).toBe("https://m.exemplo.com.br/console/#/excecoes/42");
    expect(linkDoAlerta("https://m.exemplo.com.br", null)).toBe("https://m.exemplo.com.br/console/#/saude");
    expect(linkDoAlerta(null, 42)).toBeNull();
  });
});

// ── falha definitiva que ninguém viu (decisão do Dan, 11/09/2026) ────────────
// O buraco que isto fecha: o alerta de job mora no `catch`, e os workers capturam erro POR ITEM
// e devolvem contadores — o job nunca estoura. Baixa parada por permissão faltando ficava
// invisível: evento em `error`, exceção aberta, zero e-mails.
describe("exceção de falha travada", () => {
  /** Abre uma exceção e ENVELHECE a linha contra o clock do mundo, nunca contra o `now()` do
   *  Postgres — o mundo de teste tem relógio fixo, e misturar os dois já quebrou quatro testes. */
  async function travada(mundo: World, tipo: string, minutos: number) {
    await mundo.deps.repo.exceptions.open({ type: tipo as never, refTable: "webhook_events", detail: { error: "odoo 403 sem permissão de lançar pagamento" } });
    const quando = new Date(mundo.deps.clock.now().getTime() - minutos * 60_000);
    await mundo.pool.query("update exceptions set created_at=$1 where type=$2 and status='open'", [quando, tipo]);
  }

  it("baixa não feita há mais de 30 min manda e-mail, e o texto diz que o dinheiro entrou", async () => {
    w = await world();
    await w.deps.repo.config.set("CONSOLE_PUBLIC_URL", "https://motor.exemplo.com.br");
    await travada(w, "payment_unmatched", 31);
    const s = await watchdog(w.deps);
    expect(s.travadas).toEqual({ payment_unmatched: 1 });
    expect(s.alertas["travada:payment_unmatched"]).toBe("enviado");
    const email = w.notify.ultimo!;
    expect(email.assunto).toBe("Motor SDC: pagamento recebido e NÃO baixado no Odoo");
    expect(email.corpo).toContain("O dinheiro entrou");
    expect(email.corpo).toContain("31 minutos");
    expect(email.corpo).toContain("sem permissão de lançar pagamento");   // a causa mais comum, no corpo
    expect(email.link, "sem link o e-mail das 3h não leva a lugar nenhum").toMatch(/#\/excecoes\/\d+$/);
  });

  it("dentro dos 30 min NÃO manda: o transitório tem que poder se curar sozinho", async () => {
    w = await world();
    await travada(w, "payment_unmatched", 29);
    const s = await watchdog(w.deps);
    expect(s.travadas).toEqual({});
    expect(w.notify.enviados).toHaveLength(0);
  });

  it("cinquenta eventos quebrados pela mesma causa são UM e-mail, não cinquenta", async () => {
    w = await world();
    for (let i = 0; i < 50; i++) await travada(w, "payment_unmatched", 40);
    const s = await watchdog(w.deps);
    expect(s.travadas).toEqual({ payment_unmatched: 50 });
    expect(w.notify.enviados).toHaveLength(1);
    expect(w.notify.ultimo!.corpo).toContain("50 exceção(ões)");
  });

  it("exceção que espera DECISÃO humana não alerta — ela está aberta de propósito", async () => {
    w = await world();
    await travada(w, "writeoff_needed", 600);
    await travada(w, "amount_divergent", 600);
    await travada(w, "customer_missing_document", 600);
    const s = await watchdog(w.deps);
    expect(s.travadas).toEqual({});
    expect(w.notify.enviados).toHaveLength(0);
  });

  it("emissão travada e baixa travada são dois e-mails diferentes, cada um com seu texto", async () => {
    w = await world();
    await travada(w, "payment_unmatched", 40);
    await travada(w, "charge_create_failed", 40);
    const s = await watchdog(w.deps);
    expect(s.travadas).toEqual({ payment_unmatched: 1, charge_create_failed: 1 });
    expect(w.notify.enviados).toHaveLength(2);
    expect(w.notify.enviados.map((e) => e.assunto).sort()).toEqual([
      "Motor SDC: 1 exceção(ões) de charge_create_failed travada(s)",
      "Motor SDC: pagamento recebido e NÃO baixado no Odoo",
    ]);
    expect(w.notify.enviados.find((e) => e.assunto.includes("charge_create_failed"))!.corpo).toContain("Nenhum");
  });

  it("segundo tick dentro da janela de 6h não repete, e depois dela repete", async () => {
    w = await world();
    await travada(w, "payment_unmatched", 40);
    await watchdog(w.deps);
    expect((await watchdog(w.deps)).alertas["travada:payment_unmatched"]).toBe("silenciado");
    // envelhecer a janela do alerta é o mesmo truque: a linha de `alerts_sent` volta no tempo
    await w.pool.query("update alerts_sent set sent_at = sent_at - interval '7 hours'");
    expect((await watchdog(w.deps)).alertas["travada:payment_unmatched"]).toBe("enviado");
    expect(w.notify.enviados).toHaveLength(2);
  });
});
