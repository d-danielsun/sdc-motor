import { serve } from "@hono/node-server";
import { createAuthStore } from "../adapters/db/auth.js";
import { assertLeitura, assertMigrated } from "../adapters/db/migrations.js";
import { createConsoleApi } from "./console.js";
import { createJobRunner, startScheduler } from "./scheduler.js";
import { createServer } from "./server.js";
import { buildDeps, jsonLog, readEnv } from "./wiring.js";

const env = readEnv();
for (const w of env.warnings) jsonLog("aviso de configuração", { warning: w });
const { deps, queries, pool, close } = buildDeps(env);
await assertMigrated(pool).catch((e) => { console.error(String((e as Error).message)); process.exit(1); });
// Depois das migrations, e antes de qualquer coisa: o motor consegue LER? Ver assertLeitura.
await assertLeitura(pool, (m) => jsonLog("aviso de leitura", { warning: m })).catch((e) => { console.error(String((e as Error).message)); process.exit(1); });
// O link do e-mail de alerta mora em app_config (o núcleo não lê env). Semeado no boot para
// que trocar o endereço público seja mudar o env e reiniciar.
if (env.CONSOLE_PUBLIC_URL) await deps.repo.config.set("CONSOLE_PUBLIC_URL", env.CONSOLE_PUBLIC_URL).catch(() => undefined);
// Sem esta data o watchdog não tem como saber a idade da chave, e o alerta de vencimento nunca
// dispara. Semeada do ambiente para que trocar a chave seja trocar env + reiniciar.
if (env.ODOO_API_KEY_CREATED_AT && !Number.isNaN(new Date(env.ODOO_API_KEY_CREATED_AT).getTime())) {
  await deps.repo.config.set("ODOO_API_KEY_CREATED_AT", new Date(env.ODOO_API_KEY_CREATED_AT).toISOString()).catch(() => undefined);
}
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
const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => jsonLog("motor no ar", { port: info.port, cronToken: env.CONSOLE_TOKEN !== null }));
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
