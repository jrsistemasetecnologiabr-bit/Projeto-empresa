-- ============================================================================
-- LojaCerta · MIGRAÇÃO v5 — Billing justo: dev ilimitado, trial único,
-- suspensão server-side e guard de colunas de cobrança
-- ----------------------------------------------------------------------------
-- O que resolve:
--   1. Conta DEV (equipe JR Sistemas): papel 'dev' + tenant 'active' com plano
--      'dev' por tempo indeterminado (trial_ends_at = +200 anos).
--   2. Trial de 14 dias ÚNICO e não renovável: ninguém (exceto service role /
--      equipe via Edge Function) pode alterar status/plan_id/trial_ends_at.
--   3. Expiração do trial virada no SERVIDOR: trial vencido => 'read_only'
--      (PDV bloqueado, escrita bloqueada), reconciliado por RPC.
--   4. Escreta (produtos/categorias/movimentos) bloqueada para tenant suspenso.
--   5. Signup com e-mail da whitelist dev => conta dev automaticamente.
-- Idempotente. Rodar no SQL Editor (ou via Management API).
-- ============================================================================

-- ---------- 0. Constante de e-mails da equipe JR (dev) -----------------------
-- Contas com estes e-mails nascem como 'dev' com acesso total e ilimitado.
create or replace function public.dev_emails() returns text[]
language sql immutable as $$
  select array[
    'jrsistemasetecnologia.br@gmail.com',
    'jrsistemasetecnologiabr@gmail.com'
  ];
$$;

-- ---------- 1. Papel dev em helpers de papel --------------------------------
create or replace function public.is_admin() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return coalesce(public.current_role_app() in ('admin','dev'), false);
end $$;

create or replace function public.is_staff() returns boolean  -- admin, gerente ou dev
language plpgsql stable security definer set search_path = public as $$
declare r text;
begin
  r := public.current_role_app();
  return coalesce(r in ('admin','gerente','dev'), false);
end $$;

-- ---------- 2. Billing OK? (tenant apto a OPERAR: vender/movimentar) ---------
create or replace function public.tenant_billing_ok() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare t uuid; st text; te timestamptz;
begin
  t := public.current_tenant_id();
  if t is null then return false; end if;
  select status, trial_ends_at into st, te from public.tenants where id = t;
  if st is null then return false; end if;
  if st = 'trialing' and te < now() then return false; end if;  -- trial vencido
  return st in ('trialing','active','past_due');
end $$;

-- ---------- 3. RPC de reconciliação de status (chamada pelo app) -------------
-- Virar trial vencido => read_only e devolver o retrato atual do billing.
-- A transição trialing→read_only com trial vencido é a ÚNICA mudança de status
-- permitida a um usuário autenticado (só suspende, nunca libera).
create or replace function public.billing_refresh_status() returns jsonb
language plpgsql security definer set search_path = public as $$
declare t uuid; st text; pid text; pc text; te timestamptz; nc timestamptz;
begin
  t := public.current_tenant_id();
  if t is null then raise exception 'UNAUTHORIZED'; end if;
  select status, plan_id, plan_cycle, trial_ends_at, next_charge_at
    into st, pid, pc, te, nc
    from public.tenants where id = t for update;
  if st = 'trialing' and te < now() then
    update public.tenants set status = 'read_only', updated_at = now() where id = t;
    st := 'read_only';
    insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
    values (t, auth.uid(), (select nome from public.users where id = auth.uid()),
            'assinatura.suspensa', 'tenant', t::text, 'teste grátis encerrado (14 dias) — modo leitura');
  end if;
  return jsonb_build_object('status', st, 'planId', pid, 'planCycle', pc,
                            'trialEndsAt', te, 'nextChargeAt', nc);
end $$;
grant execute on function public.billing_refresh_status() to authenticated;

