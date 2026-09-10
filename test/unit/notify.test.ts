// Adaptador do Resend e a lista de destinatários, sem banco e sem rede. O que este arquivo
// protege: um canal ausente não quebra o motor, um 500 do Resend vira erro legível, e o envio
// não fica pendurado além do prazo.
import { describe, expect, it, vi } from "vitest";
import { ENVIO_TIMEOUT_MS, MAX_DESTINATARIOS, createNoopNotifier, createResendNotifier, paraHtml, parseDestinatarios } from "../../src/adapters/notify/resend.js";
import { FakeNotifier } from "../../src/adapters/notify/fake.js";
import { alertaChaveVencendo, alertaFilaInterrompida, alertaJobFalhou, alertaSilencio, SILENCIO_LONGO_MINUTOS, SILENCIO_PADRAO_MINUTOS } from "../../src/core/usecases/notify.js";

const ok = () => new Response(JSON.stringify({ id: "re_1" }), { status: 200, headers: { "content-type": "application/json" } });

describe("lista de destinatários", () => {
  it("separa por vírgula, tira espaço e descarta o que não é e-mail", () => {
    expect(parseDestinatarios("a@x.com, b@y.com")).toEqual(["a@x.com", "b@y.com"]);
    expect(parseDestinatarios(" a@x.com ,, b@y.com , ")).toEqual(["a@x.com", "b@y.com"]);
    expect(parseDestinatarios("")).toEqual([]);
    expect(parseDestinatarios(null)).toEqual([]);
    expect(parseDestinatarios("nao-e-email, outro")).toEqual([]);
  });
  it("corta a lista no limite do Resend em vez de deixar o envio falhar sempre", () => {
    const muitos = Array.from({ length: 80 }, (_, i) => `p${i}@x.com`).join(",");
    expect(parseDestinatarios(muitos)).toHaveLength(MAX_DESTINATARIOS);
    expect(MAX_DESTINATARIOS).toBe(50);
  });
});

describe("corpo HTML", () => {
  it("o link vira âncora de verdade, e o texto do servidor é escapado", () => {
    const html = paraHtml("linha um\nlinha dois\nhttps://m.exemplo.com.br/console/#/excecoes/7", "https://m.exemplo.com.br/console/#/excecoes/7");
    expect(html).toContain('<a href="https://m.exemplo.com.br/console/#/excecoes/7">');
    expect(html).toContain("<br>");
    expect(html).not.toContain("#/excecoes/7</p>");   // a URL crua não fica sobrando no texto
    // nome de cliente com HTML não pode virar marcação
    const perigoso = paraHtml('cliente <script>alert(1)</script> & "cia"', null);
    expect(perigoso).not.toContain("<script>");
    expect(perigoso).toContain("&lt;script&gt;");
    expect(perigoso).toContain("&amp;");
  });
});

describe("adaptador do Resend", () => {
  it("manda from, to, subject e text para o endpoint certo, com Bearer", async () => {
    const chamadas: Array<{ url: string; init: RequestInit }> = [];
    const n = createResendNotifier({
      apiKey: "re_chave", from: "motor@exemplo.com.br", para: ["a@x.com", "b@y.com"],
      fetchImpl: (async (url, init) => { chamadas.push({ url: String(url), init: init ?? {} }); return ok(); }) as typeof fetch,
    });
    await n.entregar({ assunto: "assunto", corpo: "corpo do alerta", link: null });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.url).toBe("https://api.resend.com/emails");
    const h = chamadas[0]?.init.headers as Record<string, string>;
    expect(h.authorization).toBe("Bearer re_chave");
    const corpo = JSON.parse(String(chamadas[0]?.init.body));
    expect(corpo).toMatchObject({ from: "motor@exemplo.com.br", to: ["a@x.com", "b@y.com"], subject: "assunto", text: "corpo do alerta" });
    expect(Object.keys(corpo).sort()).toEqual(["from", "html", "subject", "text", "to"]);   // text E html
    expect(n.canal).toBe("resend");
    expect(n.destinatarios).toEqual(["a@x.com", "b@y.com"]);
  });

  it("resposta não-2xx lança com o corpo do Resend, que é onde vem o motivo", async () => {
    const n = createResendNotifier({
      apiKey: "re_x", from: "m@x.com", para: ["a@x.com"],
      fetchImpl: (async () => new Response('{"message":"The from address is not verified"}', { status: 403 })) as typeof fetch,
    });
    await expect(n.entregar({ assunto: "a", corpo: "b", link: null })).rejects.toThrow(/resend 403.*not verified/);
  });

  it("redirect não é sucesso (chave apontando para o lugar errado)", async () => {
    const n = createResendNotifier({
      apiKey: "re_x", from: "m@x.com", para: ["a@x.com"],
      fetchImpl: (async () => new Response("", { status: 302, headers: { location: "https://outro" } })) as typeof fetch,
    });
    await expect(n.entregar({ assunto: "a", corpo: "b", link: null })).rejects.toThrow(/resend 302/);
  });

  it("o prazo de envio é passado ao fetch, para o tick do job não ficar pendurado", async () => {
    let sinal: AbortSignal | undefined;
    const n = createResendNotifier({
      apiKey: "re_x", from: "m@x.com", para: ["a@x.com"], timeoutMs: 50,
      fetchImpl: (async (_u, init) => { sinal = init?.signal ?? undefined; return ok(); }) as typeof fetch,
    });
    await n.entregar({ assunto: "a", corpo: "b", link: null });
    expect(sinal).toBeInstanceOf(AbortSignal);
    expect(ENVIO_TIMEOUT_MS).toBe(10_000);
  });

  it("prazo estourado vira falha de envio, não travamento", async () => {
    const n = createResendNotifier({
      apiKey: "re_x", from: "m@x.com", para: ["a@x.com"], timeoutMs: 20,
      fetchImpl: ((_u: unknown, init?: RequestInit) => new Promise((_ok, no) => {
        init?.signal?.addEventListener("abort", () => no(new Error("The operation was aborted due to timeout")));
      })) as typeof fetch,
    });
    await expect(n.entregar({ assunto: "a", corpo: "b", link: null })).rejects.toThrow(/abort|timeout/i);
  });
});

