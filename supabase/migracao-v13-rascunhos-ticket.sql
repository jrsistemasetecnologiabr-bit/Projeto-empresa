-- ============================================================================
-- LojaCerta · Migração v13 — Rascunhos de ticket no banco (P3 da auditoria)
-- ----------------------------------------------------------------------------
-- Hoje os rascunhos (resposta em andamento + novo ticket) vivem só em
-- localStorage: trocar de navegador/máquina ou limpar o armazenamento perde o
-- texto. A partir da v13 o rascunho também persiste no banco (por usuário +
-- chave do ticket), com localStorage mantido como cópia offline (fallback).
--
--   chave = uuid do ticket (rascunho de resposta) · 'novo' (novo ticket)
--   RLS: cada usuário lê/escreve APENAS os próprios rascunhos.
--   RPCs invoker (RLS aplicada): draft_get / draft_save (upsert) / draft_del.
-- Limpeza: ON DELETE CASCADE no user e no tenant; ticket fechado → o app apaga.
-- ============================================================================

create table if not exists public.ticket_drafts (
  user_id    uuid not null references auth.users(id) on delete cascade,
  key        text not null check (key ~ '^[a-z0-9-]{1,40}$'),   -- uuid do ticket ou 'novo'
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  conteudo   text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.ticket_drafts enable row level security;
drop policy if exists drafts_owner on public.ticket_drafts;
create policy drafts_owner on public.ticket_drafts
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create or replace function public.ticket_draft_get(p_key text)
returns text
language sql
security invoker
set search_path = 'public'
as $$
  select d.conteudo from public.ticket_drafts d
   where d.user_id = auth.uid() and d.key = p_key;
$$;

create or replace function public.ticket_draft_save(p_key text, p_conteudo text)
returns void
language plpgsql
security invoker
set search_path = 'public'
as $$
begin
  if auth.uid() is null then raise exception 'UNAUTHORIZED'; end if;
  if p_key !~ '^[a-z0-9-]{1,40}$' then raise exception 'VALIDATION'; end if;
  insert into public.ticket_drafts (user_id, key, tenant_id, conteudo, updated_at)
  values (auth.uid(), p_key, public.current_tenant_id(), left(p_conteudo, 20000), now())
  on conflict (user_id, key) do update
     set conteudo = left(p_conteudo, 20000), updated_at = now();
end $$;

create or replace function public.ticket_draft_del(p_key text)
returns void
language sql
security invoker
set search_path = 'public'
as $$
  delete from public.ticket_drafts where user_id = auth.uid() and key = p_key;
$$;

revoke execute on function public.ticket_draft_get(text) from public;
revoke execute on function public.ticket_draft_save(text, text) from public;
revoke execute on function public.ticket_draft_del(text) from public;
grant execute on function public.ticket_draft_get(text) to authenticated;
grant execute on function public.ticket_draft_save(text, text) to authenticated;
grant execute on function public.ticket_draft_del(text) to authenticated;

comment on table public.ticket_drafts is 'Rascunhos de ticket por usuário (resposta/novo) — substitui o localStorage como fonte primária; localStorage segue como fallback offline';
