// Push da ida: o evento só traz o id; a fatura é relida no Odoo (gatilho, não fonte de verdade).
import { ODOO_EVENT_BATCH } from "../limits.js";
import type { Deps } from "../ports.js";
import { isTransient } from "../ports.js";
import { handleInvoice } from "./handleInvoice.js";
import { backoff } from "./retry.js";

export async function processOdooEvents(deps: Deps, o: { limit?: number } = {}): Promise<{ done: number; ignored: number; errors: number }> {
  const { repo, odoo, clock } = deps;
  const out = { done: 0, ignored: 0, errors: 0 };
  const batch = await repo.odooEvents.pending(o.limit ?? ODOO_EVENT_BATCH, clock.now());
  const handled = new Set<number>();   // várias notificações da mesma fatura no lote → relê uma vez
  for (const ev of batch) {
    const posse = { claimToken: ev.claimToken };
    await repo.odooEvents.touch(ev.id, clock.now(), ev.claimToken);
    try {
      if (ev.odooModel !== "account.move") { await repo.odooEvents.mark(ev.id, "ignored", posse); out.ignored++; continue; }
      if (!handled.has(ev.odooId)) {
        const inv = await odoo.getInvoice(ev.odooId);
        if (!inv || inv.moveType !== "out_invoice") { await repo.odooEvents.mark(ev.id, "ignored", posse); out.ignored++; continue; }
        const o = await handleInvoice(deps, inv);
        if (o.busy) throw Object.assign(new Error("fatura em uso por outra execução"), { transient: true });   // volta pra fila com backoff
        handled.add(ev.odooId);
      }
      const meu = await repo.odooEvents.mark(ev.id, "done", posse);
      if (!meu) { deps.log("reserva perdida: não sobrescrevi o resultado do outro worker", { odooId: ev.odooId }); continue; }
      out.done++;
    } catch (e) {
      const attempts = ev.attempts + 1;
      const next = isTransient(e) ? backoff(attempts, clock.now()) : null;
      if (next) await repo.odooEvents.mark(ev.id, "pending", { attempts, nextAttemptAt: next, error: (e as Error).message, ...posse });
      else {
        await repo.odooEvents.mark(ev.id, "error", { attempts, error: (e as Error).message, ...posse });
        await repo.exceptions.openOnce({ type: "charge_create_failed", refTable: "odoo_events", refId: ev.id, detail: { odooId: ev.odooId, reason: isTransient(e) ? "retries esgotados" : "erro definitivo", error: (e as Error).message } });
        out.errors++;
      }
    }
  }
  return out;
}
