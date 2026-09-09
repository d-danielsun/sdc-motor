-- S1 — schema do motor (spec 02-SPEC.md v1.1). Postgres puro: nada específico de Supabase aqui.

create table customers_map (
  id bigint generated always as identity primary key,
  odoo_partner_id bigint not null unique,
  asaas_customer_id text unique,             -- null até sincronizar
  cpf_cnpj text,                             -- normalizado, só dígitos
  name text not null,
  email text, phone text,
  sync_status text not null default 'pending'
    check (sync_status in ('pending','synced','error','blocked_no_document')),
  last_error text,
  synced_at timestamptz, updated_at timestamptz not null default now()
);

create table charges (
  id bigint generated always as identity primary key,
  odoo_move_id bigint not null,
  odoo_move_line_id bigint not null unique,  -- 1 cobrança por parcela
  odoo_partner_id bigint not null,
  asaas_payment_id text unique,
  external_ref text not null unique,         -- 'odoo:move_line:<id>' (= externalReference no Asaas)
  amount numeric(14,2) not null,
  due_date date not null,
  status text not null default 'pending'
    check (status in ('pending','created','confirmed','received','settled',
                      'cancelled','refunded','exception')),
  bank_slip_url text, invoice_name text,     -- nº da fatura no Odoo, p/ UI
  nosso_numero text, asaas_invoice_number text, -- do objeto payment do Asaas, p/ UI/suporte
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on charges (status, due_date);
create index on charges (odoo_partner_id);

create table webhook_events (
  id bigint generated always as identity primary key,
  asaas_event_id text not null unique,       -- dedupe (entrega at-least-once)
  event_type text not null,
  asaas_payment_id text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  process_status text not null default 'pending'
    check (process_status in ('pending','done','error','ignored')),
  attempts int not null default 0,
  next_attempt_at timestamptz,
  error text
);
create index on webhook_events (process_status, received_at);

create table odoo_events (                   -- push da ida (S2): 1 linha por POST do Odoo
  id bigint generated always as identity primary key,
  odoo_model text not null,                  -- payload._model (esperado 'account.move')
  odoo_id bigint not null,                   -- payload._id
  odoo_action text,                          -- payload._action = '<nome da regra>(#<id>)'
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  process_status text not null default 'pending'
    check (process_status in ('pending','done','error','ignored')),
  attempts int not null default 0,
  next_attempt_at timestamptz,
  error text
);
create index on odoo_events (process_status, received_at);

create table reconciliations (
  id bigint generated always as identity primary key,
  charge_id bigint not null references charges(id),
  odoo_payment_id bigint,                    -- account.payment criado
  amount_received numeric(14,2) not null,    -- payment.value do webhook (bruto)
  amount_expected numeric(14,2) not null,    -- charges.amount
  net_value numeric(14,2),                   -- payment.netValue (só relatório; tarifa é despesa da SDC)
  diff numeric(14,2) generated always as (amount_received - amount_expected) stored,
  diff_policy text,                          -- 'juros_multa' | 'in_cash' | 'writeoff_financeiro' | 'exception' [Q3]
  payment_date date, credit_date date,
  created_at timestamptz not null default now()
);
create index on reconciliations (charge_id);

create table exceptions (
  id bigint generated always as identity primary key,
  type text not null check (type in (
    'customer_missing_document','charge_create_failed','payment_unmatched',
    'amount_divergent','reversal_pending','queue_interrupted','stale_heartbeat',
    'api_key_expiring','writeoff_needed','webhook_penalized')),
  ref_table text, ref_id bigint, detail jsonb,
  status text not null default 'open' check (status in ('open','resolved','ignored')),
  resolved_by text, resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index on exceptions (status, type);

create table sync_watermarks (
  key text primary key,                      -- 'invoices' | 'customers'
  last_write_date timestamptz not null,
  updated_at timestamptz not null default now()
);

create table audit_log (
  id bigint generated always as identity primary key,
  direction text not null check (direction in ('odoo_out','asaas_out','asaas_in','odoo_in')),
  endpoint text not null, request_summary jsonb, response_status int,
  response_summary jsonb, duration_ms int,
  created_at timestamptz not null default now()
);
create index on audit_log (created_at);
-- retenção: job mensal apaga audit_log > 90 dias

create table app_config (                    -- config não-secreta (secretos ficam em env)
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into app_config (key, value) values
  ('IDA_ENABLED', 'false'),                  -- kill switch da ida; liga no gate R1
  ('TOLERANCE_BRL', '"0.01"'),         -- string decimal, como todo dinheiro no motor
  ('GO_LIVE_CUTOFF_DATE', 'null'),           -- a ida ignora invoice_date anterior [Q6]
  ('ASAAS_WEBHOOK_ID', 'null'),
  ('ASAAS_PENALIZED_LAST', '0');

-- RLS ligado em tudo desde o dia 1 (é Postgres, não Supabase). Policies de leitura do financeiro
-- entram em 0002_rls_supabase.sql, só onde o role `authenticated` existir.
alter table customers_map   enable row level security;
alter table charges         enable row level security;
alter table webhook_events  enable row level security;
alter table odoo_events     enable row level security;
alter table reconciliations enable row level security;
alter table exceptions      enable row level security;
alter table sync_watermarks enable row level security;
alter table audit_log       enable row level security;
alter table app_config      enable row level security;
