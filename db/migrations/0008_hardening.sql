-- Endurecimento técnico (#15). Três mudanças de SCHEMA; as outras partes da #15 (#4 o tripwire
-- de leitura, #5 o reenfileiramento em lote, #8 os DTOs e a paginação) são só código e não
-- aparecem aqui. Cada seção abaixo diz qual issue ela fecha.

-- ── 1. Token de posse na reserva de evento (#6) ──────────────────────────────
-- Hoje a reserva é `process_status='processing'` + `locked_at` com TTL de 10 min, e o `mark` é
-- por id. Um worker que voltou DEPOIS do TTL — pausa de GC, rede lenta, container congelado —
-- sobrescreve o resultado do novo dono, que já processou o evento. O token faz o `mark` afetar
-- 0 linhas nesse caso, e 0 linhas é o sinal de que a reserva foi perdida.
alter table webhook_events add column claim_token uuid;
alter table odoo_events   add column claim_token uuid;

-- ── 2. Colapsar notificações repetidas do Odoo (#6) ──────────────────────────
-- O Odoo dispara a regra por gravação, não por transição: postar uma fatura pode gerar várias
-- notificações da MESMA fatura. O motor aguenta (handleInvoice é idempotente e tem lock por
-- fatura), mas processa N vezes o mesmo trabalho.
--
-- A limpeza vem ANTES do índice, senão a criação falha em qualquer banco que já tenha duplicata
-- pendente. Fica a mais antiga; as outras viram `ignored` com motivo, para a trilha não sumir.
with duplicadas as (
  select id, row_number() over (partition by odoo_model, odoo_id order by received_at, id) as n
    from odoo_events where process_status = 'pending'
)
update odoo_events e
   set process_status = 'ignored',
       processed_at = now(),
       error = 'colapsada na migration 0008: já havia notificação pendente para a mesma fatura'
  from duplicadas d
 where e.id = d.id and d.n > 1;

create unique index odoo_events_pendente_uniq on odoo_events (odoo_model, odoo_id) where process_status = 'pending';

-- ── 3. Migrations com hash do conteúdo (#7) ──────────────────────────────────
-- Redundante com o bootstrap do runner (que já faz o mesmo `add column if not exists`), e fica
-- aqui só para quem aplicar os arquivos à mão com psql ver a coluna existir.
-- `schema_migrations` guardava só o nome: um arquivo editado depois de aplicado passava batido, e
-- ninguém descobria que o banco e o disco discordam. A coluna nasce nula e o RUNNER preenche o
-- hash das já aplicadas na primeira execução — SQL não lê arquivo, e recusar subir em todo
-- ambiente existente seria pior que assumir que o disco corresponde ao que foi aplicado.
alter table schema_migrations add column if not exists content_sha256 text;   -- `if not exists`: em banco novo o bootstrap do runner já a criou
