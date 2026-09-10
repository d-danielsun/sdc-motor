-- Login e logout do console viram linha na trilha, e a trilha é o ponto deste sistema. Até
-- aqui só havia direção para Odoo e Asaas, então esses eventos entravam rotulados como
-- `asaas_in` — mentira pequena que suja exatamente o que a auditoria precisa ler.
alter table audit_log drop constraint audit_log_direction_check;
alter table audit_log add constraint audit_log_direction_check
  check (direction in ('odoo_out','asaas_out','asaas_in','odoo_in','console'));
