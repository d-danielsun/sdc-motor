// Read model do console em SQL. Só leitura; nada aqui muda estado. Todo valor entra como parâmetro ligado.
import type pg from "pg";
import { OPEN_STATUSES } from "../../core/charges.js";
import type { AgingBucket, ChargeFilter, ChargeRow, ConsoleQueries, EventRow, ExceptionFilter, ExceptionRow, Page, ReconciliationRow } from "../../core/console.js";
import type { ChargeStatus, ExceptionType } from "../../core/types.js";

type Row = Record<string, unknown>;
const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

const EXC_SELECT = `select e.id, e.type, e.status, e.ref_table, e.ref_id, e.detail, e.created_at, e.resolved_by, e.resolved_at,
  c.id as c_id, c.invoice_name as c_invoice, c.amount as c_amount, c.due_date as c_due, c.status as c_status, cm.name as c_customer
  from exceptions e
  left join charges c on e.ref_table='charges' and c.id=e.ref_id
  left join customers_map cm on cm.odoo_partner_id=c.odoo_partner_id`;
const excRow = (r: Row): ExceptionRow => ({
  id: Number(r.id), type: r.type as ExceptionType, status: r.status as ExceptionRow["status"], refTable: (r.ref_table as string) ?? null,
  refId: numOrNull(r.ref_id), detail: r.detail, createdAt: iso(r.created_at)!, resolvedBy: (r.resolved_by as string) ?? null, resolvedAt: iso(r.resolved_at),
  charge: r.c_id === null ? null : { id: Number(r.c_id), invoiceName: (r.c_invoice as string) ?? null, amount: String(r.c_amount), dueDate: String(r.c_due), status: r.c_status as ChargeStatus, customerName: (r.c_customer as string) ?? null },
});

const CHARGE_SELECT = `select c.*, cm.name as cust_name, cm.cpf_cnpj as cust_doc, cm.asaas_customer_id as cust_asaas,
  r.amount_received as r_amount, r.payment_date as r_date, r.diff_policy as r_policy, r.odoo_payment_id as r_odoo,
  (select count(*) from exceptions x where x.status='open' and x.ref_table='charges' and x.ref_id=c.id)::int as open_exc
  from charges c
  left join customers_map cm on cm.odoo_partner_id=c.odoo_partner_id
  left join lateral (select * from reconciliations rr where rr.charge_id=c.id order by rr.created_at desc limit 1) r on true`;
const chargeRow = (r: Row): ChargeRow => ({
  id: Number(r.id), invoiceName: (r.invoice_name as string) ?? null, odooMoveId: Number(r.odoo_move_id), odooMoveLineId: Number(r.odoo_move_line_id),
  status: r.status as ChargeStatus, amount: String(r.amount), dueDate: String(r.due_date), asaasPaymentId: (r.asaas_payment_id as string) ?? null,
  bankSlipUrl: (r.bank_slip_url as string) ?? null, nossoNumero: (r.nosso_numero as string) ?? null, asaasInvoiceNumber: (r.asaas_invoice_number as string) ?? null,
  customer: { odooPartnerId: Number(r.odoo_partner_id), name: (r.cust_name as string) ?? null, cpfCnpj: (r.cust_doc as string) ?? null, asaasCustomerId: (r.cust_asaas as string) ?? null },
  received: r.r_amount === null || r.r_amount === undefined ? null : { amountReceived: String(r.r_amount), paymentDate: (r.r_date as string) ?? null, diffPolicy: (r.r_policy as string) ?? null, odooPaymentId: numOrNull(r.r_odoo) },
  openExceptions: Number(r.open_exc ?? 0), createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
});
const reconRow = (r: Row): ReconciliationRow => ({ id: Number(r.id), odooPaymentId: numOrNull(r.odoo_payment_id), amountReceived: String(r.amount_received), amountExpected: String(r.amount_expected), netValue: r.net_value === null ? null : String(r.net_value), diff: String(r.diff), diffPolicy: (r.diff_policy as string) ?? null, paymentDate: (r.payment_date as string) ?? null, creditDate: (r.credit_date as string) ?? null, createdAt: iso(r.created_at)! });
const eventRow = (r: Row): EventRow => ({ id: Number(r.id), asaasEventId: String(r.asaas_event_id), eventType: String(r.event_type), processStatus: String(r.process_status), receivedAt: iso(r.received_at)!, processedAt: iso(r.processed_at), attempts: Number(r.attempts), error: (r.error as string) ?? null });

