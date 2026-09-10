-- Login próprio do console (fecha a #1). Até aqui a API era aberta por um token compartilhado e
-- `exceptions.resolved_by` vinha do header `x-user`, que qualquer portador do token escolhia —
-- num motor que mexe em dinheiro isso não é rastro de auditoria, é sugestão.
--
-- O token de sessão NUNCA é persistido: guardamos só o sha256. Vazamento do banco não vira
-- sessão viva. Senha em scrypt (node:crypto), formato descrito em src/core/auth.ts.
create table console_users (
  id            bigint generated always as identity primary key,
  email         text not null unique,              -- sempre normalizado (trim + lowercase)
  name          text not null,
  password_hash text not null,                     -- scrypt$N$r$p$salt_b64$hash_b64
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

create table console_sessions (
  token_hash text primary key,                     -- sha256 do token do cookie, hex
  user_id    bigint not null references console_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index on console_sessions (expires_at);      -- purge no reconcile-daily
create index on console_sessions (user_id);         -- revogar tudo de um usuário

-- Mesma postura das outras tabelas: RLS ligada. Estas duas não têm policy nenhuma de
-- propósito, nem no Supabase: só o service role (que ignora RLS) fala com elas. Hash de
-- senha e de sessão não passam nem perto do papel `authenticated`.
alter table console_users    enable row level security;
alter table console_sessions enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on console_users, console_sessions from authenticated';
  end if;
end $$;
