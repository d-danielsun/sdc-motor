// Envio de e-mail pelo Resend. `fetch` cru, sem SDK — o mesmo padrão do salvei/site.
//
// Sem RESEND_API_KEY o motor NÃO quebra: cai no no-op, que só loga. Alerta é aviso, e um
// ambiente sem canal configurado (desenvolvimento, demonstração) tem que subir igual.
import type { Logger, Notifier } from "../../core/ports.js";

const RESEND_URL = "https://api.resend.com/emails";
/** O envio não pode prender o tick do job. Estourar o prazo é falha de envio, não de motor. */
export const ENVIO_TIMEOUT_MS = 10_000;

/** Separa por vírgula, tira espaço e vazio. `ALERT_EMAIL` é uma lista. */
export const parseDestinatarios = (v: string | null | undefined): string[] =>
  (v ?? "").split(",").map((e) => e.trim()).filter((e) => e.includes("@"));

export function createResendNotifier(o: {
  apiKey: string; from: string; para: readonly string[];
  fetchImpl?: typeof fetch; timeoutMs?: number;
}): Notifier {
  const fetchImpl = o.fetchImpl ?? fetch;
  return {
    canal: "resend",
    destinatarios: [...o.para],
    async entregar(a) {
      const res = await fetchImpl(RESEND_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: o.from, to: [...o.para], subject: a.assunto, text: a.corpo }),
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

/** Nenhum canal configurado: registra que teria mandado e segue. Não é erro. */
export function createNoopNotifier(log: Logger, motivo: string): Notifier {
  return {
    canal: "no-op",
    destinatarios: [],
    async entregar(a) {
      log("alerta NÃO enviado (canal no-op)", { motivo, assunto: a.assunto });
    },
  };
}
