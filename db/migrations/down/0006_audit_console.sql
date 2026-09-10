-- Down da 0006. As linhas de trilha com direction='console' (login e logout) precisam sair antes,
-- senão a constraint restaurada as rejeita.
delete from audit_log where direction = 'console';
alter table audit_log drop constraint audit_log_direction_check;
alter table audit_log add constraint audit_log_direction_check
  check (direction in ('odoo_out','asaas_out','asaas_in','odoo_in'));
