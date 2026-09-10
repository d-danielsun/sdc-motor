import { serve } from "@hono/node-server";
import { createAuthStore } from "../adapters/db/auth.js";
import { assertMigrated } from "../adapters/db/migrations.js";
import { createConsoleApi } from "./console.js";
import { createJobRunner, startScheduler } from "./scheduler.js";
import { createServer } from "./server.js";
import { buildDeps, jsonLog, readEnv } from "./wiring.js";

const env = readEnv();
for (const w of env.warnings) jsonLog("aviso de configuração", { warning: w });
const { deps, queries, pool, close } = buildDeps(env);
await assertMigrated(pool).catch((e) => { console.error(String((e as Error).message)); process.exit(1); });
const auth = createAuthStore(pool);
const jobs = createJobRunner(deps, { purgarSessoes: (agora) => auth.purgarExpiradas(agora) });
const app = createServer({
  repo: deps.repo, asaasWebhookToken: env.ASAAS_WEBHOOK_TOKEN, odooWebhookKey: env.ODOO_WEBHOOK_KEY, log: jsonLog,
  console: createConsoleApi({
    deps, queries, token: env.CONSOLE_TOKEN, jobs, auth,
    proxiesConfiaveis: env.TRUSTED_PROXIES,
    // Fora de produção o cookie pode sair sem `Secure` em loopback, senão não há como logar
    // em http://localhost. O Dockerfile define NODE_ENV=production, então na imagem não vale.
    permitirCookieInseguro: process.env.NODE_ENV !== "production",
  }),
  staticRoot: "./public",
});
const scheduler = startScheduler(deps, { runner: jobs });
const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => jsonLog("motor no ar", { port: info.port, console: env.CONSOLE_TOKEN !== null }));
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    jsonLog("parando", { signal: sig, inFlight: scheduler.inFlight() });
    server.close();
    void scheduler.stop().then(close).then(() => process.exit(0));   // espera jobs no meio de uma escrita financeira
    setTimeout(() => process.exit(1), 60_000).unref();
  });
}
