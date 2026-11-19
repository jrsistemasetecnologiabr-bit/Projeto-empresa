-- LojaCerta · migração v18 — limites dos planos aplicados no servidor (aplicada)
-- Antes: os limites anunciados (usuários/produtos por plano) só existiam no texto.
-- Regras (só para lojas com plano pago ATIVO; teste grátis, dev e premium = sem limite):
--   essencial    → 2 usuários ativos (+ convites pendentes) · 3.000 produtos
--   profissional → 6 usuários ativos (+ convites pendentes) · 20.000 produtos
-- Mensagens em pt-BR completas: o app exibe o texto do banco diretamente.

create or replace function public.plan_limit(p_tenant uuid, p_kind text)
returns integer language sql stable security definer set search_path = '' as $$
  select case
    when t.status <> 'active' or coalesce(t.plan_id, '') not in ('essencial', 'profissional') then null
    when p_kind = 'users'    then case t.plan_id when 'essencial' then 2    else 6     end
    when p_kind = 'products' then case t.plan_id when 'essencial' then 3000 else 20000 end
  end
  from public.tenants t where t.id = p_tenant
$$;
revoke all on function public.plan_limit(uuid, text) from public, anon, authenticated;

create or replace function public.enforce_plan_products()
returns trigger language plpgsql security definer set search_path = '' as $$
declare lim integer; n integer;
begin
  lim := public.plan_limit(new.tenant_id, 'products');
  if lim is null then return new; end if;
  select count(*) into n from public.products where tenant_id = new.tenant_id;
  if n >= lim then
    raise exception 'Seu plano permite até % produtos cadastrados. Para cadastrar mais, faça upgrade do plano em Assinatura.', to_char(lim, 'FM999G999') using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function public.enforce_plan_users()
returns trigger language plpgsql security definer set search_path = '' as $$
declare lim integer; n integer;
begin
  -- users: só conta quando a linha passa a ficar ativa (reativação)
  if tg_table_name = 'users' then
    if not (new.ativo and not coalesce(old.ativo, false)) then return new; end if;
  end if;
  lim := public.plan_limit(new.tenant_id, 'users');
  if lim is null then return new; end if;
  select (select count(*) from public.users u where u.tenant_id = new.tenant_id and u.ativo)
       + (select count(*) from public.user_invites i where i.tenant_id = new.tenant_id
            and i.accepted_at is null and i.revoked_at is null and i.expires_at > now())
    into n;
  if n >= lim then
    raise exception 'Seu plano permite até % usuários (contando convites pendentes). Faça upgrade em Assinatura ou desative/revogue alguém da equipe.', lim using errcode = 'P0001';
  end if;
  return new;
end $$;

revoke all on function public.enforce_plan_products() from public, anon, authenticated;
revoke all on function public.enforce_plan_users() from public, anon, authenticated;

drop trigger if exists trg_plan_products on public.products;
create trigger trg_plan_products before insert on public.products
  for each row execute function public.enforce_plan_products();

drop trigger if exists trg_plan_invites on public.user_invites;
create trigger trg_plan_invites before insert on public.user_invites
  for each row execute function public.enforce_plan_users();

drop trigger if exists trg_plan_users_reactivate on public.users;
create trigger trg_plan_users_reactivate before update of ativo on public.users
  for each row execute function public.enforce_plan_users();
