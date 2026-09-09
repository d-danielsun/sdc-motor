import { serve } from "@hono/node-server";
import { startScheduler } from "./scheduler.js";
import { createConsoleApi } from "./console.js";
import { createServer } from "./server.js";
import { buildDeps, jsonLog, readEnv } from "./wiring.js";

const env = readEnv();
const { deps, queries, close } = buildDeps(env);
const app = createServer({ repo: deps.repo, asaasWebhookToken: env.ASAAS_WEBHOOK_TOKEN, odooWebhookKey: env.ODOO_WEBHOOK_KEY, log: jsonLog, console: createConsoleApi({ deps, queries, token: env.CONSOLE_TOKEN }) });
const stop = startScheduler(deps);
const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => jsonLog("motor no ar", { port: info.port }));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => { stop(); server.close(); void close().then(() => process.exit(0)); });
}
