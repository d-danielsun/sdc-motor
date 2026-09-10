// Varredura de segurança da ida (15 em 15 min). Pagina por (segundo de write_date, id) — o Odoo devolve write_date
// truncado a segundos, então o segundo é um balde: página cheia num só segundo é drenada por id. Falha permanente numa
// fatura NÃO segura o watermark (a exceção rastreia); erro transiente aborta e re-tenta — mas a mesma fatura falhando
// N ticks seguidos vira exceção com o id e a varredura segue (red team: uma fatura ruim não congela a rede de segurança).
import { ODOO_PAGE_SIZE, SWEEP_FAILURES_BEFORE_SKIP, SWEEP_MAX_PAGES } from "../limits.js";
import type { Deps } from "../ports.js";
import { isTransient } from "../ports.js";
import type { OdooInvoice } from "../types.js";
import { handleInvoice, type InvoiceOutcome } from "./handleInvoice.js";

export interface SyncSummary { at: string; ok: boolean; enabled: boolean; pages: number; invoices: number; created: number; cancelled: number; blocked: number; failed: number; busy: number; skippedBad: number; watermark: { writeDate: string; id: number } | null }
export const secondOf = (iso: string): string => `${iso.slice(0, 19)}.000Z`;

export async function syncInvoices(deps: Deps, o: { pageSize?: number } = {}): Promise<SyncSummary> {
  const { repo, odoo, clock, log } = deps;
  const pageSize = o.pageSize ?? ODOO_PAGE_SIZE;
  const enabled = (await repo.config.get<boolean>("IDA_ENABLED")) === true;
  let wm = await repo.watermarks.get("invoices");
  const s: SyncSummary = { at: clock.now().toISOString(), ok: true, enabled, pages: 0, invoices: 0, created: 0, cancelled: 0, blocked: 0, failed: 0, busy: 0, skippedBad: 0, watermark: wm };
  if (!enabled) { await repo.config.set("SYNC_LAST", s); return s; }
  const cutoff = await repo.config.get<string | null>("GO_LIVE_CUTOFF_DATE");
  const failures = (await repo.config.get<Record<string, number>>("SWEEP_FAILURES")) ?? {};

  const handle = async (inv: OdooInvoice): Promise<InvoiceOutcome | null> => {
    try {
      const out = await handleInvoice(deps, inv);
      if (failures[inv.id]) { delete failures[inv.id]; await repo.config.set("SWEEP_FAILURES", failures); }
      return out;
    } catch (e) {
      if (!isTransient(e)) throw e;
      const n = (failures[inv.id] ?? 0) + 1;
      failures[inv.id] = n;
      await repo.config.set("SWEEP_FAILURES", failures);
      if (n < SWEEP_FAILURES_BEFORE_SKIP) throw Object.assign(e as Error, { message: `${(e as Error).message} (fatura ${inv.name} #${inv.id}, tentativa ${n})` });
      await repo.exceptions.openOnce({ type: "charge_create_failed", refTable: "account.move", refId: inv.id, detail: { odooId: inv.id, invoice: inv.name, reason: `Odoo falhou ${n} varreduras seguidas nesta fatura — pulada até alguém reprocessar`, error: (e as Error).message } });
      s.skippedBad++;
      return null;
    }
  };
  const processAll = async (rows: OdooInvoice[]) => {
    const busy: OdooInvoice[] = [];
    for (const inv of rows) { const r = await handle(inv); if (r?.busy) busy.push(inv); else if (r) tally(r); }
    for (const inv of busy) { const r = await handle(inv); if (r?.busy) s.busy++; else if (r) tally(r); }   // 2ª chance: o outro dono já soltou
  };
  const tally = (r: InvoiceOutcome) => { s.created += r.created; s.cancelled += r.cancelled; s.blocked += r.blocked; s.failed += r.failed; };

  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    let rows = await odoo.searchInvoices({ after: wm, invoiceDateFrom: cutoff, limit: pageSize });
    if (rows.length === 0) break;
    s.pages++;
    const lastSec = secondOf(rows[rows.length - 1]!.writeDate);
    if (rows.length >= pageSize) {
      const keep = rows.filter((r) => secondOf(r.writeDate) !== lastSec);   // o último segundo pode estar cortado: fica pra próxima página
      if (keep.length === 0) {
        // página inteira num só segundo (confirmação em lote): drena o balde por id
        let maxId = 0;
        while (rows.length > 0) {
          s.invoices += rows.length; await processAll(rows);
          maxId = Math.max(maxId, ...rows.map((r) => r.id));
          wm = { writeDate: lastSec, id: maxId }; await repo.watermarks.set("invoices", wm);
          if (rows.length < pageSize) break;
          rows = await odoo.searchInvoicesInSecond({ second: lastSec, afterId: maxId, invoiceDateFrom: cutoff, limit: pageSize });
          if (rows.length) s.pages++;
        }
        continue;
      }
      rows = keep;
    }
    s.invoices += rows.length; await processAll(rows);
    const lastKeptSec = secondOf(rows[rows.length - 1]!.writeDate);
    wm = { writeDate: lastKeptSec, id: Math.max(...rows.filter((r) => secondOf(r.writeDate) === lastKeptSec).map((r) => r.id)) };
    await repo.watermarks.set("invoices", wm);   // a página inteira foi processada (erro transiente teria lançado antes)
    if (rows.length < pageSize) break;
  }
  s.watermark = wm;
  await repo.config.set("SYNC_LAST", s);
  log("sync-invoices", { ...s });
  return s;
}
