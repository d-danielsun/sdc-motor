-- Down da 0004. PERDE a unicidade de reconciliations.charge_id, que é a defesa contra baixa em
-- dobro NO SCHEMA. Não rode com o motor no ar. Perde também sync_watermarks.last_id, o que faz a
-- varredura repetir um segundo de faturas na próxima passada.
drop index if exists reconciliations_charge_id_uniq;
drop index if exists charges_odoo_move_id_due_date_idx;
drop index if exists charges_due_date_id_idx;
drop index if exists webhook_events_asaas_payment_id_received_at_idx;
drop index if exists webhook_events_received_at_idx;
drop index if exists odoo_events_received_at_idx;
drop index if exists exceptions_ref_table_ref_id_idx;
alter table sync_watermarks drop column last_id;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke update (status, resolved_by, resolved_at) on exceptions from authenticated';
    execute 'revoke select on customers_map, charges, reconciliations, exceptions, sync_watermarks, app_config from authenticated';
  end if;
end $$;
