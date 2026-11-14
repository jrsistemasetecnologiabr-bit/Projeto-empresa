-- ============================================================================
-- LojaCerta · SETUP COMPLETO SUPABASE (set/2026 · Postgres 17 · RLS-first)
-- ----------------------------------------------------------------------------
-- COMO USAR: Supabase Dashboard → SQL Editor → cole TUDO → Run.
-- Idempotente: pode rodar de novo sem duplicar nada.
-- Depois do SQL: veja o checklist de Authentication/Storage no final do arquivo.
-- NUNCA coloque service_role_key em cliente/front — só nos secrets das Functions.
-- ============================================================================

-- ---------- 0. EXTENSÕES ----------------------------------------------------
create extension if not exists pg_trgm;  -- busca textual rápida (GIN) em produtos

-- ---------- 1. HELPERS DE SESSÃO (security definer, search_path fixo) -------
-- plpgsql (não language sql): o corpo NÃO é validado na criação,
-- permitindo criar os helpers antes das tabelas sem erro 42P01.
create or replace function public.current_tenant_id() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  return (select tenant_id from public.users where id = auth.uid() limit 1);
end $$;

create or replace function public.current_role_app() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  return (select papel from public.users where id = auth.uid() limit 1);
end $$;

create or replace function public.is_admin() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return coalesce(public.current_role_app() = 'admin', false);
end $$;

create or replace function public.is_staff() returns boolean  -- admin ou gerente
language plpgsql stable security definer set search_path = public as $$
begin
  return coalesce(public.current_role_app() in ('admin','gerente'), false);
end $$;

-- ---------- 2. TABELAS -------------------------------------------------------
create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  segmento text not null default 'outro',
  cnpj text default '', endereco text default '', telefone text default '',
  status text not null default 'trialing'
    check (status in ('trialing','active','past_due','read_only','canceled')),
  trial_ends_at timestamptz not null default (now() + interval '14 days'),
  trial_warned boolean not null default false,
  trial_pending boolean not null default false,  -- v5: true = aguardando confirmação de e-mail
  plan_id text, plan_cycle text default 'mensal', scheduled_plan text,
  started_at timestamptz, next_charge_at timestamptz,
  canceled_at timestamptz, cancel_reason text default '',
  deletion_requested_at timestamptz,
  stripe_customer_id text, stripe_subscription_id text,
  config jsonb not null default '{"descontoCaixaPct":10,"permiteEstoqueNegativo":false,"reciboMsg":"Obrigado pela preferência!"}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  nome text not null,
  email text not null unique,
  papel text not null default 'operador' check (papel in ('admin','gerente','operador','dev')),
  ativo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  nome text not null,
  unique (tenant_id, nome)
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  codigo text not null,
  nome text not null,
  category_id uuid references public.categories(id) on delete set null,
  unidade text not null default 'un',
  preco_custo numeric(12,2) not null default 0 check (preco_custo >= 0),
  preco_venda numeric(12,2) not null check (preco_venda > 0),
  estoque_atual numeric(14,3) not null default 0,
  estoque_minimo numeric(14,3) not null default 0,
  fornecedor text default '',
  ativo boolean not null default true,   -- soft delete: NUNCA dar DELETE em produto
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, codigo)
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  numero text not null,
  user_id uuid references public.users(id) on delete set null,
  subtotal numeric(12,2) not null check (subtotal >= 0),
  desconto numeric(12,2) not null default 0 check (desconto >= 0),
  desconto_tipo text not null default 'R$' check (desconto_tipo in ('R$','%')),
  total numeric(12,2) not null check (total >= 0),
  status text not null default 'concluida' check (status in ('concluida','cancelada')),
  motivo_cancelamento text default '', canceled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, numero)
);

create table if not exists public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  nome_snapshot text not null,
  unidade text not null,
  qtd numeric(14,3) not null check (qtd > 0),
  preco_unitario numeric(12,2) not null check (preco_unitario >= 0),
  subtotal numeric(12,2) not null check (subtotal >= 0)
);

create table if not exists public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  forma text not null check (forma in ('pix','credito','debito','dinheiro')),
  valor numeric(12,2) not null check (valor > 0),
  troco numeric(12,2) not null default 0
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  tipo text not null check (tipo in ('entrada','saida','ajuste','venda_cancelada')),
  qtd numeric(14,3) not null,
  user_id uuid references public.users(id) on delete set null,
  origem text default '', obs text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null default 'asaas',
  provider_id text,                      -- id da fatura/assinatura no gateway (idempotência)
  plan_id text not null, cycle text not null default 'mensal',
  valor numeric(12,2) not null,
  status text not null default 'pendente' check (status in ('pendente','pago','falhou','refundado')),
  metodo text, paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.subscription_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tipo text not null,
  provider text default '', provider_event_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid, user_name text default '',
  acao text not null, entidade text not null, entidade_id text,
  detalhes text default '',
  created_at timestamptz not null default now()
);

create table if not exists public.webhook_events (   -- idempotência de webhooks
  provider_event_id text primary key,
  tipo text not null, payload jsonb not null,
  processed_at timestamptz not null default now()
);

create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  grace_until timestamptz not null,
  executed_at timestamptz,
  cancelado boolean not null default false
);

create table if not exists public.tenant_counters (  -- numeração de vendas por tenant
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  sale_seq int not null default 0
);

-- ---------- 3. ÍNDICES -------------------------------------------------------
create index if not exists ix_users_tenant    on public.users(tenant_id);
create index if not exists ix_prod_tenant      on public.products(tenant_id, ativo);
create index if not exists ix_prod_code        on public.products(tenant_id, lower(codigo));
create index if not exists ix_prod_nome_trgm   on public.products using gin (nome gin_trgm_ops);
create index if not exists ix_sales_tenant     on public.sales(tenant_id, created_at desc);
create index if not exists ix_sales_user       on public.sales(user_id, created_at desc);
create index if not exists ix_items_sale       on public.sale_items(sale_id);
create index if not exists ix_items_product    on public.sale_items(product_id);
create index if not exists ix_pay_sale         on public.sale_payments(sale_id);
create index if not exists ix_mov_tenant_prod  on public.stock_movements(tenant_id, product_id, created_at desc);
create index if not exists ix_inv_tenant       on public.invoices(tenant_id, created_at desc);
create index if not exists ix_subev_tenant     on public.subscription_events(tenant_id, created_at desc);
create index if not exists ix_audit_tenant     on public.audit_logs(tenant_id, created_at desc);

-- ---------- 4. updated_at automático ----------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_touch_tenants  on public.tenants;
create trigger trg_touch_tenants  before update on public.tenants  for each row execute function public.touch_updated_at();
drop trigger if exists trg_touch_users    on public.users;
create trigger trg_touch_users    before update on public.users    for each row execute function public.touch_updated_at();
drop trigger if exists trg_touch_products on public.products;
create trigger trg_touch_products before update on public.products for each row execute function public.touch_updated_at();
drop trigger if exists trg_touch_sales    on public.sales;
create trigger trg_touch_sales    before update on public.sales    for each row execute function public.touch_updated_at();

-- ---------- 5. NUMERAÇÃO DE VENDAS (RPC usada pela Edge Function api) --------
create or replace function public.next_sale_numero(t uuid) returns text
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.tenant_counters (tenant_id, sale_seq) values (t, 1)
  on conflict (tenant_id) do update set sale_seq = tenant_counters.sale_seq + 1
  returning sale_seq into n;
  return 'VENDA-' || lpad(n::text, 6, '0');
end $$;