describe("canal no-op", () => {
  it("sem chave, registra que teria mandado e NÃO lança (AC1)", async () => {
    const linhas: Array<{ msg: string; ctx?: Record<string, unknown> }> = [];
    const n = createNoopNotifier((msg, ctx) => linhas.push({ msg, ctx }), "RESEND_API_KEY ausente");
    await expect(n.entregar({ assunto: "fila parada", corpo: "x", link: null })).resolves.toBeUndefined();
    expect(n.canal).toBe("no-op");
    expect(n.ativo).toBe(false);   // é o que faz o núcleo nem reservar janela
    expect(n.destinatarios).toEqual([]);
    expect(linhas[0]?.msg).toContain("no-op");
    expect(linhas[0]?.ctx).toMatchObject({ motivo: "RESEND_API_KEY ausente", assunto: "fila parada" });
  });
});

describe("o texto dos alertas", () => {
  it("cada alerta diz o que aconteceu, o que o motor tentou e o que fazer", () => {
    const fila = alertaFilaInterrompida({ webhookId: "wh_1", penalizedRequestsCount: 15, reativado: true });
    expect(fila.assunto).toBe("Motor SDC: fila do Asaas interrompida");
    expect(fila.chave).toBe("queue_interrupted:wh_1");
    expect(fila.silencioMinutos).toBe(SILENCIO_PADRAO_MINUTOS);
    // a consequência precisa estar no corpo: é o que decide se a pessoa levanta da cadeira
    expect(fila.corpo).toContain("nenhuma baixa acontece no Odoo");
    expect(fila.corpo).toContain("14 dias");

    const job = alertaJobFalhou({ job: "reconcile-daily", error: "odoo 401 unauthorized" });
    expect(job.chave).toBe("integration_error:reconcile-daily");
    expect(job.corpo).toContain("odoo 401");
    expect(job.corpo).toContain("chave de API vencida");

    const silencio = alertaSilencio({ horas: 8, ultimoEventoEm: "2026-09-10T10:00:00.000Z", cobrancasAbertas: 3 });
    expect(silencio.chave).toBe("stale_heartbeat");
    expect(silencio.corpo).toContain("3 cobrança(s) em aberto");
    expect(silencio.corpo).toContain("painel do Asaas");   // como distinguir dia fraco de webhook quebrado

    const chave = alertaChaveVencendo({ ageDays: 80 });
    expect(chave.silencioMinutos).toBe(SILENCIO_LONGO_MINUTOS);   // 24h, não 6h: não é urgente
    expect(chave.corpo).toContain("80 dias");
    expect(chave.corpo).toContain("Minhas preferências");
  });

  it("um erro gigante do upstream é cortado antes de virar e-mail", () => {
    const job = alertaJobFalhou({ job: "worker", error: "x".repeat(5000) });
    expect(job.corpo.length).toBeLessThan(1500);
  });

  it("a chave do alerta separa jobs diferentes e junta o mesmo job", () => {
    expect(alertaJobFalhou({ job: "worker", error: "a" }).chave).not.toBe(alertaJobFalhou({ job: "watchdog", error: "a" }).chave);
    expect(alertaJobFalhou({ job: "worker", error: "a" }).chave).toBe(alertaJobFalhou({ job: "worker", error: "erro diferente" }).chave);
  });
});

describe("notifier falso dos testes", () => {
  it("guarda o que foi entregue e sabe falhar quando o teste pede", async () => {
    const f = new FakeNotifier(["a@x.com"]);
    await f.entregar({ assunto: "um", corpo: "c", link: "https://x" });
    expect(f.enviados).toHaveLength(1);
    expect(f.ultimo).toMatchObject({ assunto: "um", link: "https://x" });
    f.falharCom = "resend 500";
    await expect(f.entregar({ assunto: "dois", corpo: "c", link: null })).rejects.toThrow("resend 500");
    expect(f.enviados).toHaveLength(1);   // o que falhou não entra na lista
  });
});
