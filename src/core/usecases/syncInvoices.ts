// Varredura de segurança da ida (15 em 15 min): pagina por (write_date, id) e avança o watermark página a página.
// Falha permanente numa fatura NÃO segura o watermark (a exceção rastreia); erro transiente aborta e re-tenta no próximo tick.
import { ODOO_PAGE_SIZE, SWEEP_MAX_PAGES } from "../limits.js";
import type { Deps } from "../ports.js";
import { handleInvoice } from "./handleInvoice.js";

export interface SyncSummary { at: string; ok: boolean; enabled: boolean; pages: number; invoices: number; created: number; cancelled: number; blocked: number; failed: number; busy: number; watermark: { writeDate: string; id: number } | null }

export async function syncInvoices(deps: Deps): Promise<SyncSummary> {
  const { repo, odoo, clock, log } = deps;
  const enabled = (await repo.config.get<boolean>("IDA_ENABLED")) === true;
  let watermark = await repo.watermarks.get("invoices");
  const s: SyncSummary = { at: clock.now().toISOString(), ok: true, enabled, pages: 0, invoices: 0, created: 0, cancelled: 0, blocked: 0, failed: 0, busy: 0, watermark };
  if (!enabled) { await repo.config.set("SYNC_LAST", s); return s; }   // a varredura também cancela/detecta; com a ida desligada, ela não roda

  const cutoff = await repo.config.get<string | null>("GO_LIVE_CUTOFF_DATE");
  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    const invoices = await odoo.searchInvoices({ after: watermark, invoiceDateFrom: cutoff, limit: ODOO_PAGE_SIZE });
    if (invoices.length === 0) break;
    s.pages++; s.invoices += invoices.length;
    for (const inv of invoices) {
      const o = await handleInvoice(deps, inv);
      s.created += o.created; s.cancelled += o.cancelled; s.blocked += o.blocked; s.failed += o.failed; if (o.busy) s.busy++;
    }
    const last = invoices[invoices.length - 1]!;
    watermark = { writeDate: last.writeDate, id: last.id };
    await repo.watermarks.set("invoices", watermark);   // a página inteira foi processada (erro transiente teria lançado antes)
    if (invoices.length < ODOO_PAGE_SIZE) break;
  }
  s.watermark = watermark;
  await repo.config.set("SYNC_LAST", s);
  log("sync-invoices", { ...s });
  return s;
}
