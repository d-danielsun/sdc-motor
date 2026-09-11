// Repositório Postgres (pg). SQL explícito; sem ORM — o mesmo arquivo vale pra Supabase e pra qualquer Postgres.
import type pg from "pg";
import { OPEN_STATUSES } from "../../core/charges.js";
import { FilaJaTemPendente, type Repo } from "../../core/ports.js";
import type { Charge, ChargeStatus, CustomerMap, ExceptionType, ProcessStatus, StoredAsaasEvent, StoredOdooEvent } from "../../core/types.js";

type Row = Record<string, unknown>;

/** Um evento reservado por um worker volta pra fila se ninguém o tocar (`touch`) por este tempo. */
export const CLAIM_TTL_MINUTES = 10;

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
const asaasEventRow = (r: Row): StoredAsaasEvent => ({ id: Number(r.id), claimToken: String(r.claim_token ?? ""), asaasEventId: String(r.asaas_event_id), eventType: String(r.event_type), asaasPaymentId: (r.asaas_payment_id as string) ?? null, payload: r.payload, attempts: Number(r.attempts) });
const odooEventRow = (r: Row): StoredOdooEvent => ({ id: Number(r.id), claimToken: String(r.claim_token ?? ""), odooModel: String(r.odoo_model), odooId: Number(r.odoo_id), odooAction: (r.odoo_action as string) ?? null, attempts: Number(r.attempts) });

// Reserva (claim) com FOR UPDATE SKIP LOCKED: dois workers nunca pegam o mesmo evento; reserva
// abandonada expira depois do TTL.
//
// O `claim_token` (0008) fecha o furo que sobrava: um worker que voltou DEPOIS do TTL — pausa de
// GC, rede lenta, container congelado — ainda tinha o id e sobrescrevia o resultado do novo dono.
// Agora `mark` e `touch` exigem o token da reserva; afetar 0 linhas é o sinal de que a reserva foi
// perdida, e o worker antigo registra e segue sem escrever nada.
//
// `is not distinct from` e não `($n is null or ...)`: sem token, a marcação casa APENAS com evento
// que ninguém reservou. Era um furo com cara de conveniência — quem não passasse token sobrescrevia
// qualquer coisa, inclusive uma reserva viva (achado do verificador da #15). O caso legítimo sem
// token existe: `server.ts` marca um evento que ele mesmo acabou de inserir e que, se algum worker
// já tiver reservado, não deve ser tocado.
const claimSql = (table: string, cols: string) => `with c as (
    select id from ${table}
    where (process_status='pending' and (next_attempt_at is null or next_attempt_at <= $2))
       or (process_status='processing' and locked_at < $2::timestamptz - interval '${CLAIM_TTL_MINUTES} minutes')
    order by received_at, id limit $1 for update skip locked)
  update ${table} e set process_status='processing', locked_at=$2, claim_token=gen_random_uuid() from c where e.id=c.id returning ${cols}, e.claim_token`;
const markSql = (table: string) => `update ${table} set process_status=$2, processed_at=case when $2 in ('done','error','ignored') then now() else processed_at end,
  error=coalesce($3, error), attempts=coalesce($4, attempts), next_attempt_at=$5, locked_at=null, claim_token=null
  where id=$1 and claim_token is not distinct from $6::uuid`;
const touchSql = (table: string) => `update ${table} set locked_at=$2 where id=$1 and claim_token is not distinct from $3::uuid`;
const resetSql = (table: string) => `update ${table} set process_status='pending', attempts=0, next_attempt_at=null, error=null, processed_at=null, locked_at=null, claim_token=null where id=$1`;
const purgeSql = (table: string) => `delete from ${table} where process_status in ('done','ignored') and processed_at < now() - ($1 || ' days')::interval`;

const isUniqueViolation = (e: unknown, constraint?: string) => (e as { code?: string; constraint?: string }).code === "23505" && (!constraint || (e as { constraint?: string }).constraint === constraint);
const patchSql = `asaas_payment_id=coalesce($3, asaas_payment_id), bank_slip_url=coalesce($4, bank_slip_url), nosso_numero=coalesce($5, nosso_numero), asaas_invoice_number=coalesce($6, asaas_invoice_number), updated_at=now()`;

