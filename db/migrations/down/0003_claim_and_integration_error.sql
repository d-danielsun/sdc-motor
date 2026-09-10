-- Down da 0003. PERDE: locked_at das duas filas e as exceções `integration_error`.
-- Eventos em 'processing' voltam a 'pending' ANTES da constraint antiga, senão ela os rejeita.
update webhook_events set process_status = 'pending' where process_status = 'processing';
update odoo_events   set process_status = 'pending' where process_status = 'processing';
alter table webhook_events drop column locked_at;
alter table odoo_events   drop column locked_at;
alter table webhook_events drop constraint webhook_events_process_status_check;
alter table webhook_events add constraint webhook_events_process_status_check
  check (process_status in ('pending','done','error','ignored'));
alter table odoo_events drop constraint odoo_events_process_status_check;
alter table odoo_events add constraint odoo_events_process_status_check
  check (process_status in ('pending','done','error','ignored'));

delete from exceptions where type = 'integration_error';   -- a constraint antiga não aceita este tipo
alter table exceptions drop constraint exceptions_type_check;
alter table exceptions add constraint exceptions_type_check check (type in (
  'customer_missing_document','charge_create_failed','payment_unmatched',
  'amount_divergent','reversal_pending','queue_interrupted','stale_heartbeat',
  'api_key_expiring','writeoff_needed','webhook_penalized'));
