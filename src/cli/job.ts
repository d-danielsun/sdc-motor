// Roda um job uma vez e sai. Uso: npm run job -- reconcile-daily
import { JOBS, type JobName } from "../app/scheduler.js";
import { buildDeps, jsonLog, readEnv } from "../app/wiring.js";

const name = process.argv[2] as JobName | undefined;
if (!name || !(name in JOBS)) { console.error(`uso: job <${Object.keys(JOBS).join("|")}>`); process.exit(2); }
const { deps, close } = buildDeps(readEnv());
JOBS[name](deps).then((r) => { jsonLog(`job ${name}`, { result: r }); return close(); }).catch(async (e) => { console.error(e); await close(); process.exit(1); });
