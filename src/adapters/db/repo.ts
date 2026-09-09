// Repositório Postgres (pg). SQL explícito; sem ORM — o mesmo arquivo vale pra Supabase e pra qualquer Postgres.
import type pg from "pg";
import type { Repo } from "../../core/ports.js";
import type { Charge, ChargeStatus, CustomerMap, ExceptionType, ProcessStatus, StoredAsaasEvent, StoredOdooEvent } from "../../core/types.js";

type Q = { query: pg.Pool["query"] };
type Row = Record<string, unknown>;

const chargeRow = (r: Row): Charge => ({
  id: Number(r.id), odooMoveId: Number(r.odoo_move_id), odooMoveLineId: Number(r.odoo_move_line_id), odooPartnerId: Number(r.odoo_partner_id),
  asaasPaymentId: (r.asaas_payment_id as string) ?? null, externalRef: String(r.external_ref), amount: String(r.amount), dueDate: String(r.due_date),
  status: r.status as ChargeStatus, bankSlipUrl: (r.bank_slip_url as string) ?? null, invoiceName: (r.invoice_name as string) ?? null,
  nossoNumero: (r.nosso_numero as string) ?? null, asaasInvoiceNumber: (r.asaas_invoice_number as string) ?? null,
});
const customerRow = (r: Row): CustomerMap => ({
  id: Number(r.id), odooPartnerId: Number(r.odoo_partner_id), asaasCustomerId: (r.asaas_customer_id as string) ?? null, cpfCnpj: (r.cpf_cnpj as string) ?? null,
  name: String(r.name), email: (r.email as string) ?? null, phone: (r.phone as string) ?? null, syncStatus: r.sync_status as CustomerMap["syncStatus"], lastError: (r.last_error as string) ?? null,
});

const markSql = (table: string) => `update ${table} set process_status=$2, processed_at=case when $2 in ('done','error','ignored') then now() else processed_at end,
  error=coalesce($3, error), attempts=coalesce($4, attempts), next_attempt_at=$5 where id=$1`;

