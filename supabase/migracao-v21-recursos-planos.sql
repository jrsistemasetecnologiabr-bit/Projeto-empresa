-- LojaCerta · migração v21 — recursos dos planos Profissional/Premium (aplicada)
--   Profissional+: clientes, venda no fiado, contas a receber/pagar, orçamentos
--   Premium:       + multi-loja, NFC-e/NF-e (via emissor Focus NFe)
-- Teste grátis e conta dev: tudo liberado. Essencial: só o núcleo (PDV/estoque).
-- Idempotente.

-- =====================================================================
-- 0 · Liberação por plano (fonte única no banco; o front espelha)
-- =====================================================================
create or replace function public.plan_has_t(p_tenant uuid, p_feature text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
      when t.plan_id = 'dev' then true
      when t.status = 'trialing' then true
      when p_feature in ('clientes','fiado','financeiro','orcamentos')
        then t.plan_id in ('profissional','premium')
      when p_feature in ('multiloja','fiscal')
        then t.plan_id = 'premium'
      else false end
    from public.tenants t where t.id = p_tenant), false)
$$;
create or replace function public.plan_has(p_feature text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.plan_has_t(public.current_tenant_id(), p_feature)
$$;
revoke all on function public.plan_has_t(uuid, text) from public, anon, authenticated;
revoke all on function public.plan_has(text) from public, anon;
grant execute on function public.plan_has(text) to authenticated;

-- =====================================================================
-- 1 · Clientes
-- =====================================================================
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  nome text not null check (length(trim(nome)) >= 2),
  documento text not null default '',          -- CPF/CNPJ (só dígitos)
  ie text not null default '',
  telefone text not null default '',
  email text not null default '',
  logradouro text not null default '', numero text not null default '', bairro text not null default '',
  municipio text not null default '', uf text not null default '', cep text not null default '',
  limite_credito numeric(12,2) not null default 0 check (limite_credito >= 0),
  obs text not null default '',
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customers_tenant_idx on public.customers(tenant_id, nome);
alter table public.customers enable row level security;
drop policy if exists cust_sel on public.customers;
create policy cust_sel on public.customers for select using (tenant_id = (select public.current_tenant_id()));
drop policy if exists cust_ins on public.customers;
create policy cust_ins on public.customers for insert with check (tenant_id = (select public.current_tenant_id()) and public.tenant_billing_ok() and public.plan_has('clientes'));
drop policy if exists cust_upd on public.customers;
create policy cust_upd on public.customers for update using (tenant_id = (select public.current_tenant_id()) and public.tenant_billing_ok() and public.plan_has('clientes'))
  with check (tenant_id = (select public.current_tenant_id()));
drop trigger if exists trg_touch_customers on public.customers;
create trigger trg_touch_customers before update on public.customers for each row execute function public.touch_updated_at();

-- =====================================================================
-- 2 · Contas a receber / a pagar
-- =====================================================================
create table if not exists public.receivables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  sale_id uuid references public.sales(id) on delete set null,
  descricao text not null default '',
  valor numeric(12,2) not null check (valor > 0),
  valor_pago numeric(12,2) not null default 0 check (valor_pago >= 0),
  vencimento date not null default (current_date + 30),
  status text not null default 'aberto' check (status in ('aberto','pago','cancelado')),
  pago_em timestamptz, forma_pagamento text not null default '',
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists recv_tenant_idx on public.receivables(tenant_id, status, vencimento);
create index if not exists recv_customer_idx on public.receivables(customer_id);
create index if not exists recv_sale_idx on public.receivables(sale_id);

create table if not exists public.payables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  fornecedor text not null default '',
  descricao text not null check (length(trim(descricao)) >= 2),
  categoria text not null default 'Outros',
  valor numeric(12,2) not null check (valor > 0),
  valor_pago numeric(12,2) not null default 0 check (valor_pago >= 0),
  vencimento date not null,
  status text not null default 'aberto' check (status in ('aberto','pago','cancelado')),
  pago_em timestamptz, forma_pagamento text not null default '',
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists pay_tenant_idx on public.payables(tenant_id, status, vencimento);

alter table public.receivables enable row level security;
alter table public.payables enable row level security;
drop policy if exists recv_sel on public.receivables;
create policy recv_sel on public.receivables for select using (tenant_id = (select public.current_tenant_id()));
drop policy if exists recv_ins on public.receivables;
create policy recv_ins on public.receivables for insert with check (tenant_id = (select public.current_tenant_id()) and public.is_staff() and public.tenant_billing_ok() and public.plan_has('financeiro'));
drop policy if exists pay_sel on public.payables;
create policy pay_sel on public.payables for select using (tenant_id = (select public.current_tenant_id()) and public.is_staff());
drop policy if exists pay_ins on public.payables;
create policy pay_ins on public.payables for insert with check (tenant_id = (select public.current_tenant_id()) and public.is_staff() and public.tenant_billing_ok() and public.plan_has('financeiro'));
-- baixa/cancelamento só pela RPC fin_settle (regras de valor/status no servidor)

create or replace function public.fin_settle(p jsonb)
returns jsonb language plpgsql security definer set search_path = 'public' as $$
declare
  t uuid := public.current_tenant_id(); kind text := p->>'kind'; rid uuid := (p->>'id')::uuid;
  v numeric(12,2) := round(coalesce((p->>'valor')::numeric, 0), 2); acao text := coalesce(p->>'acao','pagar');
  rec record;
begin
  if t is null then raise exception 'UNAUTHORIZED'; end if;
  if not public.is_staff() then raise exception 'FORBIDDEN'; end if;
  if not public.plan_has('financeiro') then raise exception 'Seu plano não inclui o financeiro (contas a pagar e receber). Faça upgrade em Assinatura.'; end if;
  if kind not in ('receber','pagar') then raise exception 'VALIDATION'; end if;
  if kind = 'receber' then
    select id, valor, valor_pago, status into rec from public.receivables where id = rid and tenant_id = t for update;
  else
    select id, valor, valor_pago, status into rec from public.payables where id = rid and tenant_id = t for update;
  end if;
  if not found then raise exception 'NOT_FOUND'; end if;
  if rec.status <> 'aberto' then raise exception 'Esta conta já está %.', rec.status; end if;
  if acao = 'cancelar' then
    if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
    if kind = 'receber' then update public.receivables set status = 'cancelado' where id = rid;
    else update public.payables set status = 'cancelado' where id = rid; end if;
  else
    if v <= 0 then v := rec.valor - rec.valor_pago; end if;
    if v > rec.valor - rec.valor_pago + 0.001 then raise exception 'O valor informado é maior que o saldo em aberto (R$ %).', rec.valor - rec.valor_pago; end if;
    if kind = 'receber' then
      update public.receivables set valor_pago = valor_pago + v, forma_pagamento = coalesce(p->>'forma',''),
        status = case when valor_pago + v >= valor - 0.001 then 'pago' else 'aberto' end,
        pago_em = case when valor_pago + v >= valor - 0.001 then now() else pago_em end
       where id = rid;
    else
      update public.payables set valor_pago = valor_pago + v, forma_pagamento = coalesce(p->>'forma',''),
        status = case when valor_pago + v >= valor - 0.001 then 'pago' else 'aberto' end,
        pago_em = case when valor_pago + v >= valor - 0.001 then now() else pago_em end
       where id = rid;
    end if;
  end if;
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes, origem)
  values (t, auth.uid(), (select nome from public.users where id = auth.uid()),
          'financeiro.' || acao, kind, rid::text, 'R$ ' || v::text, 'rpc');
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.fin_settle(jsonb) from public, anon;
grant execute on function public.fin_settle(jsonb) to authenticated;