export function createConsoleQueries(db: { query: pg.Pool["query"] }): ConsoleQueries {
  const page = <T>(rows: Row[], total: number, limit: number, offset: number, map: (r: Row) => T): Page<T> => ({ data: rows.map(map), total, limit, offset });
  const clamp = (n: number | undefined, d: number, max: number) => (Number.isSafeInteger(n) ? Math.min(Math.max(n as number, 1), max) : d);
  const off = (n: number | undefined) => (Number.isSafeInteger(n) && (n as number) >= 0 ? (n as number) : 0);

  return {
    async exceptions(f: ExceptionFilter) {
      const limit = clamp(f.limit, 50, 200), offset = off(f.offset);
      const where: string[] = [], params: unknown[] = [];
      if (f.status) { params.push(f.status); where.push(`e.status=$${params.length}`); }
      if (f.type) { params.push(f.type); where.push(`e.type=$${params.length}`); }
      const w = where.length ? `where ${where.join(" and ")}` : "";
      const total = Number((await db.query(`select count(*)::int as n from exceptions e ${w}`, params)).rows[0]?.n ?? 0);
      const rows = (await db.query(`${EXC_SELECT} ${w} order by e.status='open' desc, e.created_at desc limit $${params.length + 1} offset $${params.length + 2}`, [...params, limit, offset])).rows as Row[];
      return page(rows, total, limit, offset, excRow);
    },
    async exception(id: number) {
      const r = (await db.query(`${EXC_SELECT} where e.id=$1`, [id])).rows[0] as Row | undefined;
      return r ? excRow(r) : null;
    },
    async charges(f: ChargeFilter) {
      const limit = clamp(f.limit, 50, 200), offset = off(f.offset);
      const where: string[] = [], params: unknown[] = [];
      if (f.status?.length) { params.push(f.status); where.push(`c.status = any($${params.length}::text[])`); }
      if (f.dueFrom) { params.push(f.dueFrom); where.push(`c.due_date >= $${params.length}::date`); }
      if (f.dueTo) { params.push(f.dueTo); where.push(`c.due_date <= $${params.length}::date`); }
      if (f.partnerId) { params.push(f.partnerId); where.push(`c.odoo_partner_id = $${params.length}`); }
      if (f.q) { params.push(`%${escapeLike(f.q)}%`); where.push(`(c.invoice_name ilike $${params.length} or cm.name ilike $${params.length} or c.nosso_numero ilike $${params.length} or c.asaas_payment_id ilike $${params.length})`); }
      // `total` é contado com os MESMOS filtros, mas sem o corte do keyset: quem pagina quer
      // saber o tamanho do conjunto, não quantos faltam.
      const w = where.length ? `where ${where.join(" and ")}` : "";
      const total = Number((await db.query(`select count(*)::int as n from charges c left join customers_map cm on cm.odoo_partner_id=c.odoo_partner_id ${w}`, params)).rows[0]?.n ?? 0);
      if (f.after) {
        // (due_date, id) > (data, id): comparação de tupla, que o índice (due_date, id) da 0004
        // atende direto. Sem repetir linha e sem custo crescente por página.
        const p = [...params, f.after.dueDate, f.after.id];
        const corte = `(c.due_date, c.id) > ($${p.length - 1}::date, $${p.length})`;
        const rows = (await db.query(`${CHARGE_SELECT} ${where.length ? `where ${where.join(" and ")} and ${corte}` : `where ${corte}`} order by c.due_date asc, c.id asc limit $${p.length + 1}`, [...p, limit])).rows as Row[];
        return page(rows, total, limit, 0, chargeRow);   // `offset: 0` no modo keyset: não há deslocamento, o corte é o cursor
      }
      const rows = (await db.query(`${CHARGE_SELECT} ${w} order by c.due_date asc, c.id asc limit $${params.length + 1} offset $${params.length + 2}`, [...params, limit, offset])).rows as Row[];
      return page(rows, total, limit, offset, chargeRow);
    },
    async charge(id: number) {
      const r = (await db.query(`${CHARGE_SELECT} where c.id=$1`, [id])).rows[0] as Row | undefined;
      if (!r) return null;
      const base = chargeRow(r);
      const reconciliations = ((await db.query("select * from reconciliations where charge_id=$1 order by created_at", [id])).rows as Row[]).map(reconRow);
      const exceptions = ((await db.query(`${EXC_SELECT} where e.ref_table='charges' and e.ref_id=$1 order by e.created_at desc`, [id])).rows as Row[]).map(excRow);
      const events = base.asaasPaymentId ? ((await db.query("select id, asaas_event_id, event_type, process_status, received_at, processed_at, attempts, error from webhook_events where asaas_payment_id=$1 order by received_at", [base.asaasPaymentId])).rows as Row[]).map(eventRow) : [];
      return { ...base, reconciliations, exceptions, events };
    },
    async aging(today: string) {
      const rows = (await db.query(`select case when due_date >= $1::date then 'a_vencer' when $1::date - due_date <= 7 then '1_7' when $1::date - due_date <= 30 then '8_30' else '31_mais' end as bucket,
        count(*)::int as count, coalesce(sum(amount),0)::text as amount from charges where status = any($2::text[]) group by 1`, [today, [...OPEN_STATUSES]])).rows as Row[];
      const order: AgingBucket["bucket"][] = ["a_vencer", "1_7", "8_30", "31_mais"];
      return order.map((b) => { const r = rows.find((x) => x.bucket === b); return { bucket: b, count: Number(r?.count ?? 0), amount: String(r?.amount ?? "0.00") }; });
    },
    async lastOdooEventAt() { return iso((await db.query("select max(received_at) as t from odoo_events")).rows[0]?.t); },
  };
}
