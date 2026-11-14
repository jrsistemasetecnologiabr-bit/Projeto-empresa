-- ============================================================================
-- LojaCerta · MIGRAÇÃO v6 — Planos com prazo no BANCO (plan_expires_at)
-- ----------------------------------------------------------------------------
-- APLICADA EM PRODUÇÃO em 2026-11-10. Idempotente (pode reexecutar).
--
-- Contexto do problema que resolve:
--   · A ativação de plano pelo Dev era binária (ativa = infinito). O frontend
--     (v1.6.0) já calcula e envia o prazo; agora o BANCO persiste de verdade.
--   · Contas pagas com prazo vencido são suspensas AUTOMATICAMENTE
--     (server-side via pg_cron), sem depender do navegador do cliente.
--   · A Edge Function (api/index.ts) foi atualizada na mesma data para aceitar
--     { days, expiresAt, reason, extend } em billing.activate_plan.
--
-- Compatibilidade: idempotente (if not exists / create or replace).
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
