// Alerta crítico: avisa uma pessoa no momento em que a coisa acontece.
//
// POR QUE ISTO EXISTE. Quando a fila do Asaas é interrompida (15 falhas seguidas), o motor
// abre exceção e tenta reativar — e ninguém fica sabendo. Os eventos do Asaas morrem em 14
// dias, então uma fila parada numa sexta pode custar o fim de semana e virar dinheiro que não
// entrou. O console mostra tudo isso, mas só para quem abre o console.
//
// TRÊS DECISÕES QUE ESTE ARQUIVO SEGUE:
// 1. Alerta é aviso, não dinheiro. Falha de envio NUNCA derruba o job que o disparou, e não
//    há retry dentro do tick: se a condição persistir, a próxima janela avisa de novo. Retry
//    imediato é o comportamento certo para uma baixa, e errado para um e-mail.
// 2. O dedupe é do banco, em janela deslizante: quem reservou a linha manda, quem não reservou
//    cala. A exclusão entre processos vem de advisory lock por chave dentro da reserva — o
//    `where not exists` sozinho NÃO basta, e o comentário em `alerts.reservar` diz por quê.
// 3. A linha registra a TENTATIVA. Se o processo morrer entre reservar e enviar, aquele aviso
//    se perde e o próximo sai na janela seguinte. Preferimos perder um aviso a mandar dez.
import type { Deps } from "../ports.js";
import type { Alert, ExceptionType } from "../types.js";

export const SILENCIO_PADRAO_MINUTOS = 6 * 60;
export const SILENCIO_LONGO_MINUTOS = 24 * 60;

export type ResultadoAlerta = "enviado" | "silenciado" | "sem_canal" | "sem_destinatario" | "falhou";

/** Monta o link para a tela que resolve o problema. Sem exceção associada, a saúde geral. */
export function linkDoAlerta(baseUrl: string | null, excecaoId?: number | null): string | null {
  if (!baseUrl) return null;
  const base = baseUrl.replace(/\/+$/, "");
  return excecaoId ? `${base}/console/#/excecoes/${excecaoId}` : `${base}/console/#/saude`;
}

/**
 * Manda um alerta, se for a vez dele. Devolve o que aconteceu, para o job poder logar.
 *
 * gstack-shortcut(dec-14-resumo-diario): esta rodada manda SÓ alerta crítico, no instante do
 * evento — sem resumo diário do que aconteceu no dia. Upgrade quando alguém pedir "queria ver
 * o que rolou ontem" ou quando os tipos de alerta passarem de uns poucos por semana, aí o
 * resumo passa a valer mais que o ruído que evita.
 */
export async function alertar(deps: Deps, a: Alert, o: { consoleUrl?: string | null } = {}): Promise<ResultadoAlerta> {
  const { repo, notify, log } = deps;
  if (!notify) return "sem_canal";
  if (!notify.ativo) {
    // Canal desligado por configuração. Vale registrar POR ALERTA o que teria saído: é o que
    // mostra, no log de um ambiente sem chave, quantas vezes alguém teria sido avisado.
    log("alerta NÃO enviado: canal desligado", { chave: a.chave, assunto: a.assunto, canal: notify.canal });
    return "sem_canal";
  }
  const destinatarios = notify.destinatarios.filter(Boolean);
  if (destinatarios.length === 0) {
    log("alerta sem destinatário configurado", { chave: a.chave, assunto: a.assunto });
    return "sem_destinatario";
  }

  const recipients = destinatarios.join(", ");
  let id: number | null;
  try {
    id = await repo.alerts.reservar({ alertKey: a.chave, channel: notify.canal, recipients, janelaMinutos: a.silencioMinutos });
  } catch (e) {
    // O alerta depende do banco (é lá que mora o dedupe). Banco fora não é notificado por
    // e-mail — limitação declarada: quem cobre isso é o healthcheck do orquestrador.
    log("não consegui reservar a janela do alerta", { chave: a.chave, error: (e as Error).message });
    return "falhou";
  }
  if (id === null) return "silenciado";

  const link = linkDoAlerta(o.consoleUrl ?? null, a.excecaoId);
  try {
    await notify.entregar({ assunto: a.assunto, corpo: corpoComLink(a.corpo, link), link });
  } catch (e) {
    const error = (e as Error).message || String(e);
    // Registrar a falha na linha JÁ inserida: a janela continua valendo, então a condição
    // persistindo avisa de novo depois, sem inundar agora.
    await repo.alerts.registrar(id, { ok: false, error: error.slice(0, 500) }).catch(() => undefined);
    log("alerta falhou no envio", { chave: a.chave, error });
    return "falhou";
  }
  // Fora do try do envio de propósito: um tropeço do banco DEPOIS da entrega não pode gravar
  // "falhou" numa mensagem que já saiu — a trilha diria o contrário do que aconteceu.
  await repo.alerts.registrar(id, { ok: true }).catch((e) => log("alerta enviado, mas não consegui registrar", { chave: a.chave, error: (e as Error).message }));
  log("alerta enviado", { chave: a.chave, canal: notify.canal, destinatarios: destinatarios.length });
  return "enviado";
}