-- ---------- 6. CATEGORIAS POR SEGMENTO + TRIGGER DE SIGNUP -------------------
create or replace function public.seed_categories(t uuid, segmento text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.categories (tenant_id, nome)
  select t, c.nome from (
    select unnest(case coalesce(segmento,'outro')
      when 'material-construcao' then array['Cimento','Areia e Pedra','Ferragem','Elétrica','Hidráulica','Tintas','Ferramentas','Acabamento','Básico']
      when 'supermercado'        then array['Hortifruti','Açougue','Padaria','Bebidas','Mercearia','Frios e Laticínios','Congelados','Limpeza','Higiene']
      when 'varejo'              then array['Vestuário','Calçados','Acessórios','Eletrônicos','Papelaria','Casa e Decoração','Presentes','Promoções']
      when 'pub-restaurante'     then array['Cervejas e Chopes','Destilados e Drinks','Não Alcoólicos','Entradas','Pratos Principais','Sobremesas','Insumos de Cozinha','Descartáveis']
      when 'odontologia'         then array['Materiais de Consumo','Instrumentais','EPIs','Estética','Implantes','Ortodontia','Esterilização','Escritório']
      else                            array['Produtos','Serviços','Insumos','Outros']
    end) as nome
  ) c
  on conflict (tenant_id, nome) do nothing;
end $$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare t uuid; seg text;
begin
  seg := coalesce(new.raw_user_meta_data->>'segmento', 'outro');
  insert into public.tenants (nome, segmento)
  values (coalesce(new.raw_user_meta_data->>'loja', 'Minha Loja'), seg)
  returning id into t;
  insert into public.users (id, tenant_id, nome, email, papel)
  values (new.id, t, coalesce(new.raw_user_meta_data->>'nome', 'Administrador'), new.email, 'admin')
  on conflict (id) do nothing;
  perform public.seed_categories(t, seg);
  insert into public.tenant_counters (tenant_id) values (t) on conflict do nothing;
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (t, new.id, coalesce(new.raw_user_meta_data->>'nome',''), 'conta.criada', 'tenant', t::text, 'signup via Supabase Auth');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 7. ROW LEVEL SECURITY (defesa em profundidade) -------------------
alter table public.tenants                   enable row level security;
alter table public.users                     enable row level security;
alter table public.categories                enable row level security;
alter table public.products                  enable row level security;
alter table public.sales                     enable row level security;
alter table public.sale_items                enable row level security;
alter table public.sale_payments             enable row level security;
alter table public.stock_movements           enable row level security;
alter table public.invoices                  enable row level security;
alter table public.subscription_events       enable row level security;
alter table public.audit_logs                enable row level security;
alter table public.webhook_events            enable row level security;
alter table public.account_deletion_requests enable row level security;
alter table public.tenant_counters           enable row level security;
-- webhook_events e tenant_counters: RLS sem policy = só service role (Edge Functions)

drop policy if exists ten_sel on public.tenants;
create policy ten_sel on public.tenants for select using (id = public.current_tenant_id());
drop policy if exists ten_upd on public.tenants;
create policy ten_upd on public.tenants for update using (public.is_admin()) with check (id = public.current_tenant_id());

drop policy if exists usr_sel on public.users;
create policy usr_sel on public.users for select using (tenant_id = public.current_tenant_id());
drop policy if exists usr_upd on public.users;
create policy usr_upd on public.users for update using (tenant_id = public.current_tenant_id() and public.is_admin());

drop policy if exists cat_sel on public.categories;
create policy cat_sel on public.categories for select using (tenant_id = public.current_tenant_id());
drop policy if exists cat_wr on public.categories;
create policy cat_wr on public.categories for all using (tenant_id = public.current_tenant_id() and public.is_staff()) with check (tenant_id = public.current_tenant_id());

drop policy if exists prod_sel on public.products;
create policy prod_sel on public.products for select using (tenant_id = public.current_tenant_id());
drop policy if exists prod_wr on public.products;
create policy prod_wr on public.products for insert with check (tenant_id = public.current_tenant_id() and public.is_staff());
drop policy if exists prod_upd on public.products;
create policy prod_upd on public.products for update using (tenant_id = public.current_tenant_id() and public.is_staff());
-- sem policy de DELETE: produto só é inativado (soft delete)

drop policy if exists sale_sel on public.sales;
create policy sale_sel on public.sales for select
  using (tenant_id = public.current_tenant_id() and (public.is_staff() or user_id = auth.uid()));
drop policy if exists sale_ins on public.sales;
create policy sale_ins on public.sales for insert with check (tenant_id = public.current_tenant_id() and user_id = auth.uid());
drop policy if exists sale_upd on public.sales;
create policy sale_upd on public.sales for update using (tenant_id = public.current_tenant_id() and public.is_admin());

drop policy if exists sitem_sel on public.sale_items;
create policy sitem_sel on public.sale_items for select
  using (exists (select 1 from public.sales s where s.id = sale_id and s.tenant_id = public.current_tenant_id()));
drop policy if exists spay_sel on public.sale_payments;
create policy spay_sel on public.sale_payments for select
  using (exists (select 1 from public.sales s where s.id = sale_id and s.tenant_id = public.current_tenant_id()));

drop policy if exists mov_sel on public.stock_movements;
create policy mov_sel on public.stock_movements for select using (tenant_id = public.current_tenant_id());
drop policy if exists mov_wr on public.stock_movements;
create policy mov_wr on public.stock_movements for insert with check (tenant_id = public.current_tenant_id() and public.is_staff());

drop policy if exists inv_sel on public.invoices;
create policy inv_sel on public.invoices for select using (tenant_id = public.current_tenant_id() and public.is_admin());
drop policy if exists subev_sel on public.subscription_events;
create policy subev_sel on public.subscription_events for select using (tenant_id = public.current_tenant_id() and public.is_admin());
drop policy if exists aud_sel on public.audit_logs;
create policy aud_sel on public.audit_logs for select using (tenant_id = public.current_tenant_id() and public.is_staff());
drop policy if exists delreq_sel on public.account_deletion_requests;
create policy delreq_sel on public.account_deletion_requests for select using (tenant_id = public.current_tenant_id() and public.is_admin());

-- ---------- 8. STORAGE (logos públicos por tenant + docs privados) ----------
insert into storage.buckets (id, name, public) values ('logos','logos', true)  on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('docs','docs',  false) on conflict (id) do nothing;

drop policy if exists logos_read on storage.objects;
create policy logos_read on storage.objects for select using (bucket_id = 'logos');
drop policy if exists logos_write on storage.objects;
create policy logos_write on storage.objects for insert to authenticated
  with check (bucket_id = 'logos' and public.is_admin()
              and (storage.foldername(name))[1] = public.current_tenant_id()::text);
drop policy if exists docs_rw on storage.objects;
create policy docs_rw on storage.objects for all to authenticated
  using (bucket_id = 'docs' and (storage.foldername(name))[1] = public.current_tenant_id()::text)
  with check (bucket_id = 'docs' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

-- ============================================================================
-- v4 · SUPORTE (tickets) + CONVITES DE EQUIPE + papel 'dev'
-- (espelho de supabase/migracao-v4-suporte.sql — mantido aqui p/ setup completo)
-- ============================================================================

-- ---------- 1. PAPEL 'dev' ---------------------------------------------------
alter table public.users drop constraint if exists users_papel_check;
alter table public.users add constraint users_papel_check
  check (papel in ('admin','gerente','operador','dev'));

create or replace function public.is_dev() returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return coalesce(public.current_role_app() = 'dev', false);
end $$;

-- Guarda: ninguém (exceto service role/dev) promove alguém a 'dev'
create or replace function public.guard_papel_dev() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.papel = 'dev' and coalesce(old.papel,'') <> 'dev' then
    if auth.uid() is not null and public.current_role_app() <> 'dev' then
      raise exception 'FORBIDDEN';
    end if;
  end if;
  if old.papel = 'dev' and new.papel <> 'dev' then
    if auth.uid() is not null and public.current_role_app() <> 'dev' then
      raise exception 'FORBIDDEN';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_users_papel_guard on public.users;
create trigger trg_users_papel_guard before update on public.users
  for each row execute function public.guard_papel_dev();

-- ---------- 2. CONVITES DE EQUIPE --------------------------------------------
create table if not exists public.user_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null,
  nome text not null default '',
  papel text not null default 'operador' check (papel in ('admin','gerente','operador','dev')),
  token uuid not null default gen_random_uuid(),
  invited_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  revoked_at timestamptz
);
create index if not exists ix_inv_tenant on public.user_invites(tenant_id, accepted_at);
create index if not exists ix_inv_token on public.user_invites(token);

alter table public.user_invites enable row level security;
drop policy if exists inv_sel on public.user_invites;
create policy inv_sel on public.user_invites for select
  using (tenant_id = public.current_tenant_id());
-- sem policy de insert/update/delete: apenas service role (Edge Function) manipula

-- ---------- 3. SUPORTE: TICKETS ----------------------------------------------
create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  numero int not null,
  assunto text not null check (char_length(assunto) between 4 and 160),
  categoria text not null default 'duvida' check (categoria in ('duvida','bug','sugestao','faturamento','outro')),
  prioridade text not null default 'media' check (prioridade in ('baixa','media','alta','urgente')),
  status text not null default 'aberto' check (status in ('aberto','em_andamento','resolvido','fechado')),
  descricao text not null check (char_length(descricao) between 10 and 4000),
  requester_name text not null default '',   -- snapshot (evita join entre tenants)
  requester_email text not null default '',
  tenant_name text not null default '',      -- snapshot p/ visão dev
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (tenant_id, numero)
);

