-- ============================================================================
-- LojaCerta · MIGRAÇÃO v4 — Área de Suporte (tickets) + Convites + papel dev
-- ----------------------------------------------------------------------------
-- Rodar no SQL Editor após o setup completo (schema.sql). Idempotente.
-- Componentes:
--   0. LIMPEZA dos dados de QA (uma vez — comentar se já executou)
--   1. Papel 'dev' (equipe JR Sistemas) + guarda anti-escalonamento
--   2. Convites de equipe (user_invites) com token validado por trigger
--   3. Suporte: support_tickets + ticket_messages + contadores + RLS
--   4. handle_new_user v2: aceita convites (tenant existente) ou cria tenant
-- ============================================================================

-- ---------- 0. LIMPEZA DE DADOS QA (executar UMA vez) ------------------------
-- Remove todos os tenants/usuários de teste criados pela automação de QA.
-- (auth.users → cascade em public.users; tenants → cascade em todo o resto)
delete from public.tenants where nome ilike 'QA %' or nome ilike 'QA_%';
delete from auth.users u
 where exists (select 1 from public.users pu where pu.id = u.id)
   and not exists (
     select 1 from public.users pu2
      join public.tenants t on t.id = pu2.tenant_id
      where pu2.id = u.id and t.nome not ilike 'QA %' and t.nome not ilike 'QA_%'
   );
delete from public.webhook_events;

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
