// Envio de e-mail pelo Resend. `fetch` cru, sem SDK — o mesmo padrão do salvei/site.
//
// Sem RESEND_API_KEY o motor NÃO quebra: cai no no-op, que só loga. Alerta é aviso, e um
// ambiente sem canal configurado (desenvolvimento, demonstração) tem que subir igual.
import type { Logger, Notifier } from "../../core/ports.js";

const RESEND_URL = "https://api.resend.com/emails";

const escapar = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Mesmo conteúdo do texto, com o link do console como âncora de verdade. */
export const paraHtml = (corpo: string, link: string | null): string => {
  const texto = escapar(link ? corpo.replace(link, "") : corpo).replace(/\n/g, "<br>");
  const ancora = link ? `<p><a href="${escapar(link)}">Abrir no console</a></p>` : "";
  return `<div style="font:14px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#14181f"><p>${texto}</p>${ancora}</div>`;
};
/** O envio não pode prender o tick do job. Estourar o prazo é falha de envio, não de motor. */
export const ENVIO_TIMEOUT_MS = 10_000;

/** O Resend recusa um envio com mais de 50 destinatários, e a recusa apareceria como alerta
 *  eternamente falhando, sem causa visível. Cortar aqui é melhor que descobrir lá. */
export const MAX_DESTINATARIOS = 50;

/** Separa por vírgula, tira espaço e vazio. `ALERT_EMAIL` é uma lista. */
export const parseDestinatarios = (v: string | null | undefined): string[] =>
  (v ?? "").split(",").map((e) => e.trim()).filter((e) => e.includes("@")).slice(0, MAX_DESTINATARIOS);

export function createResendNotifier(o: {
  apiKey: string; from: string; para: readonly string[];
  fetchImpl?: typeof fetch; timeoutMs?: number;
}): Notifier {
  const fetchImpl = o.fetchImpl ?? fetch;
  return {
    canal: "resend",
    ativo: true,
    destinatarios: [...o.para],
    async entregar(a) {
      const res = await fetchImpl(RESEND_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
        // `text` e `html`: em texto puro, cliente de e-mail que não autolinka deixaria o link
        // do console como texto morto, e o link é o ponto do alerta.
        body: JSON.stringify({ from: o.from, to: [...o.para], subject: a.assunto, text: a.corpo, html: paraHtml(a.corpo, a.link) }),
        redirect: "manual",
        signal: AbortSignal.timeout(o.timeoutMs ?? ENVIO_TIMEOUT_MS),
      });
      if (res.status < 200 || res.status >= 300) {
        // O corpo do Resend explica o motivo (remetente não verificado, chave inválida): vale
        // guardar, cortado, em alerts_sent.error.
        const detalhe = await res.text().catch(() => "");
        throw new Error(`resend ${res.status}: ${detalhe.slice(0, 300)}`);
      }
    },
  };
}

/** Nenhum canal configurado. `ativo: false` faz o núcleo nem reservar janela: nada é gravado em
 *  alerts_sent, porque nada foi tentado. Não é erro — alerta é aviso, não dinheiro. */
export function createNoopNotifier(log: Logger, motivo: string): Notifier {
  return {
    canal: "no-op",
    ativo: false,
    destinatarios: [],
    // Não loga: quem registra o alerta suprimido é o núcleo (`alertar` devolve "sem_canal" antes
    // de chegar aqui, porque `ativo` é false). Dois lugares donos do mesmo log é o que dá drift.
    async entregar() {},
  };
}