-- =====================================================================
-- 3 · Orçamentos
-- =====================================================================
create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  numero text not null default '',
  customer_id uuid references public.customers(id) on delete set null,
  cliente_nome text not null default '',
  itens jsonb not null default '[]'::jsonb,       -- [{productId,nome,un,qtd,preco,subtotal}]
  subtotal numeric(12,2) not null default 0, desconto numeric(12,2) not null default 0, total numeric(12,2) not null default 0,
  validade date not null default (current_date + 7),
  status text not null default 'aberto' check (status in ('aberto','convertido','cancelado')),
  sale_id uuid references public.sales(id) on delete set null,
  obs text not null default '',
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists quotes_tenant_idx on public.quotes(tenant_id, created_at desc);
alter table public.quotes enable row level security;
drop policy if exists quo_sel on public.quotes;
create policy quo_sel on public.quotes for select using (tenant_id = (select public.current_tenant_id()));
drop policy if exists quo_ins on public.quotes;
create policy quo_ins on public.quotes for insert with check (tenant_id = (select public.current_tenant_id()) and public.tenant_billing_ok() and public.plan_has('orcamentos'));
drop policy if exists quo_upd on public.quotes;
create policy quo_upd on public.quotes for update using (tenant_id = (select public.current_tenant_id()) and public.tenant_billing_ok() and public.plan_has('orcamentos') and status = 'aberto')
  with check (tenant_id = (select public.current_tenant_id()) and status in ('aberto','cancelado'));

