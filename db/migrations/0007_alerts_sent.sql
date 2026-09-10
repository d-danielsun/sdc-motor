-- Alerta crítico por e-mail. Uma fila do Asaas parada numa sexta pode custar o fim de semana,
-- e os eventos do Asaas morrem em 14 dias: silêncio aqui vira dinheiro perdido.
--
-- A TABELA É O DEDUPE, e o dedupe é janela DESLIZANTE, não balde fixo. Balde de 6h manda um
-- alerta às 5h59 e outro às 6h01. Aqui a reserva é uma statement atômica só (ver
-- src/core/usecases/notify.ts), o que também serve de trava entre dois processos no mesmo
-- instante: quem inseriu manda, quem não inseriu cala.
--
-- A linha é registro da TENTATIVA, não do sucesso: nasce com ok=false e vira true depois do
-- envio. Se o processo morrer entre reservar e enviar, a linha segura a janela e aquele aviso
-- se perde. Troca consciente: preferimos perder um aviso a mandar dez.
create table alerts_sent (
  id         bigint generated always as identity primary key,
  alert_key  text not null,                          -- "<tipo>:<ref>"
  sent_at    timestamptz not null default now(),
  channel    text not null,
  recipients text not null,
  ok         boolean not null,
  error      text
);
create index on alerts_sent (alert_key, sent_at desc);   -- a consulta da janela é exatamente esta

alter table alerts_sent enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on alerts_sent from authenticated';   -- destinatários não vão pra UI
  end if;
end $$;