const corpoComLink = (corpo: string, link: string | null): string =>
  link ? `${corpo}\n\nAbra no console:\n${link}\n` : `${corpo}\n`;

// ── os cinco alertas ─────────────────────────────────────────────────────────
//
// O texto é o produto aqui: quem recebe às 3h da manhã precisa saber, em três linhas, o que
// aconteceu, o que o motor já tentou sozinho e o que só uma pessoa resolve.

export const alertaFilaInterrompida = (d: { webhookId: string; penalizedRequestsCount: number | null; reativado: boolean; excecaoId?: number | null }): Alert => ({
  tipo: "queue_interrupted",
  chave: `queue_interrupted:${d.webhookId}`,
  assunto: "Motor SDC: fila do Asaas interrompida",
  corpo: [
    "O Asaas interrompeu a fila de eventos deste webhook. Enquanto ela estiver parada, NENHUM",
    "pagamento recebido chega ao motor, e portanto nenhuma baixa acontece no Odoo.",
    "",
    `O que o motor já fez: ${d.reativado ? "pediu a reativação da fila ao Asaas agora." : "detectou a interrupção; a reativação foi pedida há menos de uma hora e ainda não surtiu efeito."}`,
    "",
    "O que conferir: se a interrupção voltar, o motivo costuma ser o endpoint devolvendo erro",
    "ou demorando. Veja as últimas entregas no painel do Asaas e a saúde do motor no console.",
    "",
    "Prazo que importa: o Asaas guarda os eventos por 14 dias. Depois disso, o que não foi",
    "entregue é recuperado pelo reconcile diário, mas só dentro da janela de lookback.",
    `webhook: ${d.webhookId}${d.penalizedRequestsCount !== null ? ` · penalizações acumuladas: ${d.penalizedRequestsCount}` : ""}`,
  ].join("\n"),
  silencioMinutos: SILENCIO_PADRAO_MINUTOS,
  excecaoId: d.excecaoId ?? null,
});

export const alertaJobFalhou = (d: { job: string; error: string; excecaoId?: number | null }): Alert => ({
  tipo: "integration_error",
  chave: `integration_error:${d.job}`,
  assunto: `Motor SDC: o job ${d.job} está falhando`,
  corpo: [
    `O job \`${d.job}\` falhou. Enquanto ele não voltar, a parte do ciclo que ele cobre para de`,
    "acontecer — e o motor não avisa duas vezes na mesma janela de 6 horas.",
    "",
    `Erro: ${d.error.slice(0, 400)}`,
    "",
    "Causas comuns, em ordem de frequência: chave de API vencida (Odoo ou Asaas), base do Odoo",
    "expirada, banco de dados fora do ar. O motor volta a tentar no próximo tick sozinho; este",
    "e-mail existe para o caso de a falha ser permanente.",
  ].join("\n"),
  silencioMinutos: SILENCIO_PADRAO_MINUTOS,
  excecaoId: d.excecaoId ?? null,
});

export const alertaSilencio = (d: { horas: number; ultimoEventoEm: string | null; cobrancasAbertas: number; excecaoId?: number | null }): Alert => ({
  tipo: "stale_heartbeat",
  chave: "stale_heartbeat",
  assunto: "Motor SDC: nenhum pagamento chegou hoje",
  corpo: [
    `Não chega evento de pagamento do Asaas há mais de ${d.horas} horas, em horário comercial, com`,
    `${d.cobrancasAbertas} cobrança(s) em aberto. Pode ser um dia fraco, e pode ser que o caminho de volta`,
    "esteja quebrado sem dar erro.",
    "",
    `Último evento recebido: ${d.ultimoEventoEm ?? "nenhum registrado"}.`,
    "",
    "Como saber a diferença: veja no painel do Asaas se há cobranças pagas hoje. Se houver e o",
    "motor não recebeu, o problema é o webhook, não o movimento.",
  ].join("\n"),
  silencioMinutos: SILENCIO_PADRAO_MINUTOS,
  excecaoId: d.excecaoId ?? null,
});

