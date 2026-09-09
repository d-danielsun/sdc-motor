// Push da ida: o evento só traz o id; a fatura é relida no Odoo (gatilho, não fonte de verdade).
import type { Deps } from "../ports.js";
import { isTransient } from "../ports.js";
import { handleInvoice } from "./handleInvoice.js";
import { backoff } from "./retry.js";

export async function processOdooEvents(deps: Deps, o: { limit?: number } = {}): Promise<{ done: number; ignored: number; errors: number }> {
  const { repo, odoo, clock } = deps;
  const out = { done: 0, ignored: 0, errors: 0 };
  for (const ev of await repo.odooEvents.pending(o.limit ?? 50, clock.now())) {
    try {
      if (ev.odooModel !== "account.move") { await repo.odooEvents.mark(ev.id, "ignored"); out.ignored++; continue; }
      const inv = await odoo.getInvoice(ev.odooId);
      if (!inv || inv.moveType !== "out_invoice") { await repo.odooEvents.mark(ev.id, "ignored"); out.ignored++; continue; }
      await handleInvoice(deps, inv);
      await repo.odooEvents.mark(ev.id, "done");
      out.done++;
    } catch (e) {
      const attempts = ev.attempts + 1;
      const next = isTransient(e) ? backoff(attempts, clock.now()) : null;
      if (next) await repo.odooEvents.mark(ev.id, "pending", { attempts, nextAttemptAt: next, error: (e as Error).message });
      else {
        await repo.odooEvents.mark(ev.id, "error", { attempts, error: (e as Error).message });
        await repo.exceptions.open({ type: "charge_create_failed", refTable: "odoo_events", refId: ev.id, detail: { odooId: ev.odooId, error: (e as Error).message } });
        out.errors++;
      }
    }
  }
  return out;
}