create table if not exists public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets(id) on delete cascade,
  sender_id uuid not null references public.users(id) on delete cascade,
  sender_name text not null default '',     -- snapshot preenchido por trigger
  sender_role text not null default '',     -- 'dev' = equipe JR Sistemas
  message text not null check (char_length(message) between 1 and 4000),
  created_at timestamptz not null default now()
);

create table if not exists public.support_ticket_counters (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  ticket_seq int not null default 0
);

create index if not exists ix_tick_tenant  on public.support_tickets(tenant_id, updated_at desc);
create index if not exists ix_tick_status  on public.support_tickets(status, updated_at desc);
create index if not exists ix_tmsg_ticket  on public.ticket_messages(ticket_id, created_at);

-- snapshots automáticos (security definer lê users/tenants sem vazar entre tenants)
create or replace function public.fill_ticket_snapshots() returns trigger
language plpgsql security definer set search_path = public as $$
declare uname text; uemail text; tname text; urole text;
begin
  if TG_TABLE_NAME = 'support_tickets' then
    select nome, email into uname, uemail from public.users where id = new.user_id;
    select nome into tname from public.tenants where id = new.tenant_id;
    new.requester_name := coalesce(uname, '');
    new.requester_email := coalesce(uemail, '');
    new.tenant_name := coalesce(tname, '');
  elsif TG_TABLE_NAME = 'ticket_messages' then
    select nome, papel into uname, urole from public.users where id = new.sender_id;
    new.sender_name := coalesce(uname, '');
    new.sender_role := coalesce(urole, '');
  end if;
  return new;
end $$;
drop trigger if exists trg_tick_snap on public.support_tickets;
create trigger trg_tick_snap before insert on public.support_tickets
  for each row execute function public.fill_ticket_snapshots();
drop trigger if exists trg_tmsg_snap on public.ticket_messages;
create trigger trg_tmsg_snap before insert on public.ticket_messages
  for each row execute function public.fill_ticket_snapshots();

-- updated_at do ticket sobe a cada mensagem + ao mudar status
create or replace function public.bump_ticket() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if new.status in ('resolvido','fechado') and old.status not in ('resolvido','fechado') then
    new.closed_at := now();
  end if;
  return new;
end $$;
drop trigger if exists trg_tick_touch on public.support_tickets;
create trigger trg_tick_touch before update on public.support_tickets
  for each row execute function public.bump_ticket();

create or replace function public.bump_ticket_on_msg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.support_tickets
     set updated_at = now(),
         status = case when status = 'aberto' then 'em_andamento' else status end
   where id = new.ticket_id;
  return new;
end $$;
drop trigger if exists trg_tmsg_bump on public.ticket_messages;
create trigger trg_tmsg_bump after insert on public.ticket_messages
  for each row execute function public.bump_ticket_on_msg();

-- RLS
alter table public.support_tickets enable row level security;
alter table public.ticket_messages enable row level security;

drop policy if exists tick_sel on public.support_tickets;
create policy tick_sel on public.support_tickets for select
  using (public.is_dev() or tenant_id = public.current_tenant_id());
drop policy if exists tick_ins on public.support_tickets;
create policy tick_ins on public.support_tickets for insert
  with check (tenant_id = public.current_tenant_id() and user_id = auth.uid());
drop policy if exists tick_upd on public.support_tickets;
create policy tick_upd on public.support_tickets for update
  using (public.is_dev() or tenant_id = public.current_tenant_id())
  with check (public.is_dev() or tenant_id = public.current_tenant_id());
-- sem delete: tickets ficam no histórico (fechamento lógico)

drop policy if exists tmsg_sel on public.ticket_messages;
create policy tmsg_sel on public.ticket_messages for select
  using (exists (select 1 from public.support_tickets t
                  where t.id = ticket_id
                    and (public.is_dev() or t.tenant_id = public.current_tenant_id())));
drop policy if exists tmsg_ins on public.ticket_messages;
create policy tmsg_ins on public.ticket_messages for insert
  with check (exists (select 1 from public.support_tickets t
                       where t.id = ticket_id
                         and (public.is_dev() or t.tenant_id = public.current_tenant_id())));
-- sem update/delete de mensagens

