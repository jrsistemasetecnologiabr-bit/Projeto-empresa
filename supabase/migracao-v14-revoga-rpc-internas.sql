-- ============================================================================
-- LojaCerta · MIGRAÇÃO v14 — fecha RPCs internas expostas em /rest/v1/rpc
-- ----------------------------------------------------------------------------
-- Achado (advisor 0028/0029): funções SECURITY DEFINER internas eram
-- executáveis por anon/authenticated via PostgREST. As críticas:
--   • send_email(...)          → relay aberto: qualquer pessoa disparava e-mail
--                                 pela conta Resend da empresa (spam/phishing).
--   • seed_categories(t, ...)  → anônimo inseria categorias em QUALQUER tenant.
--   • next_sale_numero(t) / next_ticket_numero(t) → anônimo "queimava"
--                                 a numeração de venda/ticket de outra empresa.
--   • sale_payload(uuid)       → leitura de venda por id sem checar tenant.
--   • cron_* / notify_*        → anônimo disparava jobs de suspensão/e-mail.
-- Funções de trigger também saem da API (trigger não checa EXECUTE ao disparar).
-- Helpers usados em políticas RLS (current_tenant_id, is_admin, …) e as RPCs
-- que o app chama continuam liberadas. Idempotente.
-- ============================================================================
do $$
declare
  f record;
  internas text[] := array[
    'send_email','seed_categories','next_sale_numero','next_ticket_numero',
    'sale_payload','cron_suspend_expired_plans','notify_expiring_plans',
    'audit_tenants_billing','audit_users_changes','bump_ticket','bump_ticket_on_msg',
    'fill_ticket_snapshots','guard_papel_dev','guard_tenants_billing','guard_ticket_flow',
    'handle_new_user','handle_user_confirmed','notify_ticket_reply','ticket_status_event',
    'touch_updated_at'];
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any(internas)
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- advisor 0011: search_path fixo
alter function public.touch_updated_at() set search_path = public, pg_temp;
