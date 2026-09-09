// Varredura de segurança da ida (15 em 15 min). O watermark só avança se o lote inteiro passou.
import type { Deps } from "../ports.js";
import { handleInvoice, type InvoiceOutcome } from "./handleInvoice.js";

export interface SyncSummary { enabled: boolean; invoices: number; created: number; cancelled: number; failed: number; watermark: string | null }

export async function syncInvoices(deps: Deps): Promise<SyncSummary> {
  const { repo, odoo, log } = deps;
  const enabled = (await repo.config.get<boolean>("IDA_ENABLED")) === true;
  const watermark = await repo.watermarks.get("invoices");
  const summary: SyncSummary = { enabled, invoices: 0, created: 0, cancelled: 0, failed: 0, watermark };
  if (!enabled) return summary;

  const cutoff = await repo.config.get<string | null>("GO_LIVE_CUTOFF_DATE");
  const invoices = await odoo.searchInvoices({ writeDateAfter: watermark, invoiceDateFrom: cutoff });
  summary.invoices = invoices.length;
  let maxWrite = watermark;
  for (const inv of invoices) {
    const o: InvoiceOutcome = await handleInvoice(deps, inv);
    summary.created += o.created; summary.cancelled += o.cancelled; summary.failed += o.failed;
    if (!maxWrite || inv.writeDate > maxWrite) maxWrite = inv.writeDate;
  }
  if (summary.failed === 0 && maxWrite && maxWrite !== watermark) {
    await repo.watermarks.set("invoices", maxWrite);
    summary.watermark = maxWrite;
  }
  await repo.config.set("SYNC_LAST", { at: deps.clock.now().toISOString(), ...summary });
  log("sync-invoices", { ...summary });
  return summary;
}