-- numeração por tenant
create or replace function public.next_ticket_numero(t uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.support_ticket_counters (tenant_id, ticket_seq) values (t, 1)
  on conflict (tenant_id) do update set ticket_seq = support_ticket_counters.ticket_seq + 1
  returning ticket_seq into n;
  return n;
end $$;

-- RPC de abertura de ticket (validação centralizada)
create or replace function public.support_create_ticket(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t uuid := public.current_tenant_id(); u uuid := auth.uid(); tid uuid; n int;
begin
  if t is null or u is null then raise exception 'UNAUTHORIZED'; end if;
  if coalesce(char_length(p->>'assunto'),0) < 4 then raise exception 'VALIDATION'; end if;
  if coalesce(char_length(p->>'descricao'),0) < 10 then raise exception 'VALIDATION'; end if;
  n := public.next_ticket_numero(t);
  insert into public.support_tickets (tenant_id, user_id, numero, assunto, categoria, prioridade, descricao)
  values (t, u, n,
          left(p->>'assunto', 160),
          coalesce(p->>'categoria','duvida'),
          coalesce(p->>'prioridade','media'),
          left(p->>'descricao', 4000))
  returning id into tid;
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (t, u, (select nome from public.users where id = u), 'ticket.criado', 'ticket', tid::text, '#' || n || ' ' || left(p->>'assunto',60));
  return jsonb_build_object('id', tid, 'numero', n);
end $$;
grant execute on function public.support_create_ticket(jsonb) to authenticated;
grant execute on function public.next_ticket_numero(uuid) to authenticated;

-- ---------- 4. handle_new_user v2 (convites + signup normal) ----------------
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

  -- Fluxo 2: signup normal → novo tenant + admin + categorias
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
  values (t, new.id, coalesce(new.raw_user_meta_data->>'nome',''), 'conta.criada', 'tenant', t::text, 'signup via Supabase Auth');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================================
-- v5 · BILLING JUSTO: DEV ILIMITADO, TRIAL ÚNICO E SUSPENSÃO SERVER-SIDE
-- (espelho de supabase/migracao-v5-billing-dev.sql — mantido aqui p/ setup completo)
-- Conta DEV ilimitada · trial único não renovável (guard de cobrança) ·
-- expiração server-side (read_only) · escrita bloqueada p/ tenant suspenso ·
-- signup com e-mail da whitelist dev => conta dev automática.
-- ============================================================================

-- ---------- 0. Constante de e-mails da equipe JR (dev) -----------------------
-- Contas com estes e-mails nascem como 'dev' com acesso total e ilimitado.
create or replace function public.dev_emails() returns text[]
language sql immutable as $$
  select array[
    'jrsistemasetecnologiabr@gmail.com'
  ];
$$;
-- v8: allowlist com UM único e-mail (a conta criada pelo dono). A conta espelho
-- jrsistemasetecnologia.br@gmail.com foi rebaixada (admin, ativo=false) — ver
-- seção v8 no final. Alterar esta lista é responsabilidade exclusiva do dono
-- do SaaS (SQL Editor ou migração versionada): qualquer conta criada com um
-- destes e-mails NASCE com papel dev (acesso total, cross-tenant).

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

-- ============================================================================
-- v5b · ANTI-ABUSO DO TESTE GRÁTIS + TRIAL NA CONFIRMAÇÃO
-- (espelho de supabase/migracao-v5-anti-abuso.sql — mantido aqui p/ setup completo)
-- Depois da v5-billing-dev: handle_new_user v4 (convite + dev + guarda) e
-- billing_refresh_status com filtro de trial_pending.
-- ============================================================================

create table if not exists public.signup_audit (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  ip text not null default 'desconhecido',
  device_id text,                          -- cookie lc_did (camada complementar)
  trial_granted boolean not null default true,  -- false = conta paga direta/dev (não conta no limite)
  consumed boolean not null default false,      -- false = intenção; true = conta criada
  user_id uuid,
  tenant_id uuid,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (ip, email)
);
create index if not exists ix_sgaud_ip     on public.signup_audit(ip, consumed);
create index if not exists ix_sgaud_device on public.signup_audit(device_id) where device_id is not null;
create index if not exists ix_sgaud_user   on public.signup_audit(user_id) where user_id is not null;

-- Sem nenhuma policy de RLS: somente service role (Edge Function) e triggers.
alter table public.signup_audit enable row level security;

-- ---------- 2. TRIAL PENDENTE DE CONFIRMAÇÃO --------------------------------
alter table public.tenants add column if not exists trial_pending boolean not null default false;

-- ---------- 3. RPCs DA GUARDA (somente service role) -------------------------
-- signup_begin: registra a intenção e valida os limites de teste grátis.
-- Conta como "teste usado": contas criadas (consumed) OU intenções frescas
-- (reservas de até 30 min — evita corrida de cadastros paralelos do mesmo IP).
create or replace function public.signup_begin(
  p_email text, p_ip text, p_device text,
  p_trial boolean default true,
  p_ip_limit int default 1,
  p_device_limit int default 1
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(left(trim(coalesce(p_email, '')), 160));
  v_ip text := left(trim(coalesce(p_ip, 'desconhecido')), 64);
  v_device text := nullif(left(trim(coalesce(p_device, '')), 64), '');
  v_ip_count int := 0;
  v_dev_count int := 0;
begin
  if v_email = '' or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'INVALID_EMAIL';
  end if;

  -- Contas da equipe JR (dev — migração v5-billing-dev) não consomem vaga de
  -- teste grátis. O EXISTS torna isto seguro mesmo sem aquela migração.
  if coalesce(p_trial, true)
     and exists (select 1 from pg_catalog.pg_proc f
                  join pg_catalog.pg_namespace n on n.oid = f.pronamespace
                 where f.proname = 'dev_emails' and n.nspname = 'public')
     and v_email = any (public.dev_emails()) then
    p_trial := false;
  end if;

  -- Serializa cadastros simultâneos do mesmo IP/dispositivo (ordem fixa evita deadlock)
  if v_ip <> 'desconhecido' then
    perform pg_advisory_xact_lock(hashtext('sg_ip:' || v_ip));
  end if;
  if v_device is not null then
    perform pg_advisory_xact_lock(hashtext('sg_dev:' || v_device));
  end if;

  -- Este e-mail já virou conta por este IP? O GoTrue recusaria depois; falha cedo.
  if exists (select 1 from public.signup_audit
              where ip = v_ip and lower(email) = v_email and consumed) then
    raise exception 'EMAIL_EXISTS';
  end if;

  if p_trial then
    if v_ip <> 'desconhecido' and coalesce(p_ip_limit, 1) > 0 then
      select count(*) into v_ip_count from public.signup_audit
       where ip = v_ip and trial_granted
         and (consumed or created_at > now() - interval '30 minutes');
      if v_ip_count >= p_ip_limit then
        raise exception 'TRIAL_IP_LIMIT';
      end if;
    end if;
    if v_device is not null and coalesce(p_device_limit, 1) > 0 then
      select count(*) into v_dev_count from public.signup_audit
       where device_id = v_device and trial_granted
         and (consumed or created_at > now() - interval '30 minutes');
      if v_dev_count >= p_device_limit then
        raise exception 'TRIAL_DEVICE_LIMIT';
      end if;
    end if;
  end if;

  insert into public.signup_audit (email, ip, device_id, trial_granted)
  values (v_email, v_ip, v_device, coalesce(p_trial, true))
  on conflict (ip, email) do update          -- re-tentativa do mesmo e-mail reaproveita a intenção
    set created_at = now(), device_id = excluded.device_id, trial_granted = excluded.trial_granted
    where public.signup_audit.consumed = false;
end $$;

-- signup_abort: devolve a vaga quando o cadastro de fato não aconteceu
-- (senha fraca, e-mail existente, limite de envio do provedor etc.).
create or replace function public.signup_abort(p_email text, p_ip text) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.signup_audit
   where lower(email) = lower(left(trim(coalesce(p_email, '')), 160))
     and ip = left(trim(coalesce(p_ip, 'desconhecido')), 64)
     and consumed = false;
end $$;

revoke execute on function public.signup_begin(text, text, text, boolean, int, int) from public, anon, authenticated;
revoke execute on function public.signup_abort(text, text) from public, anon, authenticated;
grant execute on function public.signup_begin(text, text, text, boolean, int, int) to service_role;
grant execute on function public.signup_abort(text, text) to service_role;

-- ---------- 4. handle_new_user v4 (convite + dev + guarda + trial pendente) --
-- Fluxo 1 (convite): inalterado — convidado entra no tenant existente, sem
--   teste grátis novo e sem passar pela guarda (não cria tenant).
-- Fluxo 2 (dev): e-mail da equipe JR Sistemas → conta dev ilimitada (v5
--   billing-dev) — sem guarda e sem trial.
-- Fluxo 3 (signup normal): exige intenção aprovada pela guarda (signup_begin)
--   quando o e-mail ainda não está confirmado; cadastro "direto" no endpoint
--   público do GoTrue sem intenção é recusado (a anon key é pública, então a
--   defesa real tem que viver aqui, no banco). O trial nasce PENDENTE e só
--   conta os 14 dias quando o e-mail é confirmado (handle_user_confirmed).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  t uuid; seg text; inv record;
  v_pending boolean; aud record;
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
    values (new.id, t, coalesce(new.raw_user_meta_data->>'nome',''), new.email, 'dev')
    on conflict (id) do nothing;
    perform public.seed_categories(t, seg);
    insert into public.tenant_counters (tenant_id) values (t) on conflict do nothing;
    insert into public.support_ticket_counters (tenant_id) values (t) on conflict do nothing;
    insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
    values (t, new.id, coalesce(new.raw_user_meta_data->>'nome',''), 'conta.criada', 'tenant', t::text,
            'conta DEV (equipe JR Sistemas) — acesso ilimitado');
    return new;
  end if;

  -- O e-mail já nasce confirmado (contas criadas via admin/dashboard com
  -- confirmação imediata)? Essas são de confiança da equipe — trial direto.
  v_pending := new.email_confirmed_at is null;

  if v_pending then
    -- Signup público NÃO confirmado: exige intenção aprovada pela guarda de IP.
    select * into aud from public.signup_audit
     where lower(email) = lower(new.email) and consumed = false
       and created_at > now() - interval '30 minutes'
     order by created_at desc limit 1;
    if not found then
      raise exception 'SIGNUP_GUARD: cadastro sem intenção aprovada — use o aplicativo (função api · op auth.signup)';
    end if;
  end if;

  -- Fluxo 3: signup normal → novo tenant + admin + categorias
  insert into public.tenants (nome, segmento, trial_pending, trial_ends_at)
  values (coalesce(new.raw_user_meta_data->>'loja', 'Minha Loja'), seg,
          v_pending,
          case when v_pending then now() else now() + interval '14 days' end)
  returning id into t;
  insert into public.users (id, tenant_id, nome, email, papel)
  values (new.id, t, coalesce(new.raw_user_meta_data->>'nome', 'Administrador'), new.email, 'admin')
  on conflict (id) do nothing;
  perform public.seed_categories(t, seg);
  insert into public.tenant_counters (tenant_id) values (t) on conflict do nothing;
  insert into public.support_ticket_counters (tenant_id) values (t) on conflict do nothing;
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (t, new.id, coalesce(new.raw_user_meta_data->>'nome',''), 'conta.criada', 'tenant', t::text,
          case when v_pending
               then 'aguardando confirmação de e-mail (trial pendente)'
               else 'signup via Supabase Auth' end);

  if v_pending and aud.id is not null then
    -- Consome a intenção: agora o IP/dispositivo tem o teste dele registrado.
    update public.signup_audit
       set consumed = true, user_id = new.id, tenant_id = t
     where id = aud.id;
  end if;
  return new;
end $$;

-- ---------- 5. TRIAL COMEÇA NA CONFIRMAÇÃO DO E-MAIL -------------------------
-- Toda confirmação (código de 6 dígitos OU clique no link) é um UPDATE em
-- auth.users com email_confirmed_at passando de null para preenchido.
-- Guarda extra: só reativa tenants com trial_pending (convidados, contas dev
-- e contas antigas não são tocados).
create or replace function public.handle_user_confirmed() returns trigger
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if new.email_confirmed_at is not null and old.email_confirmed_at is null then
    select tenant_id into t from public.users where id = new.id;
    if t is not null then
      update public.tenants
         set trial_ends_at = now() + interval '14 days',
             trial_pending = false
       where id = t and trial_pending;
      update public.signup_audit set confirmed_at = now()
       where user_id = new.id and confirmed_at is null;
      insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
      values (t, new.id, coalesce((select nome from public.users where id = new.id), ''),
              'email.confirmado', 'user', new.id::text, 'teste grátis de 14 dias iniciado');
    end if;
  end if;
  return new;
end $$;

-- ---------- 6. billing_refresh_status não suspende trial PENDENTE ------------
-- Entre o cadastro e a confirmação do e-mail o tenant fica com trial_ends_at
-- = now(): sem esta guarda, a reconciliação de billing (v5-billing-dev)
-- suspenderia a conta antes do teste começar. Espelha a original com o filtro.
create or replace function public.billing_refresh_status() returns jsonb
language plpgsql security definer set search_path = public as $$
declare t uuid; st text; pid text; pc text; te timestamptz; nc timestamptz; tp boolean;
begin
  t := public.current_tenant_id();
  if t is null then raise exception 'UNAUTHORIZED'; end if;
  select status, plan_id, plan_cycle, trial_ends_at, next_charge_at, trial_pending
    into st, pid, pc, te, nc, tp
    from public.tenants where id = t for update;
  if st = 'trialing' and te < now() and not coalesce(tp, false) then
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
  after update on auth.users
  for each row execute function public.handle_user_confirmed();

-- ---------- 7. Ajuste opcional para quem já tinha cadastros ------------------
-- Contas já confirmadas criadas ANTES desta migração não mudam de estado
-- (trial_pending=false por padrão; a trigger de confirmação é no-op para elas).
--
-- Como ajustar os limites (sem tocar no banco):
--   supabase secrets set TRIAL_LIMIT_PER_IP=2 TRIAL_LIMIT_PER_DEVICE=2
--   (defaults na Edge Function: 1 e 1)
-- Como ver o uso por IP:
--   select ip, count(*) filter (where consumed) as contas, max(created_at)
--     from signup_audit group by ip order by 2 desc;


-- ============================================================================
-- v6 · PLANOS COM PRAZO (plan_expires_at) + pg_cron — espelho de migracao-v6
-- (aplicada em produção em 2026-11-10)
-- ============================================================================

-- ========== 1. DDL — novas colunas em public.tenants ========================

-- Vencimento real do plano pago. NULL = sem prazo (dev ou contas legadas antes da v6).
alter table public.tenants
  add column if not exists plan_expires_at timestamptz;

-- Auditoria de quem ativou/estendeu e por quê (Pix, cortesia, bug…).
alter table public.tenants
  add column if not exists plan_activated_by uuid references public.users(id) on delete set null,
  add column if not exists plan_activated_at timestamptz,
  add column if not exists plan_activation_reason text;

-- Índice para a varredura do cron (só as lojas ativas interessam).
create index if not exists ix_tenants_plan_expires
  on public.tenants (plan_expires_at)
  where status = 'active';

-- ========== 2. billing_refresh_status() — também vira plano VENCIDO ========
-- Trata trial vencido E plano pago vencido, e devolve planExpiresAt para o
-- frontend (Billing.syncRemote lê esse campo e destrava o cliente sem re-login).

create or replace function public.billing_refresh_status() returns jsonb
language plpgsql security definer set search_path = public as $$
declare t uuid; st text; pid text; pc text; te timestamptz; nc timestamptz; pe timestamptz;
begin
  t := public.current_tenant_id();
  if t is null then raise exception 'UNAUTHORIZED'; end if;
  select status, plan_id, plan_cycle, trial_ends_at, next_charge_at, plan_expires_at
    into st, pid, pc, te, nc, pe
    from public.tenants where id = t for update;

  if st = 'trialing' and te < now() then
    update public.tenants set status = 'read_only', updated_at = now() where id = t;
    st := 'read_only';
    insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
    values (t, auth.uid(), (select nome from public.users where id = auth.uid()),
            'assinatura.suspensa', 'tenant', t::text, 'teste grátis encerrado (14 dias) — modo leitura');
  elsif st = 'active' and pe is not null and pe < now() and pid is distinct from 'dev' then
    update public.tenants set status = 'read_only', updated_at = now() where id = t;
    st := 'read_only';
    insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
    values (t, auth.uid(), (select nome from public.users where id = auth.uid()),
            'assinatura.suspensa', 'tenant', t::text, 'plano pago venceu em ' || pe::text || ' — modo leitura');
  end if;

  return jsonb_build_object('status', st, 'planId', pid, 'planCycle', pc,
                            'trialEndsAt', te, 'nextChargeAt', nc, 'planExpiresAt', pe);
end $$;

-- ========== 3. tenant_billing_ok() — bloqueia venda com plano vencido ======
create or replace function public.tenant_billing_ok() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare t uuid; st text; te timestamptz; pe timestamptz; pid text;
begin
  t := public.current_tenant_id();
  if t is null then return false; end if;
  select status, trial_ends_at, plan_expires_at, plan_id into st, te, pe, pid from public.tenants where id = t;
  if st is null then return false; end if;
  if st = 'trialing' and te < now() then return false; end if;   -- trial vencido
  if st = 'active' and pid is distinct from 'dev'                 -- plano pago vencido
     and pe is not null and pe < now() then return false; end if;
  return st in ('trialing','active','past_due');
end $$;

-- ========== 4. Guard — protege a nova coluna e libera a auto-suspensão =====
-- O guard lista as colunas protegidas uma a uma; inclui plan_expires_at /
-- plan_activated_* e permite a transição active→read_only quando o próprio
-- plano já está vencido (só suspende, nunca libera).

create or replace function public.guard_tenants_billing() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;  -- service role / Edge / SQL Editor

  -- transição automática de expiração (só suspende, nunca libera): permitida
  if old.status = 'trialing' and new.status = 'read_only'
     and old.trial_ends_at < now()
     and new.trial_ends_at = old.trial_ends_at
     and new.plan_id is not distinct from old.plan_id then
    return new;
  end if;
  if old.status = 'active' and new.status = 'read_only'
     and old.plan_expires_at is not null and old.plan_expires_at < now()
     and new.plan_expires_at = old.plan_expires_at
     and new.plan_id is not distinct from old.plan_id then
    return new;
  end if;

  if new.status                is distinct from old.status
     or new.plan_id            is distinct from old.plan_id
     or new.plan_cycle         is distinct from old.plan_cycle
     or new.scheduled_plan     is distinct from old.scheduled_plan
     or new.trial_ends_at      is distinct from old.trial_ends_at
     or new.plan_expires_at    is distinct from old.plan_expires_at
     or new.plan_activated_by  is distinct from old.plan_activated_by
     or new.plan_activated_at  is distinct from old.plan_activated_at
     or new.plan_activation_reason is distinct from old.plan_activation_reason
     or new.next_charge_at     is distinct from old.next_charge_at
     or new.started_at         is distinct from old.started_at
     or new.canceled_at        is distinct from old.canceled_at
     or new.cancel_reason      is distinct from old.cancel_reason
     or new.stripe_customer_id is distinct from old.stripe_customer_id
     or new.stripe_subscription_id is distinct from old.stripe_subscription_id
     or new.deletion_requested_at  is distinct from old.deletion_requested_at then
    raise exception 'FORBIDDEN'
      using hint = 'Colunas de cobrança (status/plano/prazo) são gerenciadas pelo servidor.';
  end if;
  return new;
end $$;

-- ========== 5. pg_cron — suspensão automática de lojas expiradas ===========
-- Roda de hora em hora: loja ativa com plano vencido → read_only + auditoria.
-- O frontend (checkTrial/statusInfo) reflete na hora; o cron garante mesmo
-- com o cliente offline, e a próxima sincronização dele pega o estado novo.

create extension if not exists pg_cron;

-- função de varredura (security definer para tocar todos os tenants)
create or replace function public.cron_suspend_expired_plans() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; r record;
begin
  for r in select id, nome, plan_expires_at from public.tenants
           where status = 'active'
             and plan_id is distinct from 'dev'
             and plan_expires_at is not null
             and plan_expires_at < now()
  loop
    update public.tenants set status = 'read_only', updated_at = now() where id = r.id;
    insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
    values (r.id, null, 'cron', 'assinatura.suspensa', 'tenant', r.id::text,
            'plano venceu em ' || r.plan_expires_at::text || ' — suspensão automática (pg_cron)');
    n := n + 1;
  end loop;
  return n;
end $$;

-- agendamento horário (idempotente: reagenda pelo nome)
select cron.schedule(
  'suspend-expired-plans',
  '5 * * * *',
  $$select public.cron_suspend_expired_plans();$$
);

-- (opcional) aviso diário de planos expirando em <=5 dias (rastro p/ follow-up)
select cron.schedule(
  'warn-expiring-plans',
  '0 12 * * *',
  $$insert into public.audit_logs (tenant_id, acao, entidade, entidade_id, detalhes)
    select id, 'plano.expirando', 'tenant', id::text, 'vence em <=5 dias'
    from public.tenants
    where status = 'active' and plan_id is distinct from 'dev'
      and plan_expires_at between now() and now() + interval '5 days';$$
);

-- ========== 6. Backfill das contas atuais ===================================
-- Lojas ativas hoje (ativadas sem prazo pela v5): entram no regime com 30 dias
-- a partir da migração. Dev (plan_id='dev') fica SEM prazo — conta interna.
update public.tenants
   set plan_expires_at = now() + interval '30 days'
 where status = 'active' and plan_id is distinct from 'dev'
   and plan_expires_at is null;


-- ============================================================================
-- v7 · FLUXO DE ATENDIMENTO (máquina de estados de tickets) — espelho de
-- migracao-v7 (aplicada em produção em 2026-11-10)
-- ============================================================================

-- ========== 1. Novos status no CHECK da tabela ==============================
alter table public.support_tickets drop constraint if exists support_tickets_status_check;
alter table public.support_tickets add constraint support_tickets_status_check
  check (status in ('aberto','em_andamento','aguardando_cliente','aguardando_equipe','resolvido','fechado'));

-- ========== 2. Responsável pelo atendimento (assignee) ======================
alter table public.support_tickets
  add column if not exists assignee_id uuid references public.users(id) on delete set null,
  add column if not exists assignee_name text not null default '';

create index if not exists ix_tick_assignee on public.support_tickets(assignee_id, status);

-- ========== 3. ticket_messages: separar mensagens de eventos ================
alter table public.ticket_messages
  add column if not exists tipo text not null default 'mensagem'
    check (tipo in ('mensagem','evento'));

-- ========== 4. Snapshot do assignee (INSERT e UPDATE) =======================
create or replace function public.fill_ticket_snapshots() returns trigger
language plpgsql security definer set search_path = public as $$
declare uname text; uemail text; tname text; urole text; aname text;
begin
  if TG_TABLE_NAME = 'support_tickets' then
    if TG_OP = 'INSERT' then
      select nome, email into uname, uemail from public.users where id = new.user_id;
      select nome into tname from public.tenants where id = new.tenant_id;
      new.requester_name := coalesce(uname, '');
      new.requester_email := coalesce(uemail, '');
      new.tenant_name := coalesce(tname, '');
    end if;
    -- assignee_name acompanha assignee_id em qualquer UPDATE (Atender/assumir)
    if new.assignee_id is not null and new.assignee_id is distinct from old.assignee_id then
      select nome into aname from public.users where id = new.assignee_id;
      new.assignee_name := coalesce(aname, '');
    elsif new.assignee_id is null then
      new.assignee_name := '';
    end if;
  elsif TG_TABLE_NAME = 'ticket_messages' then
    select nome, papel into uname, urole from public.users where id = new.sender_id;
    new.sender_name := coalesce(uname, '');
    new.sender_role := coalesce(urole, '');
  end if;
  return new;
end $$;
drop trigger if exists trg_tick_snap on public.support_tickets;
create trigger trg_tick_snap before insert on public.support_tickets
  for each row execute function public.fill_ticket_snapshots();
drop trigger if exists trg_tick_snap_upd on public.support_tickets;
create trigger trg_tick_snap_upd before update on public.support_tickets
  for each row execute function public.fill_ticket_snapshots();
drop trigger if exists trg_tmsg_snap on public.ticket_messages;
create trigger trg_tmsg_snap before insert on public.ticket_messages
  for each row execute function public.fill_ticket_snapshots();

-- ========== 5. closed_at: marca ao encerrar, LIMPA ao reabrir ===============
create or replace function public.bump_ticket() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if new.status in ('resolvido','fechado') and old.status not in ('resolvido','fechado') then
    new.closed_at := now();
  end if;
  if new.status not in ('resolvido','fechado') then
    new.closed_at := null;   -- reaberto: volta a ser um ticket ativo
  end if;
  return new;
end $$;
drop trigger if exists trg_tick_touch on public.support_tickets;
create trigger trg_tick_touch before update on public.support_tickets
  for each row execute function public.bump_ticket();

-- ========== 6. Resposta move a bola (transição automática por papel) ========
-- A resposta muda o status conforme QUEM respondeu — a "bola" troca de lado:
--   dev responde    → aguardando_cliente (e assume o ticket se ninguém assumiu)
--   cliente responde→ aguardando_equipe   (se ainda aberto, mantém na fila)
-- Reabre conversas encerradas (resolvido/fechado → aguardando_*).
-- Eventos (tipo='evento') NÃO movem status (evita recursão).
create or replace function public.bump_ticket_on_msg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tipo = 'evento' then return new; end if;

  -- flag de bypass: transição automática não passa pela regra "dono ou dev"
  perform set_config('app.ticket_auto_transition', 'on', true);
  update public.support_tickets t
     set updated_at = now(),
         assignee_id = case
           when new.sender_role = 'dev' and t.assignee_id is null then new.sender_id
           else t.assignee_id end,
         status = case
           when new.sender_role = 'dev' and t.status in ('aberto','em_andamento','aguardando_equipe','resolvido','fechado')
             then 'aguardando_cliente'
           when new.sender_role = 'dev'
             then t.status  -- já aguardando_cliente
           when new.sender_role is distinct from 'dev' and t.status in ('em_andamento','aguardando_cliente','resolvido','fechado')
             then 'aguardando_equipe'
           else t.status    -- cliente respondeu ticket aberto: continua na fila
         end
   where t.id = new.ticket_id;
  perform set_config('app.ticket_auto_transition', 'off', true);
  return new;
end $$;
drop trigger if exists trg_tmsg_bump on public.ticket_messages;
create trigger trg_tmsg_bump after insert on public.ticket_messages
  for each row execute function public.bump_ticket_on_msg();

-- ========== 7. GUARD: status/prioridade/categoria/assignee por papel ========
-- Dev: controle total. Dono do ticket: pode encerrar/confirmar/abrir (status).
-- Demais membros: nada de status/prioridade/categoria/assignee — só responder.
-- Transições automáticas (flag app.ticket_auto_transition) passam direto.
create or replace function public.guard_ticket_flow() returns trigger
language plpgsql security definer set search_path = public as $$
declare actor_role text; is_owner boolean; auto boolean;
begin
  if auth.uid() is null then return new; end if;  -- service role / Edge / SQL Editor

  auto := coalesce(current_setting('app.ticket_auto_transition', true), 'off') = 'on';
  if auto then return new; end if;                -- transição automática da resposta

  select papel into actor_role from public.users where id = auth.uid();
  is_owner := (old.user_id = auth.uid());

  -- assignee: somente dev
  if new.assignee_id is distinct from old.assignee_id and coalesce(actor_role,'') <> 'dev' then
    raise exception 'FORBIDDEN'
      using hint = 'Somente a equipe JR Sistemas assume ou devolve tickets.';
  end if;

  -- status: dev sempre; dono pode (encerrar/confirmar/reabrir o próprio); demais não
  if new.status is distinct from old.status and coalesce(actor_role,'') <> 'dev' and not is_owner then
    raise exception 'FORBIDDEN'
      using hint = 'Somente quem abriu o ticket (ou a equipe JR) altera o status.';
  end if;

  -- prioridade/categoria: avaliação técnica é da equipe
  if (new.prioridade is distinct from old.prioridade or new.categoria is distinct from old.categoria)
     and coalesce(actor_role,'') <> 'dev' then
    raise exception 'FORBIDDEN'
      using hint = 'Prioridade e categoria são definidas pela equipe JR Sistemas.';
  end if;

  return new;
end $$;
drop trigger if exists trg_tick_flow_guard on public.support_tickets;
create trigger trg_tick_flow_guard before update on public.support_tickets
  for each row execute function public.guard_ticket_flow();

-- ========== 8. Evento de auditoria na própria conversa ======================
-- Toda transição de status vira uma linha tipo='evento' com quem fez.
-- (auth.uid() nulo → mudança de sistema/service role: não há quem creditar)
create or replace function public.ticket_status_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and auth.uid() is not null then
    insert into public.ticket_messages (ticket_id, sender_id, message, tipo)
    values (new.id, auth.uid(), 'status:' || old.status || '>' || new.status, 'evento');
  end if;
  return new;
end $$;
drop trigger if exists trg_tick_event on public.support_tickets;
create trigger trg_tick_event after update on public.support_tickets
  for each row execute function public.ticket_status_event();

-- ========== 9. RPC "Atender" (assumir + em_andamento, atômico) ===============
create or replace function public.support_take_ticket(p_ticket uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t record; r text;
begin
  select papel into r from public.users where id = auth.uid();
  if coalesce(r,'') <> 'dev' then raise exception 'FORBIDDEN'; end if;
  select * into t from public.support_tickets where id = p_ticket;
  if t.id is null then raise exception 'NOT_FOUND'; end if;
  update public.support_tickets
     set status = 'em_andamento', assignee_id = auth.uid(), updated_at = now()
   where id = p_ticket;
  return jsonb_build_object('ok', true, 'status', 'em_andamento');
end $$;
grant execute on function public.support_take_ticket(uuid) to authenticated;

-- ========== 10. Índice de fila para o painel dev ============================
create index if not exists ix_tick_fila on public.support_tickets(status, updated_at desc);

-- ========== 11. Políticas RLS (reforço) =====================================
-- tick_upd continua: dev ou próprio tenant (o guard acima refina por campo).
drop policy if exists tick_upd on public.support_tickets;
create policy tick_upd on public.support_tickets for update
  using (public.is_dev() or tenant_id = public.current_tenant_id())
  with check (public.is_dev() or tenant_id = public.current_tenant_id());

-- ========== 12. Snapshot do assignee nos tickets existentes =================
update public.support_tickets t
   set assignee_name = coalesce((select nome from public.users u where u.id = t.assignee_id), '')
 where assignee_id is not null and assignee_name = '';


-- ============================================================================
-- FIM DO SQL. CHECKLIST NO DASHBOARD (não dá para fazer via SQL):
--
-- AUTHENTICATION → PROVIDERS → Email: habilitado; "Confirm email" = ON
--   (com o script supabase/configurar-emails-templates.py: mailer_autoconfirm=false,
--    mailer_otp_exp=600 → código de 6 dígitos válido por 10 minutos, e o template
--    "Confirm signup" mostra {{ .Token }} para a tela de código do app)
-- AUTHENTICATION → URL CONFIGURATION:
--   Site URL: https://SEU-DOMINIO
--   Redirect URLs: https://SEU-DOMINIO/#/confirmar-email
--                  https://SEU-DOMINIO/#/redefinir
--                  https://SEU-DOMINIO/#/definir-senha
-- AUTHENTICATION → PASSWORDS: mínimo 8 caracteres (igual à política do app)
-- PROJECT SETTINGS → API: copie a URL e a anon key (públicas) para o .env
-- PROJECT SETTINGS → EDGE FUNCTIONS → Secrets (NUNCA no front):
--   SUPABASE_SERVICE_ROLE_KEY, TRIAL_LIMIT_PER_IP (padrão 1),
--   TRIAL_LIMIT_PER_DEVICE (padrão 1), PURGE_SECRET (cron LGPD, idem GitHub
--   Secret), STRIPE_WEBHOOK_SECRET ou ASAAS_WEBHOOK_TOKEN, ASAAS_API_KEY
--   (quando conectar cobrança)
-- ============================================================================

-- ============================================================================
-- v8 · ENDURECIMENTO DE PRODUÇÃO (espelho de supabase/migracao-v8-endurecimento.sql)
-- Mantido aqui para setup completo: badge do Suporte (RPC), limite de
-- reabertura (3), auditoria no banco p/ TODA escrita sensível (triggers com
-- antes→depois), trilha global p/ dev (admin_audit_list) e allowlist dev
-- única (Parte B: consolidação da conta dev).
-- ============================================================================
-- ========== PARTE A (aplicada antes do E2E final) ===========================

-- ========== 1. Contador de reaberturas ======================================
alter table public.support_tickets
  add column if not exists reopen_count int not null default 0;

-- bump_ticket: conta cada reabertura (saiu de resolvido/fechado → voltou)
create or replace function public.bump_ticket() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if new.status in ('resolvido','fechado') and old.status not in ('resolvido','fechado') then
    new.closed_at := now();
  end if;
  if new.status not in ('resolvido','fechado') then
    new.closed_at := null;   -- reaberto: volta a ser um ticket ativo
    if old.status in ('resolvido','fechado') then
      new.reopen_count := coalesce(old.reopen_count, 0) + 1;
    end if;
  end if;
  return new;
end $$;

-- ========== 2. Limite de reabertura (guard + resposta por mensagem) ========
-- Guard (PATCH direto): não-dev não reabre chamado já reaberto 3+ vezes.
create or replace function public.guard_ticket_flow() returns trigger
language plpgsql security definer set search_path = public as $$
declare actor_role text; is_owner boolean; auto boolean;
begin
  if auth.uid() is null then return new; end if;  -- service role / Edge / SQL Editor

  auto := coalesce(current_setting('app.ticket_auto_transition', true), 'off') = 'on';
  if auto then return new; end if;                -- transição automática da resposta

  select papel into actor_role from public.users where id = auth.uid();
  is_owner := (old.user_id = auth.uid());

  -- política de reabertura (máx. 3 por chamado; dev isento)
  if new.status not in ('resolvido','fechado') and old.status in ('resolvido','fechado')
     and coalesce(actor_role,'') <> 'dev'
     and coalesce(old.reopen_count, 0) >= 3 then
    raise exception 'REOPEN_LIMIT'
      using hint = 'Este chamado já foi reaberto 3 vezes. Abra um novo chamado de suporte.';
  end if;

  -- assignee: somente dev
  if new.assignee_id is distinct from old.assignee_id and coalesce(actor_role,'') <> 'dev' then
    raise exception 'FORBIDDEN'
      using hint = 'Somente a equipe JR Sistemas assume ou devolve tickets.';
  end if;

  -- status: dev sempre; dono pode (encerrar/confirmar/reabrir o próprio); demais não
  if new.status is distinct from old.status and coalesce(actor_role,'') <> 'dev' and not is_owner then
    raise exception 'FORBIDDEN'
      using hint = 'Somente quem abriu o ticket (ou a equipe JR) altera o status.';
  end if;

  -- prioridade/categoria: avaliação técnica é da equipe
  if (new.prioridade is distinct from old.prioridade or new.categoria is distinct from old.categoria)
     and coalesce(actor_role,'') <> 'dev' then
    raise exception 'FORBIDDEN'
      using hint = 'Prioridade e categoria são definidas pela equipe JR Sistemas.';
  end if;

  return new;
end $$;

-- Resposta que reabre conversa encerrada: aplica o MESMO limite (dev isento).
create or replace function public.bump_ticket_on_msg() returns trigger
language plpgsql security definer set search_path = public as $$
declare tk record;
begin
  if new.tipo = 'evento' then return new; end if;

  select status, reopen_count into tk from public.support_tickets where id = new.ticket_id;
  if not found then return new; end if;
  if tk.status in ('resolvido','fechado') and coalesce(tk.reopen_count, 0) >= 3
     and coalesce(new.sender_role, '') <> 'dev' then
    raise exception 'REOPEN_LIMIT'
      using hint = 'Este chamado já foi reaberto 3 vezes. Abra um novo chamado de suporte.';
  end if;

  -- flag de bypass: transição automática não passa pela regra "dono ou dev"
  perform set_config('app.ticket_auto_transition', 'on', true);
  update public.support_tickets t
     set updated_at = now(),
         assignee_id = case
           when new.sender_role = 'dev' and t.assignee_id is null then new.sender_id
           else t.assignee_id end,
         status = case
           when new.sender_role = 'dev' and t.status in ('aberto','em_andamento','aguardando_equipe','resolvido','fechado')
             then 'aguardando_cliente'
           when new.sender_role = 'dev'
             then t.status  -- já aguardando_cliente
           when new.sender_role is distinct from 'dev' and t.status in ('em_andamento','aguardando_cliente','resolvido','fechado')
             then 'aguardando_equipe'
           else t.status    -- cliente respondeu ticket aberto: continua na fila
         end
   where t.id = new.ticket_id;
  perform set_config('app.ticket_auto_transition', 'off', true);
  return new;
end $$;

-- ========== 3. RPC support_badge_counts (badge da sidebar + banner) =========
-- Dev  → filaEquipe      = chamados com a bola da equipe (aberto/aguardando_equipe)
-- User → aguardandoCliente= chamados da própria empresa aguardando resposta do cliente
create or replace function public.support_badge_counts() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare u record; c_client int := 0; c_equipe int := 0;
begin
  select id, tenant_id, papel into u from public.users where id = auth.uid();
  if u.id is null then raise exception 'UNAUTHORIZED'; end if;
  if u.papel = 'dev' then
    select count(*) into c_equipe from public.support_tickets
     where status in ('aberto','aguardando_equipe');
  else
    select count(*) into c_client from public.support_tickets
     where tenant_id = u.tenant_id and status = 'aguardando_cliente';
  end if;
  return jsonb_build_object('aguardandoCliente', c_client, 'filaEquipe', c_equipe,
                            'ts', (extract(epoch from now()) * 1000)::bigint);
end $$;
grant execute on function public.support_badge_counts() to authenticated;

-- ========== 4. AUDITORIA NO BANCO (triggers) ================================
-- 4a. Toda mudança de papel/ativo/nome de usuário gera trilha (antes→depois).
--     Cobre a rebaixa admin→caixa pela UI E por SQL/Edge (service role).
create or replace function public.audit_users_changes() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text; bits text[] := '{}'; b text;
begin
  b := case when new.papel is distinct from old.papel
            then 'papel: ' || old.papel || '→' || new.papel end;
  if b is not null then bits := array_append(bits, b); end if;
  b := case when new.ativo is distinct from old.ativo
            then 'ativo: ' || old.ativo::text || '→' || new.ativo::text end;
  if b is not null then bits := array_append(bits, b); end if;
  b := case when new.nome is distinct from old.nome
            then 'nome: ' || old.nome || '→' || new.nome end;
  if b is not null then bits := array_append(bits, b); end if;
  if cardinality(bits) = 0 then return new; end if;   -- mudança comum: ignora
  select nome into who from public.users where id = auth.uid();
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (new.tenant_id, auth.uid(), coalesce(who, case when auth.uid() is null then 'servidor (service role)' end, ''),
          'usuario.alterado', 'user', new.id::text,
          new.email || ' · ' || array_to_string(bits, ' · ') ||
          ' · origem: ' || case when auth.uid() is null then 'servidor (Edge/cron/SQL)' else 'aplicação' end);
  return new;
end $$;
drop trigger if exists trg_usr_audit on public.users;
create trigger trg_usr_audit after update on public.users
  for each row execute function public.audit_users_changes();

-- 4b. Toda mudança de coluna de COBRANÇA em tenants gera trilha (antes→depois).
--     Cobre Edge (ativar/suspender), cron, billing_refresh e SQL Editor —
--     nenhuma escrita sensível escapa mais (o "furo" apontado na revisão:
--     mudanças service role não deixavam rastro).
create or replace function public.audit_tenants_billing() returns trigger
language plpgsql security definer set search_path = public as $$
declare who text; bits text[]; b text;
begin
  if new.status              is not distinct from old.status
     and new.plan_id         is not distinct from old.plan_id
     and new.plan_cycle      is not distinct from old.plan_cycle
     and new.plan_expires_at is not distinct from old.plan_expires_at
     and new.next_charge_at  is not distinct from old.next_charge_at
     and new.canceled_at     is not distinct from old.canceled_at
     and new.cancel_reason   is not distinct from old.cancel_reason
     and new.trial_ends_at   is not distinct from old.trial_ends_at
     and new.plan_activation_reason is not distinct from old.plan_activation_reason then
    return new;   -- mudança operacional (nome/config/updated_at): sem trilha
  end if;
  b := case when new.status is distinct from old.status
            then 'status: ' || old.status || '→' || new.status end;
  if b is not null then bits := array_append(coalesce(bits, '{}'), b); end if;
  b := case when new.plan_id is distinct from old.plan_id
            then 'plano: ' || coalesce(old.plan_id,'—') || '→' || coalesce(new.plan_id,'—') end;
  if b is not null then bits := array_append(coalesce(bits, '{}'), b); end if;
  b := case when new.plan_expires_at is distinct from old.plan_expires_at
            then 'prazo: ' || coalesce(old.plan_expires_at::text,'—') || '→' || coalesce(new.plan_expires_at::text,'—') end;
  if b is not null then bits := array_append(coalesce(bits, '{}'), b); end if;
  b := case when new.next_charge_at is distinct from old.next_charge_at
            then 'próx.cobrança: ' || coalesce(old.next_charge_at::text,'—') || '→' || coalesce(new.next_charge_at::text,'—') end;
  if b is not null then bits := array_append(coalesce(bits, '{}'), b); end if;
  b := case when new.canceled_at is not distinct from old.canceled_at then null
            else 'cancelada: ' || coalesce(new.canceled_at::text,'—') end;
  if b is not null then bits := array_append(coalesce(bits, '{}'), b); end if;
  b := case when new.plan_activation_reason is distinct from old.plan_activation_reason
            then 'motivo: ' || coalesce(old.plan_activation_reason,'—') || '→' || coalesce(new.plan_activation_reason,'—') end;
  if b is not null then bits := array_append(coalesce(bits, '{}'), b); end if;

  select nome into who from public.users where id = auth.uid();
  insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
  values (new.id, auth.uid(),
          coalesce(who, case when auth.uid() is null then 'servidor (service role)' end, ''),
          'assinatura.alterada', 'tenant', new.id::text,
          new.nome || ' · ' || array_to_string(bits, ' · ') ||
          ' · origem: ' || case when auth.uid() is null then 'servidor (Edge/cron/SQL)' else 'aplicação' end);
  return new;
end $$;
drop trigger if exists trg_ten_audit on public.tenants;
create trigger trg_ten_audit after update on public.tenants
  for each row execute function public.audit_tenants_billing();

create index if not exists ix_audit_recent on public.audit_logs (created_at desc);

-- ========== 5. RLS: dev lê a trilha de auditoria GLOBAL =====================
drop policy if exists aud_sel_dev on public.audit_logs;
create policy aud_sel_dev on public.audit_logs for select
  using (public.is_dev());

-- ========== 6. RPC admin_audit_list (tela "Ações do admin", somente dev) ====
create or replace function public.admin_audit_list(p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare papel_dev text; rows jsonb;
begin
  select papel into papel_dev from public.users where id = auth.uid();
  if coalesce(papel_dev, '') <> 'dev' then raise exception 'FORBIDDEN'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'tenantId', a.tenant_id, 'tenantName', t.nome,
           'userName', coalesce(a.user_name, ''), 'acao', a.acao,
           'detalhes', a.detalhes, 'entidade', a.entidade, 'entidadeId', a.entidade_id,
           'at', a.created_at)
         order by a.created_at desc), '[]'::jsonb)
    into rows
    from (select * from public.audit_logs
           order by created_at desc
           limit least(greatest(coalesce(p_limit, 100), 1), 500)) a
    left join public.tenants t on t.id = a.tenant_id;
  return rows;
end $$;
grant execute on function public.admin_audit_list(int) to authenticated;

-- ========== PARTE B (consolidação da conta dev — aplicada após o E2E) =======

-- ========== 7. Allowlist dev: UM único e-mail oficial =======================
-- A conta oficial é a criada pelo dono (jrsistemasetecnologiabr@gmail.com —
-- sem ".br"), conforme histórico do projeto. A conta espelho
-- jrsistemasetecnologia.br@gmail.com (pré-configurada em E2Es anteriores) é
-- rebaixada abaixo. Allowlist = lista de e-mails que NASCEM dev no signup;
-- alterar só pelo dono do SaaS (SQL Editor ou migração versionada).
create or replace function public.dev_emails() returns text[]
language sql stable set search_path = public as $$
  select array['jrsistemasetecnologiabr@gmail.com']::text[]
$$;

-- ========== 8. Rebaixa + desativa a conta dev espelho =======================
update public.users
   set papel = 'admin', ativo = false, updated_at = now()
 where lower(email) = 'jrsistemasetecnologia.br@gmail.com'
   and papel = 'dev';

insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
select u.tenant_id, u.id, 'consolidação v8', 'conta.dev_consolidada', 'user', u.id::text,
       'conta dev espelho (.br) rebaixada para admin e desativada — allowlist dev passa a conter apenas a conta oficial do dono'
  from public.users u
 where lower(u.email) = 'jrsistemasetecnologia.br@gmail.com'
   and not exists (select 1 from public.audit_logs al
                    where al.acao = 'conta.dev_consolidada' and al.entidade_id = u.id::text);