-- ---------- 4. GUARD: colunas de cobrança só via service role/Edge -----------
-- Sem isto, um admin de loja poderia PATCHar trial_ends_at/status direto no
-- PostgREST e renovar o teste grátis infinitamente.
create or replace function public.guard_tenants_billing() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;  -- service role / SQL Editor

  -- transição automática de expiração (só suspende, nunca libera): permitida
  if old.status = 'trialing' and new.status = 'read_only'
     and old.trial_ends_at < now()
     and new.trial_ends_at = old.trial_ends_at
     and new.plan_id is not distinct from old.plan_id then
    return new;
  end if;

  if new.status                is distinct from old.status
     or new.plan_id            is distinct from old.plan_id
     or new.plan_cycle         is distinct from old.plan_cycle
     or new.scheduled_plan     is distinct from old.scheduled_plan
     or new.trial_ends_at      is distinct from old.trial_ends_at
     or new.next_charge_at     is distinct from old.next_charge_at
     or new.started_at         is distinct from old.started_at
     or new.canceled_at        is distinct from old.canceled_at
     or new.cancel_reason      is distinct from old.cancel_reason
     or new.stripe_customer_id is distinct from old.stripe_customer_id
     or new.stripe_subscription_id is distinct from old.stripe_subscription_id
     or new.deletion_requested_at  is distinct from old.deletion_requested_at then
    raise exception 'FORBIDDEN'
      using hint = 'Colunas de cobrança (status/plano/trial) são gerenciadas pelo servidor.';
  end if;
  return new;
end $$;
drop trigger if exists trg_tenants_billing_guard on public.tenants;
create trigger trg_tenants_billing_guard before update on public.tenants
  for each row execute function public.guard_tenants_billing();

-- ---------- 5. Policies de escrita exigem billing OK -------------------------
alter table public.categories     enable row level security;
alter table public.products       enable row level security;
alter table public.stock_movements enable row level security;
alter table public.sales          enable row level security;

drop policy if exists cat_wr on public.categories;
create policy cat_wr on public.categories for all
  using (tenant_id = public.current_tenant_id() and public.is_staff() and public.tenant_billing_ok())
  with check (tenant_id = public.current_tenant_id() and public.is_staff() and public.tenant_billing_ok());

drop policy if exists prod_wr on public.products;
create policy prod_wr on public.products for insert
  with check (tenant_id = public.current_tenant_id() and public.is_staff() and public.tenant_billing_ok());

drop policy if exists prod_upd on public.products;
create policy prod_upd on public.products for update
  using (tenant_id = public.current_tenant_id() and public.is_staff() and public.tenant_billing_ok())
  with check (tenant_id = public.current_tenant_id() and public.is_staff() and public.tenant_billing_ok());

drop policy if exists mov_wr on public.stock_movements;
create policy mov_wr on public.stock_movements for insert
  with check (tenant_id = public.current_tenant_id() and public.is_staff() and public.tenant_billing_ok());

drop policy if exists sale_ins on public.sales;
create policy sale_ins on public.sales for insert
  with check (tenant_id = public.current_tenant_id() and user_id = auth.uid() and public.tenant_billing_ok());

-- dev também administra o próprio tenant (RLS de tenants/users/auditoria)
drop policy if exists ten_upd on public.tenants;
create policy ten_upd on public.tenants for update
  using (public.is_admin()) with check (id = public.current_tenant_id());

drop policy if exists usr_upd on public.users;
create policy usr_upd on public.users for update
  using (tenant_id = public.current_tenant_id() and public.is_admin())
  with check (tenant_id = public.current_tenant_id());

drop policy if exists aud_sel on public.audit_logs;
create policy aud_sel on public.audit_logs for select
  using (tenant_id = public.current_tenant_id() and public.is_staff());

drop policy if exists inv_sel on public.invoices;
create policy inv_sel on public.invoices for select
  using (tenant_id = public.current_tenant_id() and public.is_admin());

drop policy if exists subev_sel on public.subscription_events;
create policy subev_sel on public.subscription_events for select
  using (tenant_id = public.current_tenant_id() and public.is_admin());

drop policy if exists delreq_sel on public.account_deletion_requests;
create policy delreq_sel on public.account_deletion_requests for select
  using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------- 6. RPCs de negócio: expiração de trial checada no servidor -------
