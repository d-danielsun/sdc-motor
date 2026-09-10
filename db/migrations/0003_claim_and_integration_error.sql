-- QA 09/09: (U8) claim de eventos com FOR UPDATE SKIP LOCKED — dois workers nunca pegam o mesmo evento;
-- (U2) falha de integração (Odoo/Asaas fora, devolvendo HTML) vira exceção visível, não só log.
alter table webhook_events drop constraint webhook_events_process_status_check;
alter table webhook_events add constraint webhook_events_process_status_check
  check (process_status in ('pending','processing','done','error','ignored'));
alter table webhook_events add column locked_at timestamptz;

alter table odoo_events drop constraint odoo_events_process_status_check;
alter table odoo_events add constraint odoo_events_process_status_check
  check (process_status in ('pending','processing','done','error','ignored'));
alter table odoo_events add column locked_at timestamptz;

alter table exceptions drop constraint exceptions_type_check;
alter table exceptions add constraint exceptions_type_check check (type in (
  'customer_missing_document','charge_create_failed','payment_unmatched',
  'amount_divergent','reversal_pending','queue_interrupted','stale_heartbeat',
  'api_key_expiring','writeoff_needed','webhook_penalized','integration_error'));
