-- Review 09/09 (gstack-review + Codex): índices que as consultas reais usam, unicidade da conciliação,
-- watermark com desempate por id, e privilégios de coluna no Supabase.
create unique index reconciliations_charge_id_uniq on reconciliations (charge_id);   -- 1 baixa por cobrança, no schema
create index on charges (odoo_move_id, due_date);
create index on charges (due_date, id);
create index on webhook_events (asaas_payment_id, received_at desc) where asaas_payment_id is not null;
create index on webhook_events (received_at desc);
create index on odoo_events (received_at desc);
create index on exceptions (ref_table, ref_id) where ref_id is not null;

alter table sync_watermarks add column last_id bigint not null default 0;              -- desempate (write_date, id)

-- Supabase: RLS não restringe coluna — só GRANT. O financeiro só muda status/resolved_* das exceções.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant select on customers_map, charges, reconciliations, exceptions, sync_watermarks, app_config to authenticated';
    execute 'revoke all on webhook_events, odoo_events, audit_log from authenticated';   -- payloads crus e trilha não vão pra UI
    execute 'revoke update on exceptions from authenticated';
    execute 'grant update (status, resolved_by, resolved_at) on exceptions to authenticated';
  end if;
end $$;
