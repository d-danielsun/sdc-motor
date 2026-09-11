// Fila do Asaas interrompida, penalidades subindo, silêncio suspeito, key do Odoo perto de vencer.
//
// É AQUI que quatro dos cinco alertas críticos nascem, no mesmo tick que detecta a condição — o
// watchdog roda a cada 15 min, então a detecção acontece em ≤15 min. Enviar não pode derrubar
// o watchdog: `alertar` captura a falha e devolve o resultado.
import { API_KEY_WARN_DAYS, STALE_HEARTBEAT_HOURS, TIPOS_TRAVA, TRAVADA_MINUTOS } from "../limits.js";
import type { Deps } from "../ports.js";
import { alertaChaveVencendo, alertaFilaInterrompida, alertaSilencio, alertaTravada, alertar, type ResultadoAlerta } from "./notify.js";

export interface WatchdogSummary {
  at: string; ok: boolean; interrupted: boolean; reactivated: boolean; penalizedDelta: number;
  staleHeartbeat: boolean; apiKeyDays: number | null;
  /** Exceções de FALHA abertas além do limite, por tipo. Vazio é o estado saudável. */
  travadas: Record<string, number>;
  /** O que aconteceu com cada alerta neste tick — vai pro log do job e pro console. */
  alertas: Record<string, ResultadoAlerta>;
}

const HOUR = 3_600_000;
export const apiKeyAgeDays = (createdAt: string, now: Date): number => Math.floor((now.getTime() - new Date(createdAt).getTime()) / (24 * HOUR));

export function isBusinessHoursBrt(now: Date): boolean {
  const brt = new Date(now.getTime() - 3 * HOUR); // America/Sao_Paulo sem DST desde 2019
  const dow = brt.getUTCDay(), h = brt.getUTCHours();
  return dow >= 1 && dow <= 5 && h >= 8 && h < 20;
}

export async function watchdog(deps: Deps): Promise<WatchdogSummary> {
  const { repo, asaas, clock } = deps;
  const now = clock.now();
  const s: WatchdogSummary = { at: now.toISOString(), ok: false, interrupted: false, reactivated: false, penalizedDelta: 0, staleHeartbeat: false, apiKeyDays: null, travadas: {}, alertas: {} };
  const consoleUrl = await repo.config.get<string | null>("CONSOLE_PUBLIC_URL").catch(() => null);

  const webhookId = await repo.config.get<string | null>("ASAAS_WEBHOOK_ID");
  const wh = webhookId ? await asaas.getWebhook(webhookId) : null;
  if (wh) {
    if (wh.interrupted) {
      s.interrupted = true;
      const exc = await repo.exceptions.openOnce({ type: "queue_interrupted", refTable: "asaas_webhooks", detail: { webhookId: wh.id, penalizedRequestsCount: wh.penalizedRequestsCount } });
      const last = await repo.config.get<string | null>("ASAAS_REACTIVATED_AT");
      if (!last || now.getTime() - new Date(last).getTime() >= HOUR) {
        await asaas.updateWebhook(wh.id, { interrupted: false });
        await repo.config.set("ASAAS_REACTIVATED_AT", now.toISOString());
        s.reactivated = true;
      }
      // Alerta DEPOIS da tentativa de reativação, para o e-mail já dizer o que o motor fez.
      s.alertas.queue_interrupted = await alertar(deps, alertaFilaInterrompida({
        webhookId: wh.id, penalizedRequestsCount: wh.penalizedRequestsCount, reativado: s.reactivated, excecaoId: exc.id,
      }), { consoleUrl });
    }
    const lastPenalized = (await repo.config.get<number>("ASAAS_PENALIZED_LAST")) ?? 0;
    s.penalizedDelta = wh.penalizedRequestsCount - lastPenalized;
    if (s.penalizedDelta > 0) await repo.exceptions.open({ type: "webhook_penalized", refTable: "asaas_webhooks", detail: { webhookId: wh.id, from: lastPenalized, to: wh.penalizedRequestsCount } });
    if (wh.penalizedRequestsCount !== lastPenalized) await repo.config.set("ASAAS_PENALIZED_LAST", wh.penalizedRequestsCount);
  }

  // Uma consulta só, e o resultado é reaproveitado pelo texto do alerta: chamar duas vezes
  // gastava ida e volta ao banco e podia dar números diferentes no mesmo tick.
  const abertas = isBusinessHoursBrt(now) ? await repo.charges.countOpen() : 0;
  if (abertas > 0) {
    const last = await repo.asaasEvents.lastReceivedAt();
    if (!last || now.getTime() - last.getTime() > STALE_HEARTBEAT_HOURS * HOUR) {
      s.staleHeartbeat = true;
      const exc = await repo.exceptions.openOnce({ type: "stale_heartbeat", refTable: "webhook_events", detail: { lastReceivedAt: last?.toISOString() ?? null } });
      s.alertas.stale_heartbeat = await alertar(deps, alertaSilencio({
        horas: STALE_HEARTBEAT_HOURS, ultimoEventoEm: last?.toISOString() ?? null, cobrancasAbertas: abertas, excecaoId: exc.id,
      }), { consoleUrl });
    }
  }

  // Falha que o motor não resolveu sozinho. Um alerta por TIPO, não por exceção: cinquenta eventos
  // quebrados pela mesma chave sem permissão são um problema, não cinquenta e-mails. Fora do
  // horário comercial também — baixa parada de madrugada continua sendo baixa parada de manhã.
  const limite = new Date(now.getTime() - TRAVADA_MINUTOS * 60_000);
  for (const tipo of TIPOS_TRAVA) {
    const t = await repo.exceptions.oldestOpen([tipo], limite);
    if (!t) continue;
    s.travadas[tipo] = t.total;
    const minutos = Math.floor((now.getTime() - t.criadaEm.getTime()) / 60_000);
    s.alertas[`travada:${tipo}`] = await alertar(deps, alertaTravada({ tipo: t.type, total: t.total, minutos, excecaoId: t.id }), { consoleUrl });
  }

  const keyCreated = await repo.config.get<string | null>("ODOO_API_KEY_CREATED_AT");
  if (keyCreated) {
    s.apiKeyDays = apiKeyAgeDays(keyCreated, now);
    if (s.apiKeyDays >= API_KEY_WARN_DAYS) {
      const exc = await repo.exceptions.openOnce({ type: "api_key_expiring", refTable: "app_config", detail: { createdAt: keyCreated, ageDays: s.apiKeyDays } });
      s.alertas.api_key_expiring = await alertar(deps, alertaChaveVencendo({ ageDays: s.apiKeyDays, excecaoId: exc.id }), { consoleUrl });
    }
  }
  s.ok = true;
  await repo.config.set("WATCHDOG_LAST", s);
  return s;
}