create or replace function public.commit_sale(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t uuid := public.current_tenant_id();
  u uuid := auth.uid();
  r text := public.current_role_app();
  st_status text; st_plan text; cfg jsonb; item jsonb; prow products%rowtype;
  q numeric(14,3); lim numeric;
  v_sub numeric(12,2) := 0; v_disc numeric(12,2) := 0; v_total numeric(12,2);
  v_pago numeric(12,2) := 0; v_numero text; v_id uuid;
  pay jsonb; arr jsonb := '[]'::jsonb; parr jsonb := '[]'::jsonb;
begin
  if t is null or u is null then raise exception 'UNAUTHORIZED'; end if;
  perform public.billing_refresh_status();   -- vira trial vencido em read_only
  select status, plan_id, config into st_status, st_plan, cfg from public.tenants where id = t for update;
  if st_status not in ('trialing','active','past_due') then
    if st_plan is null then raise exception 'TRIAL_EXPIRED'; end if;
    raise exception 'BILLING_BLOCKED';
  end if;
  if coalesce(jsonb_array_length(p->'items'),0) = 0 then raise exception 'EMPTY_CART'; end if;

  for item in select * from jsonb_array_elements(p->'items') loop
    select * into prow from public.products
     where id = (item->>'productId')::uuid and tenant_id = t and ativo for update;
    if not found then raise exception 'PROD_OFF'; end if;
    q := (item->>'qtd')::numeric(14,3);
    if q <= 0 then raise exception 'VALIDATION'; end if;
    if coalesce((cfg->>'permiteEstoqueNegativo')::boolean,false) is false and q > prow.estoque_atual
      then raise exception 'NO_STOCK'; end if;
    v_sub := v_sub + prow.preco_venda * q;
    arr := arr || jsonb_build_object('productId', prow.id, 'nome', prow.nome, 'un', prow.unidade,
             'qtd', q, 'preco', prow.preco_venda, 'subtotal', round(prow.preco_venda * q, 2));
  end loop;
  v_sub := round(v_sub, 2);

  if coalesce(p->'discount'->>'tipo','R$') = '%' then
    v_disc := round(v_sub * coalesce((p->'discount'->>'valor')::numeric, 0) / 100, 2);
  else
    v_disc := round(coalesce((p->'discount'->>'valor')::numeric, 0), 2);
  end if;
  v_disc := least(greatest(v_disc, 0), v_sub);
  lim := coalesce((cfg->>'descontoCaixaPct')::numeric, 10);
  if r = 'caixa' and v_sub > 0 and (v_disc / v_sub) * 100 > lim + 0.001 then raise exception 'DISCOUNT_LIMIT'; end if;
  v_total := round(v_sub - v_disc, 2);

  for pay in select * from jsonb_array_elements(coalesce(p->'payments','[]'::jsonb)) loop
    if coalesce((pay->>'valor')::numeric, 0) > 0 then
      if coalesce(pay->>'forma','') not in ('pix','credito','debito','dinheiro') then raise exception 'VALIDATION'; end if;
      v_pago := v_pago + (pay->>'valor')::numeric;
      parr := parr || jsonb_build_object('forma', pay->>'forma', 'valor', round((pay->>'valor')::numeric, 2));
    end if;
  end loop;
  if abs(v_pago - v_total) > 0.011 then raise exception 'PAY_MISMATCH'; end if;

  v_numero := public.next_sale_numero(t);
  insert into public.sales (tenant_id, numero, user_id, subtotal, desconto, desconto_tipo, total)
  values (t, v_numero, u, v_sub, v_disc, coalesce(p->'discount'->>'tipo','R$'), v_total)
  returning id into v_id;

  insert into public.sale_items (sale_id, product_id, nome_snapshot, unidade, qtd, preco_unitario, subtotal)
  select v_id, (x->>'productId')::uuid, x->>'nome', x->>'un', (x->>'qtd')::numeric,
         (x->>'preco')::numeric, (x->>'subtotal')::numeric
    from jsonb_array_elements(arr) x;

  insert into public.sale_payments (sale_id, forma, valor)
  select v_id, x->>'forma', (x->>'valor')::numeric from jsonb_array_elements(parr) x;

  update public.products pr
     set estoque_atual = pr.estoque_atual - (x->>'qtd')::numeric,
         updated_at = now()
    from jsonb_array_elements(arr) x
   where pr.id = (x->>'productId')::uuid;

  insert into public.stock_movements (tenant_id, product_id, tipo, qtd, user_id, origem)
  select t, (x->>'productId')::uuid, 'saida', (x->>'qtd')::numeric, u, v_numero
    from jsonb_array_elements(arr) x;

  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (t, u, (select nome from public.users where id = u),
          'venda.concluida', 'sale', v_id::text, v_numero || ' · R$ ' || v_total::text);

  return jsonb_build_object('id', v_id, 'numero', v_numero, 'subtotal', v_sub, 'desconto', v_disc,
          'total', v_total, 'itens', arr, 'pagamentos', parr, 'at', now(),
          'userName', (select nome from public.users where id = u));
end $$;

create or replace function public.stock_entry(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t uuid := public.current_tenant_id(); u uuid := auth.uid();
  prow products%rowtype; q numeric(14,3); c numeric(12,2);
  st_status text; st_plan text;
begin
  if not public.is_staff() then raise exception 'FORBIDDEN'; end if;
  perform public.billing_refresh_status();
  select status, plan_id into st_status, st_plan from public.tenants where id = t for update;
  if st_status not in ('trialing','active','past_due') then
    if st_plan is null then raise exception 'TRIAL_EXPIRED'; else raise exception 'BILLING_BLOCKED'; end if;
  end if;
  q := (p->>'qtd')::numeric(14,3);
  if q <= 0 then raise exception 'VALIDATION'; end if;
  select * into prow from public.products where id = (p->>'productId')::uuid and tenant_id = t for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  c := coalesce((p->>'custo')::numeric, 0);
  update public.products set
    estoque_atual = estoque_atual + q,
    preco_custo = case when c > 0 then c else preco_custo end,
    updated_at = now()
   where id = prow.id;
  insert into public.stock_movements (tenant_id, product_id, tipo, qtd, user_id, origem, obs)
  values (t, prow.id, 'entrada', q, u,
          trim(coalesce('Compra' || case when coalesce(p->>'fornecedor','')='' then '' else ' · Fornecedor: '||(p->>'fornecedor') end || case when coalesce(p->>'nf','')='' then '' else ' · NF '||(p->>'nf') end, 'Compra')),
          coalesce(p->>'note',''));
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (t, u, (select nome from public.users where id = u), 'estoque.entrada', 'product', prow.id::text, '+' || q::text || ' ' || prow.unidade);
  return jsonb_build_object('estoque', (select estoque_atual from public.products where id = prow.id));
end $$;

create or replace function public.stock_adjust(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t uuid := public.current_tenant_id(); u uuid := auth.uid();
  prow products%rowtype; d numeric(14,3); novo numeric(14,3); cfg jsonb;
  st_status text; st_plan text;
begin
  if not public.is_staff() then raise exception 'FORBIDDEN'; end if;
  perform public.billing_refresh_status();
  select status, plan_id into st_status, st_plan from public.tenants where id = t for update;
  if st_status not in ('trialing','active','past_due') then
    if st_plan is null then raise exception 'TRIAL_EXPIRED'; else raise exception 'BILLING_BLOCKED'; end if;
  end if;
  d := (p->>'delta')::numeric(14,3);
  if d = 0 or coalesce(p->>'reason','') = '' then raise exception 'VALIDATION'; end if;
  select * into prow from public.products where id = (p->>'productId')::uuid and tenant_id = t for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  select config into cfg from public.tenants where id = t;
  novo := prow.estoque_atual + d;
  if novo < 0 and coalesce((cfg->>'permiteEstoqueNegativo')::boolean,false) is false then raise exception 'STOCK_NEG'; end if;
  update public.products set estoque_atual = novo, updated_at = now() where id = prow.id;
  insert into public.stock_movements (tenant_id, product_id, tipo, qtd, user_id, origem, obs)
  values (t, prow.id, 'ajuste', d, u, p->>'reason', coalesce(p->>'note',''));
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (t, u, (select nome from public.users where id = u), 'estoque.ajuste', 'product', prow.id::text, d::text || ' ' || prow.unidade || ' (' || (p->>'reason') || ')');
  return jsonb_build_object('estoque', novo);
end $$;

grant execute on function public.commit_sale(jsonb)   to authenticated;
grant execute on function public.stock_entry(jsonb)   to authenticated;
grant execute on function public.stock_adjust(jsonb)  to authenticated;

-- cancelamento de venda também liberado para dev (is_admin inclui 'dev')
create or replace function public.cancel_sale(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t uuid := public.current_tenant_id(); u uuid := auth.uid();
  v sales%rowtype; it record;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  if coalesce(p->>'reason','') = '' then raise exception 'VALIDATION'; end if;
  select * into v from public.sales where id = (p->>'id')::uuid and tenant_id = t for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if v.status = 'cancelada' then raise exception 'ALREADY'; end if;
  update public.sales set status='cancelada', motivo_cancelamento = p->>'reason', canceled_at = now(), updated_at = now() where id = v.id;
  for it in select * from public.sale_items where sale_id = v.id loop
    update public.products set estoque_atual = estoque_atual + it.qtd, updated_at = now() where id = it.product_id;
    insert into public.stock_movements (tenant_id, product_id, tipo, qtd, user_id, origem, obs)
    values (t, it.product_id, 'venda_cancelada', it.qtd, u, v.numero, 'Motivo: ' || (p->>'reason'));
  end loop;
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (t, u, (select nome from public.users where id = u), 'venda.cancelada', 'sale', v.id::text, v.numero || ' · ' || (p->>'reason'));
  return jsonb_build_object('ok', true);
end $$;
grant execute on function public.cancel_sale(jsonb) to authenticated;

-- ---------- 7. handle_new_user v3: whitelist dev -----------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare t uuid; seg text; inv record;
begin
  seg := coalesce(new.raw_user_meta_data->>'segmento', 'outro');

  -- Fluxo 1: convite de equipe (token validado contra user_invites)
  if coalesce(new.raw_user_meta_data->>'invite_token','') <> '' then
    select * into inv from public.user_invites
     where token = (new.raw_user_meta_data->>'invite_token')::uuid
       and lower(email) = lower(new.email)
       and accepted_at is null and revoked_at is null
       and expires_at > now()
     order by created_at desc limit 1;
    if found then
      insert into public.users (id, tenant_id, nome, email, papel)
      values (new.id, inv.tenant_id,
              coalesce(nullif(new.raw_user_meta_data->>'nome',''), inv.nome, 'Convidado'),
              new.email, inv.papel)
      on conflict (id) do nothing;
      update public.user_invites set accepted_at = now() where id = inv.id;
      insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
      values (inv.tenant_id, new.id, coalesce(nullif(new.raw_user_meta_data->>'nome',''), inv.nome),
              'usuario.aceitou_convite', 'user', new.id::text, 'papel: ' || inv.papel);
      return new;
    end if;
    -- token inválido/expirado → cai no fluxo normal (novo tenant)
  end if;

  -- Fluxo 2: e-mail da equipe JR Sistemas → conta DEV (tudo liberado, sem prazo)
  if lower(new.email) = any (public.dev_emails()) then
    insert into public.tenants (nome, segmento, status, plan_id, plan_cycle, trial_ends_at)
    values ('JR Sistemas e Tecnologia', seg, 'active', 'dev', 'mensal', now() + interval '200 years')
    returning id into t;
    insert into public.users (id, tenant_id, nome, email, papel)
    values (new.id, t, coalesce(nullif(new.raw_user_meta_data->>'nome',''), 'JR Sistemas'), new.email, 'dev')
    on conflict (id) do nothing;
    perform public.seed_categories(t, seg);
    insert into public.tenant_counters (tenant_id) values (t) on conflict do nothing;
    insert into public.support_ticket_counters (tenant_id) values (t) on conflict do nothing;
    insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
    values (t, new.id, coalesce(new.raw_user_meta_data->>'nome',''), 'conta.criada', 'tenant', t::text,
            'conta DEV (equipe JR Sistemas) — acesso ilimitado');
    return new;
  end if;

  -- Fluxo 3: signup normal → novo tenant + admin + trial de 14 dias (único)
  insert into public.tenants (nome, segmento)
  values (coalesce(new.raw_user_meta_data->>'loja', 'Minha Loja'), seg)
  returning id into t;
  insert into public.users (id, tenant_id, nome, email, papel)
  values (new.id, t, coalesce(new.raw_user_meta_data->>'nome', 'Administrador'), new.email, 'admin')
  on conflict (id) do nothing;
  perform public.seed_categories(t, seg);
  insert into public.tenant_counters (tenant_id) values (t) on conflict do nothing;
  insert into public.support_ticket_counters (tenant_id) values (t) on conflict do nothing;
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (t, new.id, coalesce(new.raw_user_meta_data->>'nome',''), 'conta.criada', 'tenant', t::text, 'signup via Supabase Auth — trial 14 dias');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 8. CORREÇÃO DE DADOS: contas dev existentes ----------------------
-- A conta criada pelo dono (jrsistemasetecnologiabr@gmail.com) e a conta dev
-- original viram 'dev' com tenant ilimitado (plano 'dev', trial +200 anos).
update public.users
   set papel = 'dev', updated_at = now()
 where lower(email) = any (public.dev_emails())
   and papel <> 'dev';

update public.tenants t
   set status = 'active',
       plan_id = 'dev',
       plan_cycle = 'mensal',
       next_charge_at = null,
       canceled_at = null,
       cancel_reason = '',
       trial_ends_at = now() + interval '200 years',
       updated_at = now()
 where exists (select 1 from public.users u
                where u.tenant_id = t.id and lower(u.email) = any (public.dev_emails()));
