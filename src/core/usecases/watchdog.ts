// Fila do Asaas interrompida, penalidades subindo, silêncio suspeito, key do Odoo perto de vencer.
import type { Deps } from "../ports.js";

export interface WatchdogSummary { interrupted: boolean; reactivated: boolean; penalizedDelta: number; staleHeartbeat: boolean; apiKeyDays: number | null }

const HOUR = 3_600_000;

export function isBusinessHoursBrt(now: Date): boolean {
  const brt = new Date(now.getTime() - 3 * HOUR); // America/Sao_Paulo sem DST desde 2019
  const dow = brt.getUTCDay(), h = brt.getUTCHours();
  return dow >= 1 && dow <= 5 && h >= 8 && h < 20;
}

export async function watchdog(deps: Deps): Promise<WatchdogSummary> {
  const { repo, asaas, clock } = deps;
  const now = clock.now();
  const s: WatchdogSummary = { interrupted: false, reactivated: false, penalizedDelta: 0, staleHeartbeat: false, apiKeyDays: null };

  const webhookId = await repo.config.get<string | null>("ASAAS_WEBHOOK_ID");
  const wh = webhookId ? await asaas.getWebhook(webhookId) : null;
  if (wh) {
    if (wh.interrupted) {
      s.interrupted = true;
      if (!(await repo.exceptions.hasOpen("queue_interrupted", "asaas_webhooks"))) {
        await repo.exceptions.open({ type: "queue_interrupted", refTable: "asaas_webhooks", detail: { webhookId: wh.id, penalizedRequestsCount: wh.penalizedRequestsCount } });
      }
      const last = await repo.config.get<string | null>("ASAAS_REACTIVATED_AT");
      if (!last || now.getTime() - new Date(last).getTime() >= HOUR) {
        await asaas.updateWebhook(wh.id, { interrupted: false });
        await repo.config.set("ASAAS_REACTIVATED_AT", now.toISOString());
        s.reactivated = true;
      }
    }
    const lastPenalized = (await repo.config.get<number>("ASAAS_PENALIZED_LAST")) ?? 0;
    s.penalizedDelta = wh.penalizedRequestsCount - lastPenalized;
    if (s.penalizedDelta > 0) {
      await repo.exceptions.open({ type: "webhook_penalized", refTable: "asaas_webhooks", detail: { webhookId: wh.id, from: lastPenalized, to: wh.penalizedRequestsCount } });
    }
    if (wh.penalizedRequestsCount !== lastPenalized) await repo.config.set("ASAAS_PENALIZED_LAST", wh.penalizedRequestsCount);
  }

  if (isBusinessHoursBrt(now) && (await repo.charges.countOpen()) > 0) {
    const last = await repo.asaasEvents.lastReceivedAt();
    if (!last || now.getTime() - last.getTime() > 8 * HOUR) {
      s.staleHeartbeat = true;
      if (!(await repo.exceptions.hasOpen("stale_heartbeat", "webhook_events"))) {
        await repo.exceptions.open({ type: "stale_heartbeat", refTable: "webhook_events", detail: { lastReceivedAt: last?.toISOString() ?? null } });
      }
    }
  }

  const keyCreated = await repo.config.get<string | null>("ODOO_API_KEY_CREATED_AT");
  if (keyCreated) {
    s.apiKeyDays = Math.floor((now.getTime() - new Date(keyCreated).getTime()) / (24 * HOUR));
    if (s.apiKeyDays >= 75 && !(await repo.exceptions.hasOpen("api_key_expiring", "app_config"))) {
      await repo.exceptions.open({ type: "api_key_expiring", refTable: "app_config", detail: { createdAt: keyCreated, ageDays: s.apiKeyDays } });
    }
  }
  await repo.config.set("WATCHDOG_LAST", { at: now.toISOString(), ...s });
  return s;
}