create or replace function public.quotes_numero()
returns trigger language plpgsql security definer set search_path = 'public' as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtext('quotes:' || new.tenant_id::text));
  select coalesce(max(nullif(regexp_replace(numero, '\D', '', 'g'), '')::int), 0) + 1 into n from public.quotes where tenant_id = new.tenant_id;
  new.numero := 'ORC-' || lpad(n::text, 6, '0');
  new.created_by := coalesce(new.created_by, auth.uid());
  -- totais recalculados no servidor a partir dos itens (preço atual do catálogo)
  select coalesce(jsonb_agg(jsonb_build_object('productId', pr.id, 'nome', pr.nome, 'un', pr.unidade,
           'qtd', (x->>'qtd')::numeric, 'preco', pr.preco_venda, 'subtotal', round(pr.preco_venda * (x->>'qtd')::numeric, 2))), '[]'::jsonb)
    into new.itens
    from jsonb_array_elements(new.itens) x join public.products pr on pr.id = (x->>'productId')::uuid and pr.tenant_id = new.tenant_id;
  if jsonb_array_length(new.itens) = 0 then raise exception 'Adicione ao menos um produto ao orçamento.'; end if;
  new.subtotal := (select coalesce(sum((x->>'subtotal')::numeric), 0) from jsonb_array_elements(new.itens) x);
  new.desconto := least(greatest(coalesce(new.desconto, 0), 0), new.subtotal);
  new.total := new.subtotal - new.desconto;
  return new;
end $$;
drop trigger if exists trg_quotes_numero on public.quotes;
create trigger trg_quotes_numero before insert on public.quotes for each row execute function public.quotes_numero();
revoke all on function public.quotes_numero() from public, anon, authenticated;

-- =====================================================================
-- 4 · Venda: cliente, fiado e conversão de orçamento (no MESMO commit)
-- =====================================================================
alter table public.sales add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.sale_payments drop constraint if exists sale_payments_forma_check;
alter table public.sale_payments add constraint sale_payments_forma_check check (forma in ('pix','credito','debito','dinheiro','fiado'));

create or replace function public.sale_post_hook(p_sale uuid, p_tenant uuid, p_user uuid, p jsonb, parr jsonb, p_numero text)
returns void language plpgsql security definer set search_path = 'public' as $$
declare
  cust uuid; fiado numeric(12,2); lim numeric(12,2); aberto numeric(12,2); c record; qid uuid;
