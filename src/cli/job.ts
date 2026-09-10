// Roda um job uma vez e sai. Uso: npm run job -- reconcile-daily | register-asaas-webhook
import { ASAAS_EVENTS } from "../adapters/asaas/client.js";
import { assertMigrated } from "../adapters/db/migrations.js";
import { JOBS, runJob, type JobName } from "../app/scheduler.js";
import { buildDeps, jsonLog, readEnv } from "../app/wiring.js";

const name = process.argv[2];
const env = readEnv();
const { deps, pool, close } = buildDeps(env);
await assertMigrated(pool).catch((e) => { console.error(String((e as Error).message)); process.exit(1); });

let exitCode = 0;
if (name === "register-asaas-webhook") {
  // Uma vez por ambiente: cria o webhook no Asaas apontando pro endpoint público e guarda o id em app_config.
  const url = process.env.WEBHOOK_PUBLIC_URL, email = process.env.ALERT_EMAIL;
  if (!url || !email) { console.error("uso: WEBHOOK_PUBLIC_URL=https://…/webhook-asaas ALERT_EMAIL=… npm run job -- register-asaas-webhook"); exitCode = 2; }
  else {
    const existing = await deps.repo.config.get<string | null>("ASAAS_WEBHOOK_ID");
    if (existing && (await deps.asaas.getWebhook(existing))) jsonLog("webhook já registrado", { id: existing });
    else {
      const wh = await deps.asaas.createWebhook({ name: "Salvei motor de cobrança", url, email, authToken: env.ASAAS_WEBHOOK_TOKEN, events: [...ASAAS_EVENTS] });
      await deps.repo.config.set("ASAAS_WEBHOOK_ID", wh.id);
      jsonLog("webhook registrado", { id: wh.id, url: wh.url, events: wh.events.length });
    }
  }
} else if (name && name in JOBS) {
  exitCode = (await runJob(deps, name as JobName)) === null ? 1 : 0;
} else {
  console.error(`uso: job <${[...Object.keys(JOBS), "register-asaas-webhook"].join("|")}>`);
  exitCode = 2;
}
await close();
process.exit(exitCode);