/** `lockPool`: conexões dedicadas aos advisory locks — quem segura lock (durante chamadas HTTP) nunca esgota o pool das consultas (red team). */
export function createPgRepo(pool: pg.Pool, lockPool: pg.Pool = pool): Repo {
  const db = pool;
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
          on conflict (odoo_partner_id) do update set asaas_customer_id=coalesce(customers_map.asaas_customer_id, excluded.asaas_customer_id), cpf_cnpj=excluded.cpf_cnpj, name=excluded.name,
            email=excluded.email, phone=excluded.phone, sync_status=excluded.sync_status, last_error=excluded.last_error, synced_at=coalesce(customers_map.synced_at, excluded.synced_at), updated_at=now()
          returning *`, [c.odooPartnerId, c.asaasCustomerId, c.cpfCnpj, c.name, c.email, c.phone, c.syncStatus, c.lastError]);
        return customerRow(r!);
      },
      async listSynced() { return (await all("select * from customers_map where sync_status='synced' and asaas_customer_id is not null order by id")).map(customerRow); },
    },
    charges: {
      async getByMoveLine(id) { const r = await one("select * from charges where odoo_move_line_id=$1", [id]); return r ? chargeRow(r) : null; },
      async getByExternalRef(ref) { const r = await one("select * from charges where external_ref=$1", [ref]); return r ? chargeRow(r) : null; },
      async getByAsaasPayment(id) { const r = await one("select * from charges where asaas_payment_id=$1", [id]); return r ? chargeRow(r) : null; },
      async listByMove(moveId) { return (await all("select * from charges where odoo_move_id=$1 order by due_date, id", [moveId])).map(chargeRow); },
      async insert(c) {
        try {
          const r = await one(`insert into charges (odoo_move_id, odoo_move_line_id, odoo_partner_id, asaas_payment_id, external_ref, amount, due_date, status, bank_slip_url, invoice_name, nosso_numero, asaas_invoice_number)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
            [c.odooMoveId, c.odooMoveLineId, c.odooPartnerId, c.asaasPaymentId, c.externalRef, c.amount, c.dueDate, c.status, c.bankSlipUrl, c.invoiceName, c.nossoNumero, c.asaasInvoiceNumber]);
          return chargeRow(r!);
        } catch (e) {
          if (isUniqueViolation(e, "charges_odoo_move_line_id_key")) return null;   // só a corrida na parcela é "silenciosa"; outro unique é bug/dado ruim
          throw e;
        }
      },
      async transition(id, from, to, patch = {}) {
        const r = await db.query(`update charges set status=$2, ${patchSql} where id=$1 and status = any($7::text[])`,
          [id, to, patch.asaasPaymentId ?? null, patch.bankSlipUrl ?? null, patch.nossoNumero ?? null, patch.asaasInvoiceNumber ?? null, from]);
        return (r.rowCount ?? 0) > 0;
      },
      async markReceived(id, rec, patch = {}) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          try {
            await client.query("insert into reconciliations (charge_id, odoo_payment_id, amount_received, amount_expected, net_value, diff_policy, payment_date, credit_date) values ($1,$2,$3,$4,$5,$6,$7,$8)",
              [id, rec.odooPaymentId, rec.amountReceived, rec.amountExpected, rec.netValue, rec.diffPolicy, rec.paymentDate, rec.creditDate]);
          } catch (e) {
            await client.query("rollback");
            if (isUniqueViolation(e)) return false;
            throw e;
          }
          await client.query(`update charges set status='received', asaas_payment_id=coalesce($2, asaas_payment_id), nosso_numero=coalesce($3, nosso_numero), asaas_invoice_number=coalesce($4, asaas_invoice_number), updated_at=now() where id=$1`,
            [id, patch.asaasPaymentId ?? null, patch.nossoNumero ?? null, patch.asaasInvoiceNumber ?? null]);
          await client.query("commit");
          return true;
        } catch (e) {
          await client.query("rollback").catch(() => undefined);
          throw e;
        } finally {
          client.release();
        }
      },
      async countOpen() { const r = await one<{ n: number }>("select count(*)::int as n from charges where status = any($1::text[])", [[...OPEN_STATUSES]]); return r?.n ?? 0; },
      async listOpenDueBefore(date, limit) { return (await all("select * from charges where status = any($1::text[]) and due_date < $2::date and asaas_payment_id is not null order by due_date, id limit $3", [[...OPEN_STATUSES], date, limit])).map(chargeRow); },
    },
    async withLock(key, fn) {
      const client = await lockPool.connect();
      try {
        const got = await client.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1)) as ok", [key]);
        if (!got.rows[0]?.ok) return { ok: false, busy: true };
        try { return { ok: true, value: await fn() }; }
        finally { await client.query("select pg_advisory_unlock(hashtext($1))", [key]); }
      } finally {
        client.release();
      }
    },
    asaasEvents: {
      async insert(e) {
        const r = await one<{ id: number }>("insert into webhook_events (asaas_event_id, event_type, asaas_payment_id, payload) values ($1,$2,$3,$4::jsonb) on conflict (asaas_event_id) do nothing returning id", [e.asaasEventId, e.eventType, e.asaasPaymentId, JSON.stringify(e.payload)]);
        return r ? Number(r.id) : null;
      },
      async pending(limit, now) {
        return (await all(claimSql("webhook_events", "e.id, e.asaas_event_id, e.event_type, e.asaas_payment_id, e.payload, e.attempts"), [limit, now])).sort((a, b) => Number(a.id) - Number(b.id)).map(asaasEventRow);
      },
      async mark(id, status: ProcessStatus, o = {}) { return ((await db.query(markSql("webhook_events"), [id, status, o.error ?? null, o.attempts ?? null, o.nextAttemptAt ?? null, o.claimToken ?? null])).rowCount ?? 0) > 0; },
      async touch(id, now, claimToken) { return ((await db.query(touchSql("webhook_events"), [id, now, claimToken ?? null])).rowCount ?? 0) > 0; },
      async lastReceivedAt() { const r = await one<{ t: Date | null }>("select max(received_at) as t from webhook_events"); return r?.t ?? null; },
      async findByPayment(asaasPaymentId, eventType) {
        const r = await one("select id, claim_token, asaas_event_id, event_type, asaas_payment_id, payload, attempts from webhook_events where asaas_payment_id=$1 and event_type=$2 order by received_at desc limit 1", [asaasPaymentId, eventType]);
        return r ? asaasEventRow(r) : null;
      },
      async reset(id) { await db.query(resetSql("webhook_events"), [id]); },
      async requeueFromError(id) { return ((await db.query(`${resetSql("webhook_events")} and process_status='error'`, [id])).rowCount ?? 0) > 0; },
      async purgeProcessedOlderThan(days) { const r = await db.query(purgeSql("webhook_events"), [String(days)]); return r.rowCount ?? 0; },
    },
    odooEvents: {
      async insert(e) {
        // `on conflict do nothing` sobre o índice parcial unique da 0008: notificação repetida do
        // Odoo para a mesma fatura, ainda pendente, é colapsada. null = já havia uma na fila.
        const r = await one<{ id: number }>(`insert into odoo_events (odoo_model, odoo_id, odoo_action, payload, process_status)
          values ($1,$2,$3,$4::jsonb,$5)
          on conflict (odoo_model, odoo_id) where process_status = 'pending' do nothing
          returning id`,
          [e.odooModel, e.odooId, e.odooAction, JSON.stringify(e.payload), e.status ?? "pending"]);
        return r ? Number(r.id) : null;
      },
      async pending(limit, now) {
        return (await all(claimSql("odoo_events", "e.id, e.odoo_model, e.odoo_id, e.odoo_action, e.attempts"), [limit, now])).sort((a, b) => Number(a.id) - Number(b.id)).map(odooEventRow);
      },
      async mark(id, status: ProcessStatus, o = {}) {
        // Devolver um evento para `pending` pode colidir com o índice parcial da 0008: já existe
        // outra notificação pendente para a mesma fatura. Sem esta tradução, o 23505 subia CRU de
        // dentro do catch do worker, matava o tick, e como o job `worker` roda o Odoo antes do
        // Asaas, a volta do dinheiro parava junto — a cada minuto, para sempre. Achado do
        // verificador da #15, reproduzido antes de corrigir.
        try {
          return ((await db.query(markSql("odoo_events"), [id, status, o.error ?? null, o.attempts ?? null, o.nextAttemptAt ?? null, o.claimToken ?? null])).rowCount ?? 0) > 0;
        } catch (e) {
          if (isUniqueViolation(e, "odoo_events_pendente_uniq")) throw new FilaJaTemPendente(`já existe notificação pendente para a mesma fatura (evento ${id})`);
          throw e;
        }
      },
      async touch(id, now, claimToken) { return ((await db.query(touchSql("odoo_events"), [id, now, claimToken ?? null])).rowCount ?? 0) > 0; },
      async reset(id) { await db.query(resetSql("odoo_events"), [id]); },
      async requeueFromError(id) {
        try {
          return ((await db.query(`${resetSql("odoo_events")} and process_status='error'`, [id])).rowCount ?? 0) > 0;
        } catch (e) {
          if (isUniqueViolation(e, "odoo_events_pendente_uniq")) throw new FilaJaTemPendente(`já existe notificação pendente para a mesma fatura (evento ${id})`);
          throw e;
        }
      },
      async purgeProcessedOlderThan(days) { const r = await db.query(purgeSql("odoo_events"), [String(days)]); return r.rowCount ?? 0; },
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
      async openOnce(e) {
        const p = [e.type, e.refTable ?? null, e.refId ?? null, JSON.stringify(e.detail ?? null)];
        const r = await db.query<{ id: string }>(`insert into exceptions (type, ref_table, ref_id, detail) select $1,$2,$3,$4::jsonb
          where not exists (select 1 from exceptions where status='open' and type=$1 and ref_table is not distinct from $2 and ref_id is not distinct from $3)
          returning id`,
          p);
        if (r.rows[0]) return { id: Number(r.rows[0].id), nova: true };
        // Já havia uma aberta: devolve o id DELA, porque o alerta linka o console de qualquer jeito.
        const existente = await one<{ id: string }>(`select id from exceptions where status='open' and type=$1
          and ref_table is not distinct from $2 and ref_id is not distinct from $3 order by id limit 1`, p.slice(0, 3));
        if (existente) return { id: Number(existente.id), nova: false };
        // Corrida: alguém resolveu a exceção entre o insert e o select. Insere de novo em vez de
        // devolver id 0, que viraria um link para /excecoes/0 no e-mail de alerta.
        const segunda = await db.query<{ id: string }>(`insert into exceptions (type, ref_table, ref_id, detail) values ($1,$2,$3,$4::jsonb) returning id`, p);
        return { id: Number(segunda.rows[0]!.id), nova: true };
      },
      async hasOpen(type, refTable, refId) {
        return (await one("select 1 from exceptions where status='open' and type=$1 and ($2::text is null or ref_table=$2) and ($3::bigint is null or ref_id=$3) limit 1", [type, refTable ?? null, refId ?? null])) !== null;
      },
      async countOpenByType() {
        const out: Record<string, number> = {};
        for (const r of await all<{ type: string; n: number }>("select type, count(*)::int as n from exceptions where status='open' group by type")) out[r.type] = r.n;
        return out;
      },
      async get(id) {
        const r = await one("select id, type, status, ref_table, ref_id, detail from exceptions where id=$1", [id]);
        return r ? { id: Number(r.id), type: r.type as ExceptionType, status: r.status as "open" | "resolved" | "ignored", refTable: (r.ref_table as string) ?? null, refId: r.ref_id === null ? null : Number(r.ref_id), detail: r.detail } : null;
      },
      async listOpenWithEvent(type) {
        return (await all<{ id: string; ref_table: string; ref_id: string }>(
          `select id, ref_table, ref_id from exceptions
            where status='open' and type=$1 and ref_id is not null and ref_table in ('webhook_events','odoo_events')
            order by id`, [type],
        )).map((r) => ({ id: Number(r.id), refTable: r.ref_table as "webhook_events" | "odoo_events", refId: Number(r.ref_id) }));
      },
      async setStatus(id, status, by) { await db.query("update exceptions set status=$2, resolved_by=$3, resolved_at=case when $2='open' then null else now() end where id=$1", [id, status, by]); },
    },
    watermarks: {
      async get(key) { const r = await one<{ t: Date; id: string }>("select last_write_date as t, last_id as id from sync_watermarks where key=$1", [key]); return r ? { writeDate: r.t.toISOString(), id: Number(r.id) } : null; },
      async set(key, w) { await db.query("insert into sync_watermarks (key, last_write_date, last_id) values ($1,$2,$3) on conflict (key) do update set last_write_date=excluded.last_write_date, last_id=excluded.last_id, updated_at=now()", [key, w.writeDate, w.id]); },
    },
    alerts: {
      async reservar(a) {
        // DUAS statements numa transação, e a ordem é o ponto todo.
        //
        // A versão anterior era uma statement só (`insert ... where not exists`) com a
        // afirmação de que isso bastava como trava entre processos. É FALSO no READ COMMITTED,
        // e o verificador da #14 provou: `where not exists` não pega lock de predicado, então
        // dois processos avaliam "não existe" e os dois inserem — medido, 2 linhas para o
        // mesmo evento, e até 8 com 8 conexões.
        //
        // Travar dentro da MESMA statement também não resolve, e essa é a parte contraintuitiva:
        // o snapshot da statement é tirado ANTES de ela bloquear no lock, então quando ela
        // acorda continua sem ver a linha que o outro processo commitou. Medido também.
        //
        // Aqui a trava vem numa statement separada. O insert seguinte tira um snapshot NOVO,
        // já depois do lock, e enxerga a linha do outro. `pg_advisory_xact_lock` solta sozinho
        // no commit, então não há lock vazado se algo estourar no meio.
        //
        // A janela é DESLIZANTE (`now() - intervalo`), não balde fixo: balde manda um alerta
        // às 5h59 e outro às 6h01. É por isso que um unique index não serve aqui.
        const client = await pool.connect();
        try {
          await client.query("begin");
          await client.query("select pg_advisory_xact_lock(hashtext($1))", [a.alertKey]);
          const r = await client.query<{ id: string }>(
            `insert into alerts_sent (alert_key, channel, recipients, ok)
             select $1, $2, $3, false
             where not exists (select 1 from alerts_sent where alert_key = $1 and sent_at > now() - ($4 || ' minutes')::interval)
             returning id`,
            [a.alertKey, a.channel, a.recipients, String(a.janelaMinutos)],
          );
          await client.query("commit");
          return r.rows[0] ? Number(r.rows[0].id) : null;
        } catch (e) {
          await client.query("rollback").catch(() => undefined);
          throw e;
        } finally {
          client.release();
        }
      },
      async registrar(id, r) {
        await db.query("update alerts_sent set ok = $2, error = $3 where id = $1", [id, r.ok, r.error ?? null]);
      },
      async recentes(limit = 50) {
        return (await all<{ id: string; alert_key: string; sent_at: string; ok: boolean; error: string | null; recipients: string }>(
          "select id, alert_key, sent_at, ok, error, recipients from alerts_sent order by sent_at desc, id desc limit $1", [limit],
        )).map((x) => ({ id: Number(x.id), alertKey: x.alert_key, sentAt: new Date(x.sent_at), ok: x.ok === true, error: x.error, recipients: x.recipients }));
      },
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