begin
  begin cust := nullif(p->>'customerId', '')::uuid; exception when others then cust := null; end;
  if cust is not null then
    select id, nome, limite_credito, ativo into c from public.customers where id = cust and tenant_id = p_tenant;
    if not found or not c.ativo then raise exception 'Cliente não encontrado ou inativo.'; end if;
    update public.sales set customer_id = cust where id = p_sale;
  end if;

  select coalesce(sum((x->>'valor')::numeric), 0) into fiado from jsonb_array_elements(parr) x where x->>'forma' = 'fiado';
  if fiado > 0 then
    if not public.plan_has_t(p_tenant, 'fiado') then raise exception 'Seu plano não inclui venda no fiado. Faça upgrade para o Profissional em Assinatura.'; end if;
    if cust is null then raise exception 'Selecione o cliente para vender no fiado.'; end if;
    lim := c.limite_credito;
    if lim > 0 then
      select coalesce(sum(valor - valor_pago), 0) into aberto from public.receivables where customer_id = cust and status = 'aberto';
      if aberto + fiado > lim + 0.001 then
        raise exception 'Limite de crédito de % excedido: em aberto R$ %, limite R$ %.', c.nome, aberto, lim;
      end if;
    end if;
    insert into public.receivables (tenant_id, customer_id, sale_id, descricao, valor, vencimento, created_by)
    values (p_tenant, cust, p_sale, 'Fiado · ' || p_numero, fiado,
            coalesce(nullif(p->>'fiadoVencimento','')::date, current_date + 30), p_user);
  end if;

  begin qid := nullif(p->>'quoteId', '')::uuid; exception when others then qid := null; end;
  if qid is not null then
    update public.quotes set status = 'convertido', sale_id = p_sale where id = qid and tenant_id = p_tenant and status = 'aberto';
  end if;
