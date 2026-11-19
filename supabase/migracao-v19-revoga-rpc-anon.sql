-- LojaCerta · migração v19 — RPCs de negócio fora do alcance anônimo (aplicada)
-- Advisor 0028: as funções abaixo eram executáveis pelo papel anon (grant
-- padrão a PUBLIC). Elas já validavam a sessão internamente, mas agora o
-- PostgREST recusa antes de executar. Helpers usados nas políticas RLS
-- (current_tenant_id, is_admin, is_dev, is_staff, current_role_app,
-- tenant_billing_ok) continuam como estão — revogá-los quebraria o RLS do anon.
do $$
declare f text;
begin
  foreach f in array array[
    'public.admin_audit_list(integer)','public.billing_refresh_status()','public.cancel_sale(jsonb)',
    'public.commit_sale(jsonb)','public.stock_adjust(jsonb)','public.stock_entry(jsonb)',
    'public.support_badge_counts()','public.support_create_ticket(jsonb)','public.support_take_ticket(uuid)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
