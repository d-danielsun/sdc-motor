// Roda um job uma vez e sai. Uso: npm run job -- reconcile-daily | register-asaas-webhook | console-user
import { ASAAS_EVENTS } from "../adapters/asaas/client.js";
import { createAuthStore } from "../adapters/db/auth.js";
import { assertMigrated } from "../adapters/db/migrations.js";
import { SenhaInvalida, assertSenhaAceitavel, gerarSenha, hashPassword, isEmail, normalizeEmail } from "../core/auth.js";
import { JOBS, runJob, type JobName } from "../app/scheduler.js";
import { buildDeps, jsonLog, readEnv } from "../app/wiring.js";

/** --chave valor | --flag → { chave: valor, flag: "" } */
function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const prox = argv[i + 1];
    out[a.slice(2)] = prox && !prox.startsWith("--") ? (i++, prox) : "";
  }
  return out;
}

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
} else if (name === "console-user") {
  // Usuário do console. A senha é gerada aqui e impressa UMA vez: o banco guarda só o hash
  // scrypt, então não há de onde relê-la depois — perdida, use --reset-password.
  const f = flags(process.argv.slice(3));
  const auth = createAuthStore(pool);
  const email = normalizeEmail(f.email ?? "");
  try {
    if (f.list !== undefined) {
      for (const u of await auth.listar()) console.log(`${u.active ? "ativo   " : "inativo "} ${u.email.padEnd(32)} ${u.name}  último login: ${u.lastLoginAt?.toISOString() ?? "nunca"}`);
    } else if (!email || !isEmail(email)) {
      console.error('uso: npm run job -- console-user --email <email> --name "<nome>" [--senha <senha>]');
      console.error("     npm run job -- console-user --email <email> --reset-password");
      console.error("     npm run job -- console-user --email <email> --deactivate | --activate");
      console.error("     npm run job -- console-user --list");
      exitCode = 2;
    } else if (f["deactivate"] !== undefined || f["activate"] !== undefined) {
      const ativar = f["activate"] !== undefined;
      const u = await auth.definirAtivo(email, ativar);
      if (!u) { console.error(`não existe usuário ${email}`); exitCode = 1; }
      else {
        // Desativar sem revogar deixaria a pessoa dentro até a sessão expirar.
        const revogadas = ativar ? 0 : await auth.revogarDoUsuario(u.id);
        jsonLog(ativar ? "usuário reativado" : "usuário desativado", { email, sessoesRevogadas: revogadas });
      }
    } else if (f["reset-password"] !== undefined) {
      const senha = f.senha || gerarSenha();
      assertSenhaAceitavel(senha);
      const u = await auth.definirSenha(email, await hashPassword(senha));
      if (!u) { console.error(`não existe usuário ${email}`); exitCode = 1; }
      else {
        const revogadas = await auth.revogarDoUsuario(u.id);   // trocar senha derruba o que estava aberto
        console.log(`\nsenha nova de ${email}:\n\n    ${senha}\n\nguarde agora — ela não é recuperável. sessões revogadas: ${revogadas}\n`);
      }
    } else {
      const nome = (f.name ?? "").trim();
      if (!nome) { console.error('--name "<nome>" é obrigatório ao criar'); exitCode = 2; }
      else {
        const senha = f.senha || gerarSenha();
        assertSenhaAceitavel(senha);
        const u = await auth.criarOuAtualizar({ email, name: nome, passwordHash: await hashPassword(senha) });
        console.log(`\nusuário ${u.email} (${u.name}) pronto. senha:\n\n    ${senha}\n\nguarde agora — o banco só tem o hash. entre em /console/\n`);
      }
    }
  } catch (e) {
    console.error(e instanceof SenhaInvalida ? `senha recusada: ${e.message}` : `console-user falhou: ${(e as Error).message || String(e)}`);
    exitCode = 1;
  }
} else if (name && name in JOBS) {
  exitCode = (await runJob(deps, name as JobName)) === null ? 1 : 0;
} else {
  console.error(`uso: job <${[...Object.keys(JOBS), "register-asaas-webhook", "console-user"].join("|")}>`);
  exitCode = 2;
}
await close();
process.exit(exitCode);