end $$;
revoke all on function public.sale_post_hook(uuid, uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated;

do $$
declare def text; novo text;
begin
  def := pg_get_functiondef('public.commit_sale'::regproc);
  if position('sale_post_hook' in def) > 0 then return; end if;   -- já aplicado
  novo := replace(def, $q$not in ('pix','credito','debito','dinheiro') then raise exception 'VALIDATION'$q$,
                       $q$not in ('pix','credito','debito','dinheiro','fiado') then raise exception 'VALIDATION'$q$);
  novo := replace(novo, $q$  return jsonb_build_object('id', v_id, 'numero', v_numero,$q$,
                        $q$  perform public.sale_post_hook(v_id, t, u, p, parr, v_numero);
  return jsonb_build_object('id', v_id, 'numero', v_numero,$q$);
  if novo = def or position('sale_post_hook' in novo) = 0 or position($q$'dinheiro','fiado'$q$ in novo) = 0 then
    raise exception 'v21: âncoras de commit_sale não encontradas';
  end if;
  execute novo;
end $$;

-- venda cancelada → fiado em aberto daquela venda é cancelado; orçamento volta a aberto
create or replace function public.sales_cancel_cascade()
returns trigger language plpgsql security definer set search_path = 'public' as $$
begin
  if new.status = 'cancelada' and old.status <> 'cancelada' then
    update public.receivables set status = 'cancelado' where sale_id = new.id and status = 'aberto';
    update public.quotes set status = 'aberto', sale_id = null where sale_id = new.id and status = 'convertido';
  end if;
  return new;
end $$;
drop trigger if exists trg_sales_cancel_cascade on public.sales;
create trigger trg_sales_cancel_cascade after update of status on public.sales for each row execute function public.sales_cancel_cascade();
revoke all on function public.sales_cancel_cascade() from public, anon, authenticated;

-- =====================================================================
-- 5 · Multi-loja (Premium): lojas do mesmo dono compartilham assinatura
-- =====================================================================
alter table public.tenants add column if not exists group_id uuid references public.tenants(id) on delete cascade;

create table if not exists public.store_members (
  user_id uuid not null references public.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  papel text not null check (papel in ('admin','gerente','caixa','dev')),
  created_at timestamptz not null default now(),
  primary key (user_id, tenant_id)
);
create index if not exists store_members_tenant_idx on public.store_members(tenant_id);
alter table public.store_members enable row level security;
drop policy if exists sm_sel on public.store_members;
create policy sm_sel on public.store_members for select using (user_id = (select auth.uid()));
insert into public.store_members (user_id, tenant_id, papel)
select id, tenant_id, papel from public.users on conflict do nothing;

create or replace function public.users_membership_sync()
returns trigger language plpgsql security definer set search_path = 'public' as $$
begin
  insert into public.store_members (user_id, tenant_id, papel) values (new.id, new.tenant_id, new.papel)
  on conflict (user_id, tenant_id) do update set papel = excluded.papel;
  return new;
end $$;
drop trigger if exists trg_users_membership on public.users;
create trigger trg_users_membership after insert or update of papel, tenant_id on public.users
  for each row execute function public.users_membership_sync();
revoke all on function public.users_membership_sync() from public, anon, authenticated;

-- trava de integridade: troca de loja só pela RPC store_switch
do $$
declare def text; novo text;
begin
  def := pg_get_functiondef('public.guard_users_integrity'::regproc);
  if position('app.store_switch' in def) > 0 then return; end if;
  novo := replace(def, 'if auth.uid() is null then return new; end if;',
    'if auth.uid() is null then return new; end if;
  if current_setting(''app.store_switch'', true) = ''on'' and new.id = old.id and new.email = old.email then return new; end if;');
  if novo = def then raise exception 'v21: âncora de guard_users_integrity não encontrada'; end if;
  execute novo;
end $$;

-- trava de cobrança: sincronização de plano entre lojas do grupo é interna
do $$
declare def text; novo text;
begin
  def := pg_get_functiondef('public.guard_tenants_billing'::regproc);
  if position('app.billing_sync' in def) > 0 then return; end if;
  novo := replace(def, 'if auth.uid() is null then return new; end if;',
    'if auth.uid() is null then return new; end if;
  if current_setting(''app.billing_sync'', true) = ''on'' then return new; end if;');
  if novo = def then raise exception 'v21: âncora de guard_tenants_billing não encontrada'; end if;
  execute novo;
end $$;

-- plano/status da loja principal vale para as filiais (uma assinatura Premium)
create or replace function public.tenants_group_sync()
returns trigger language plpgsql security definer set search_path = 'public' as $$
begin
  if new.group_id is null and (
       new.status is distinct from old.status or new.plan_id is distinct from old.plan_id
    or new.plan_cycle is distinct from old.plan_cycle or new.plan_expires_at is distinct from old.plan_expires_at
    or new.next_charge_at is distinct from old.next_charge_at or new.trial_ends_at is distinct from old.trial_ends_at) then
    perform set_config('app.billing_sync', 'on', true);
    update public.tenants set status = new.status, plan_id = new.plan_id, plan_cycle = new.plan_cycle,
           plan_expires_at = new.plan_expires_at, next_charge_at = new.next_charge_at, trial_ends_at = new.trial_ends_at
     where group_id = new.id;
    perform set_config('app.billing_sync', 'off', true);
  end if;
  return new;
end $$;
drop trigger if exists trg_tenants_group_sync on public.tenants;
create trigger trg_tenants_group_sync after update on public.tenants for each row execute function public.tenants_group_sync();
revoke all on function public.tenants_group_sync() from public, anon, authenticated;

create or replace function public.store_list()
returns jsonb language sql stable security definer set search_path = 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'nome', t.nome, 'papel', m.papel,
           'principal', t.group_id is null, 'atual', t.id = public.current_tenant_id()) order by (t.group_id is not null), t.created_at), '[]'::jsonb)
    from public.store_members m join public.tenants t on t.id = m.tenant_id
   where m.user_id = auth.uid()
$$;

create or replace function public.store_create(p jsonb)
returns jsonb language plpgsql security definer set search_path = 'public' as $$
declare
  cur uuid := public.current_tenant_id(); root public.tenants%rowtype; nid uuid; nm text := trim(coalesce(p->>'nome',''));
begin
  if cur is null then raise exception 'UNAUTHORIZED'; end if;
  if public.current_role_app() not in ('admin','dev') then raise exception 'FORBIDDEN'; end if;
  if not public.plan_has('multiloja') then raise exception 'Multi-loja faz parte do plano Premium. Faça upgrade em Assinatura.'; end if;
  if length(nm) < 2 then raise exception 'Informe o nome da nova loja.'; end if;
  select * into root from public.tenants where id = coalesce((select group_id from public.tenants where id = cur), cur);
  if not public.tenant_billing_ok() then raise exception 'BILLING_BLOCKED'; end if;
  insert into public.tenants (nome, segmento, status, plan_id, plan_cycle, plan_expires_at, next_charge_at,
                              trial_ends_at, trial_pending, config, group_id, cnpj, endereco, telefone)
  values (nm, root.segmento, root.status, root.plan_id, root.plan_cycle, root.plan_expires_at, root.next_charge_at,
          root.trial_ends_at, false, root.config, root.id, coalesce(p->>'cnpj',''), coalesce(p->>'endereco',''), coalesce(p->>'telefone',''))
  returning id into nid;
  perform public.seed_categories(nid, root.segmento);
  insert into public.tenant_counters (tenant_id) values (nid) on conflict do nothing;
  insert into public.support_ticket_counters (tenant_id) values (nid) on conflict do nothing;
  insert into public.store_members (user_id, tenant_id, papel) values (auth.uid(), nid, 'admin') on conflict do nothing;
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes, origem)
  values (cur, auth.uid(), (select nome from public.users where id = auth.uid()), 'loja.criada', 'tenant', nid::text, nm, 'rpc');
  return jsonb_build_object('id', nid, 'nome', nm);
end $$;

create or replace function public.store_switch(p jsonb)
returns jsonb language plpgsql security definer set search_path = 'public' as $$
declare target uuid := (p->>'id')::uuid; m record;
begin
  if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
  select * into m from public.store_members where user_id = auth.uid() and tenant_id = target;
  if not found then raise exception 'FORBIDDEN'; end if;
  perform set_config('app.store_switch', 'on', true);
  update public.users set tenant_id = target, papel = m.papel, updated_at = now() where id = auth.uid();
  perform set_config('app.store_switch', 'off', true);
  return jsonb_build_object('ok', true, 'tenantId', target);
end $$;

create or replace function public.group_summary(p_days int default 30)
returns jsonb language sql stable security definer set search_path = 'public' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'nome', t.nome,
     'vendas', (select count(*) from public.sales s where s.tenant_id = t.id and s.status = 'concluida' and s.created_at >= now() - make_interval(days => greatest(p_days,1))),
     'faturamento', (select coalesce(sum(total),0) from public.sales s where s.tenant_id = t.id and s.status = 'concluida' and s.created_at >= now() - make_interval(days => greatest(p_days,1))),
     'abaixoMinimo', (select count(*) from public.products pr where pr.tenant_id = t.id and pr.ativo and pr.estoque_atual <= pr.estoque_minimo),
     'receberAberto', (select coalesce(sum(valor - valor_pago),0) from public.receivables r where r.tenant_id = t.id and r.status = 'aberto')
   ) order by t.created_at), '[]'::jsonb)
  from public.store_members m join public.tenants t on t.id = m.tenant_id
  where m.user_id = auth.uid() and m.papel in ('admin','gerente','dev')