/** O motor tentou, não conseguiu, e ninguém ficou sabendo.
 *
 *  POR QUE ESTE ALERTA EXISTE SEPARADO DOS OUTROS. O `alertaJobFalhou` mora no `catch` do job —
 *  mas os workers capturam erro POR ITEM e devolvem contadores, então o job nunca estoura. Uma
 *  permissão faltando só na baixa deixava evento em `error`, exceção aberta no console e ZERO
 *  e-mails: o dinheiro entra no Asaas, o Odoo não recebe a liquidação, e você descobre pelo
 *  cliente. Este alerta olha o ESTADO (exceção de falha velha), não a exceção estourada.
 *
 *  A janela de 30 min existe para o transitório se curar sozinho antes de virar e-mail: retry com
 *  backoff resolve soluço de rede, e só o que sobrevive a meia hora é falha de verdade. */
export const alertaTravada = (d: { tipo: ExceptionType; total: number; minutos: number; excecaoId?: number | null }): Alert => ({
  tipo: d.tipo,
  chave: `travada:${d.tipo}`,
  assunto: `Motor SDC: ${d.total} exceção(ões) de ${ROTULO_TRAVA[d.tipo] ?? d.tipo} sem resolução`,
  corpo: [
    // O texto fala do ESTADO (há exceção parada que ninguém tratou) e não do que aconteceu.
    // A versão anterior afirmava, para `payment_unmatched`, que "o dinheiro entrou" — mas esse
    // mesmo tipo é aberto para webhook FORJADO (pagamento que não existe no Asaas), onde não
    // entrou nada; e para `charge_create_failed` dizia "nenhum boleto foi enviado", quando esse
    // tipo também cobre falha de CANCELAMENTO, em que existe um boleto vivo e pagável. Alerta
    // que afirma mais do que o dado sustenta manda a pessoa investigar a coisa errada.
    `${d.total} exceção(ões) de ${ROTULO_TRAVA[d.tipo] ?? d.tipo} está(ão) aberta(s), a mais antiga há`,
    `${d.minutos} minutos. O motor já esgotou os retries automáticos: o que sobrou precisa de uma pessoa.`,
    "",
    CONSEQUENCIA[d.tipo] ?? "Enquanto estiverem abertas, a parte do ciclo que elas representam não avança.",
    "",
    "O que conferir primeiro: abra a exceção no console. O detalhe traz o erro cru do Odoo ou do",
    "Asaas e o que o motor estava tentando fazer. Chave de API sem permissão e base do Odoo",
    "expirada são as duas causas mais comuns. Corrigida a causa, o botão \"reprocessar\" reenfileira.",
  ].join("\n"),
  silencioMinutos: SILENCIO_PADRAO_MINUTOS,
  excecaoId: d.excecaoId ?? null,
});

const ROTULO_TRAVA: Partial<Record<ExceptionType, string>> = {
  payment_unmatched: "pagamento não conciliado",
  charge_create_failed: "cobrança não processada",
  integration_error: "erro de integração",
};

/** O que está em jogo, sem afirmar qual dos casos do tipo aconteceu. */
const CONSEQUENCIA: Partial<Record<ExceptionType, string>> = {
  payment_unmatched: "Envolve o caminho do dinheiro: pode ser pagamento recebido que não virou baixa no Odoo,\ncobrança que o evento não achou, ou evento que não corresponde a pagamento nenhum. A exceção diz qual.",
  charge_create_failed: "Envolve o boleto: pode ser cobrança que não foi criada (o cliente não recebeu nada) ou\ncancelamento que falhou (existe boleto vivo, ainda pagável, para uma fatura cancelada). A exceção diz qual.",
  integration_error: "Um job falhou. Se ele voltou a rodar sozinho depois, a exceção continua aberta até alguém\nfechá-la — confira a data do último sucesso na tela de Saúde antes de agir.",
};

export const alertaChaveVencendo = (d: { ageDays: number; excecaoId?: number | null }): Alert => ({
  tipo: "api_key_expiring",
  chave: "api_key_expiring",
  assunto: "Motor SDC: a chave de API do Odoo está perto de vencer",
  corpo: [
    `A chave de API do Odoo tem ${d.ageDays} dias. Elas vencem em 90, e quando vence o motor para de`,
    "dar baixa: a cobrança continua sendo emitida e paga, mas o Odoo não recebe a liquidação.",
    "",
    "O que fazer: gerar uma chave nova no Odoo (Minhas preferências, aba Segurança da conta),",
    "guardá-la no 1Password e trocar o segredo do ambiente. Não precisa de janela de manutenção.",
    "",
    "Este aviso repete uma vez por dia até a chave ser trocada.",
  ].join("\n"),
  silencioMinutos: SILENCIO_LONGO_MINUTOS,
  excecaoId: d.excecaoId ?? null,
});
