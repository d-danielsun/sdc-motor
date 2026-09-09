-- Policies do console (Supabase): leitura para usuários autenticados; escrita SÓ via service role,
-- que ignora RLS. Em Postgres puro (container) o role não existe e este arquivo é no-op.
do $$
declare t text;
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    foreach t in array array['customers_map','charges','webhook_events','odoo_events',
                              'reconciliations','exceptions','sync_watermarks','audit_log','app_config'] loop
      execute format('drop policy if exists %I on %I', 'financeiro_read_' || t, t);
      execute format('create policy %I on %I for select to authenticated using (true)', 'financeiro_read_' || t, t);
    end loop;
    -- exceções: o financeiro resolve/ignora pelo console (update só de status/resolved_*)
    execute 'drop policy if exists financeiro_resolve_exceptions on exceptions';
    execute 'create policy financeiro_resolve_exceptions on exceptions for update to authenticated using (true) with check (true)';
  end if;
end $$;