$$;
revoke all on function public.store_list() from public, anon;
revoke all on function public.store_create(jsonb) from public, anon;
revoke all on function public.store_switch(jsonb) from public, anon;
revoke all on function public.group_summary(int) from public, anon;
grant execute on function public.store_list(), public.store_create(jsonb), public.store_switch(jsonb), public.group_summary(int) to authenticated;

-- =====================================================================
-- 6 · Fiscal (NFC-e / NF-e via Focus NFe) — Premium
-- =====================================================================
alter table public.products add column if not exists ncm text not null default '';
alter table public.products add column if not exists cfop text not null default '5102';
alter table public.products add column if not exists cest text not null default '';
alter table public.products add column if not exists csosn text not null default '102';
alter table public.products add column if not exists origem smallint not null default 0;

create table if not exists public.fiscal_config (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  provider text not null default 'focusnfe',
  ambiente text not null default 'homologacao' check (ambiente in ('homologacao','producao')),
  token text not null default '',                 -- NUNCA exposto ao navegador (sem policy de select)
  auto_emitir boolean not null default false,
  regime smallint not null default 1,             -- 1 Simples Nacional
  updated_at timestamptz not null default now()
);
alter table public.fiscal_config enable row level security;   -- deny-all p/ clientes; Edge usa service role

