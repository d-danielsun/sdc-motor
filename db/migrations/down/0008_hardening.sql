-- Down da 0008, as três seções de uma vez (rollback é por migration, não por item).
-- As notificações do Odoo que a migration colapsou NÃO voltam a 'pending': ficam 'ignored' com o
-- motivo, o que é o certo — reabri-las criaria trabalho duplicado de propósito.
drop index if exists odoo_events_pendente_uniq;
alter table webhook_events drop column claim_token;
alter table odoo_events   drop column claim_token;
alter table schema_migrations drop column content_sha256;