export function createPgRepo(db: Q): Repo {
  const one = async <T = Row>(sql: string, params: unknown[] = []): Promise<T | null> => ((await db.query(sql, params)).rows[0] as T) ?? null;
  const all = async <T = Row>(sql: string, params: unknown[] = []): Promise<T[]> => (await db.query(sql, params)).rows as T[];

  return {
    config: {
      async get<T>(key: string) { const r = await one<{ value: T }>("select value from app_config where key=$1", [key]); return r ? r.value : null; },
      async set(key, value) { await db.query("insert into app_config (key, value) values ($1, $2::jsonb) on conflict (key) do update set value=excluded.value, updated_at=now()", [key, JSON.stringify(value)]); },
    },
    customers: {
      async getByPartner(id) { const r = await one("select * from customers_map where odoo_partner_id=$1", [id]); return r ? customerRow(r) : null; },
      async upsert(c) {
        const r = await one(`insert into customers_map (odoo_partner_id, asaas_customer_id, cpf_cnpj, name, email, phone, sync_status, last_error, synced_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8, case when $7='synced' then now() end)
          on conflict (odoo_partner_id) do update set asaas_customer_id=coalesce(excluded.asaas_customer_id, customers_map.asaas_customer_id), cpf_cnpj=excluded.cpf_cnpj, name=excluded.name,
            email=excluded.email, phone=excluded.phone, sync_status=excluded.sync_status, last_error=excluded.last_error, synced_at=coalesce(excluded.synced_at, customers_map.synced_at), updated_at=now()
          returning *`, [c.odooPartnerId, c.asaasCustomerId, c.cpfCnpj, c.name, c.email, c.phone, c.syncStatus, c.lastError]);
        return customerRow(r!);
      },
      async listSynced() { return (await all("select * from customers_map where sync_status='synced' and asaas_customer_id is not null order by id")).map(customerRow); },
    },
    charges: {
      async getByMoveLine(id) { const r = await one("select * from charges where odoo_move_line_id=$1", [id]); return r ? chargeRow(r) : null; },
      async getByExternalRef(ref) { const r = await one("select * from charges where external_ref=$1", [ref]); return r ? chargeRow(r) : null; },
      async getByAsaasPayment(id) { const r = await one("select * from charges where asaas_payment_id=$1", [id]); return r ? chargeRow(r) : null; },
      async listByMove(moveId) { return (await all("select * from charges where odoo_move_id=$1 order by due_date", [moveId])).map(chargeRow); },
      async insert(c) {
        const r = await one(`insert into charges (odoo_move_id, odoo_move_line_id, odoo_partner_id, asaas_payment_id, external_ref, amount, due_date, status, bank_slip_url, invoice_name, nosso_numero, asaas_invoice_number)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
          [c.odooMoveId, c.odooMoveLineId, c.odooPartnerId, c.asaasPaymentId, c.externalRef, c.amount, c.dueDate, c.status, c.bankSlipUrl, c.invoiceName, c.nossoNumero, c.asaasInvoiceNumber]);
        return chargeRow(r!);
      },
      async setStatus(id, status, patch = {}) {
        await db.query(`update charges set status=$2, asaas_payment_id=coalesce($3, asaas_payment_id), bank_slip_url=coalesce($4, bank_slip_url),
          nosso_numero=coalesce($5, nosso_numero), asaas_invoice_number=coalesce($6, asaas_invoice_number), updated_at=now() where id=$1`,
          [id, status, patch.asaasPaymentId ?? null, patch.bankSlipUrl ?? null, patch.nossoNumero ?? null, patch.asaasInvoiceNumber ?? null]);
      },
      async countOpen() { const r = await one<{ n: string }>("select count(*)::text as n from charges where status in ('created','confirmed')"); return Number(r?.n ?? 0); },
    },
    asaasEvents: {
      async insert(e) {
        const r = await db.query("insert into webhook_events (asaas_event_id, event_type, asaas_payment_id, payload) values ($1,$2,$3,$4::jsonb) on conflict (asaas_event_id) do nothing", [e.asaasEventId, e.eventType, e.asaasPaymentId, JSON.stringify(e.payload)]);
        return (r.rowCount ?? 0) > 0;
      },
      async pending(limit, now) {
        return (await all("select id, asaas_event_id, event_type, asaas_payment_id, payload, attempts from webhook_events where process_status='pending' and (next_attempt_at is null or next_attempt_at <= $2) order by received_at, id limit $1", [limit, now]))
          .map((r): StoredAsaasEvent => ({ id: Number(r.id), asaasEventId: String(r.asaas_event_id), eventType: String(r.event_type), asaasPaymentId: (r.asaas_payment_id as string) ?? null, payload: r.payload, attempts: Number(r.attempts) }));
      },
      async mark(id, status: ProcessStatus, o = {}) { await db.query(markSql("webhook_events"), [id, status, o.error ?? null, o.attempts ?? null, o.nextAttemptAt ?? null]); },
      async lastReceivedAt() { const r = await one<{ t: Date | null }>("select max(received_at) as t from webhook_events"); return r?.t ?? null; },
      async findByPayment(asaasPaymentId, eventType) {
        const r = await one("select id, asaas_event_id, event_type, asaas_payment_id, payload, attempts from webhook_events where asaas_payment_id=$1 and event_type=$2 order by received_at desc limit 1", [asaasPaymentId, eventType]);
        return r ? { id: Number(r.id), asaasEventId: String(r.asaas_event_id), eventType: String(r.event_type), asaasPaymentId: (r.asaas_payment_id as string) ?? null, payload: r.payload, attempts: Number(r.attempts) } : null;
      },
      async reset(id) { await db.query("update webhook_events set process_status='pending', attempts=0, next_attempt_at=null, error=null, processed_at=null where id=$1", [id]); },
    },
    odooEvents: {
      async insert(e) {
        const r = await one<{ id: number }>("insert into odoo_events (odoo_model, odoo_id, odoo_action, payload, process_status) values ($1,$2,$3,$4::jsonb,$5) returning id", [e.odooModel, e.odooId, e.odooAction, JSON.stringify(e.payload), e.status ?? "pending"]);
        return Number(r!.id);
      },
      async pending(limit, now) {
        return (await all("select id, odoo_model, odoo_id, odoo_action, attempts from odoo_events where process_status='pending' and (next_attempt_at is null or next_attempt_at <= $2) order by received_at, id limit $1", [limit, now]))
          .map((r): StoredOdooEvent => ({ id: Number(r.id), odooModel: String(r.odoo_model), odooId: Number(r.odoo_id), odooAction: (r.odoo_action as string) ?? null, attempts: Number(r.attempts) }));
      },
      async mark(id, status: ProcessStatus, o = {}) { await db.query(markSql("odoo_events"), [id, status, o.error ?? null, o.attempts ?? null, o.nextAttemptAt ?? null]); },
      async reset(id) { await db.query("update odoo_events set process_status='pending', attempts=0, next_attempt_at=null, error=null, processed_at=null where id=$1", [id]); },
    },
    reconciliations: {
      async insert(r) {
        await db.query("insert into reconciliations (charge_id, odoo_payment_id, amount_received, amount_expected, net_value, diff_policy, payment_date, credit_date) values ($1,$2,$3,$4,$5,$6,$7,$8)",
          [r.chargeId, r.odooPaymentId, r.amountReceived, r.amountExpected, r.netValue, r.diffPolicy, r.paymentDate, r.creditDate]);
      },
      async existsForCharge(chargeId) { return (await one("select 1 from reconciliations where charge_id=$1 limit 1", [chargeId])) !== null; },
    },
    exceptions: {
      async open(e) { await db.query("insert into exceptions (type, ref_table, ref_id, detail) values ($1,$2,$3,$4::jsonb)", [e.type, e.refTable ?? null, e.refId ?? null, JSON.stringify(e.detail ?? null)]); },
      async hasOpen(type, refTable, refId) {
        return (await one("select 1 from exceptions where status='open' and type=$1 and ($2::text is null or ref_table=$2) and ($3::bigint is null or ref_id=$3) limit 1", [type, refTable ?? null, refId ?? null])) !== null;
      },
      async get(id) {
        const r = await one("select id, type, status, ref_table, ref_id, detail from exceptions where id=$1", [id]);
        return r ? { id: Number(r.id), type: r.type as ExceptionType, status: r.status as "open" | "resolved" | "ignored", refTable: (r.ref_table as string) ?? null, refId: r.ref_id === null ? null : Number(r.ref_id), detail: r.detail } : null;
      },
      async setStatus(id, status, by) { await db.query("update exceptions set status=$2, resolved_by=$3, resolved_at=case when $2='open' then null else now() end where id=$1", [id, status, by]); },
    },
    watermarks: {
      async get(key) { const r = await one<{ t: Date }>("select last_write_date as t from sync_watermarks where key=$1", [key]); return r ? r.t.toISOString() : null; },
      async set(key, ts) { await db.query("insert into sync_watermarks (key, last_write_date) values ($1,$2) on conflict (key) do update set last_write_date=excluded.last_write_date, updated_at=now()", [key, ts]); },
    },
    audit: {
      async log(e) {
        await db.query("insert into audit_log (direction, endpoint, request_summary, response_status, response_summary, duration_ms) values ($1,$2,$3::jsonb,$4,$5::jsonb,$6)",
          [e.direction, e.endpoint, JSON.stringify(e.requestSummary ?? null), e.responseStatus ?? null, JSON.stringify(e.responseSummary ?? null), e.durationMs ?? null]);
      },
      async purgeOlderThan(days) { const r = await db.query("delete from audit_log where created_at < now() - ($1 || ' days')::interval", [String(days)]); return r.rowCount ?? 0; },
    },
  };
}