create table if not exists public.fiscal_docs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  sale_id uuid references public.sales(id) on delete set null,
  modelo text not null check (modelo in ('nfce','nfe')),
  ref text not null unique,
  status text not null default 'processando',     -- processando | autorizado | erro | cancelado
  numero text not null default '', serie text not null default '', chave text not null default '',
  danfe_url text not null default '', xml_url text not null default '',
  mensagem text not null default '', ambiente text not null default 'homologacao',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists fiscal_docs_tenant_idx on public.fiscal_docs(tenant_id, created_at desc);
create index if not exists fiscal_docs_sale_idx on public.fiscal_docs(sale_id);
alter table public.fiscal_docs enable row level security;
drop policy if exists fd_sel on public.fiscal_docs;
create policy fd_sel on public.fiscal_docs for select using (tenant_id = (select public.current_tenant_id()));

create or replace function public.fiscal_config_get()
returns jsonb language sql stable security definer set search_path = 'public' as $$
  select jsonb_build_object('ambiente', coalesce(f.ambiente, 'homologacao'), 'autoEmitir', coalesce(f.auto_emitir, false),
                            'regime', coalesce(f.regime, 1), 'hasToken', coalesce(f.token, '') <> '',
                            'liberado', public.plan_has('fiscal'))
    from (select 1) x left join public.fiscal_config f on f.tenant_id = public.current_tenant_id()
$$;
create or replace function public.fiscal_config_set(p jsonb)
returns jsonb language plpgsql security definer set search_path = 'public' as $$
declare t uuid := public.current_tenant_id();
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  if not public.plan_has('fiscal') then raise exception 'Emissão de NFC-e/NF-e faz parte do plano Premium. Faça upgrade em Assinatura.'; end if;
  insert into public.fiscal_config (tenant_id, ambiente, auto_emitir, regime, token)
  values (t, coalesce(p->>'ambiente','homologacao'), coalesce((p->>'autoEmitir')::boolean, false),
          coalesce((p->>'regime')::smallint, 1), coalesce(nullif(trim(p->>'token'),''), ''))
  on conflict (tenant_id) do update set
    ambiente = excluded.ambiente, auto_emitir = excluded.auto_emitir, regime = excluded.regime,
    token = case when coalesce(nullif(trim(p->>'token'),''), '') = '' then public.fiscal_config.token else excluded.token end,
    updated_at = now();
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes, origem)
  values (t, auth.uid(), (select nome from public.users where id = auth.uid()), 'fiscal.configurado', 'tenant', t::text,
          'ambiente ' || coalesce(p->>'ambiente','homologacao'), 'rpc');
  return public.fiscal_config_get();
end $$;
revoke all on function public.fiscal_config_get() from public, anon;
revoke all on function public.fiscal_config_set(jsonb) from public, anon;
grant execute on function public.fiscal_config_get(), public.fiscal_config_set(jsonb) to authenticated;
