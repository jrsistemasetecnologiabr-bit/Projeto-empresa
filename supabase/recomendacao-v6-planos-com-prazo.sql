-- ============================================================================
-- LojaCerta · RECOMENDAÇÃO v6 — Planos com prazo no BANCO (plan_expires_at)
-- ----------------------------------------------------------------------------
-- ⚠️ ESTE ARQUIVO É RECOMENDAÇÃO — NÃO EXECUTAR AINDA.
-- O frontend (v1.5.0) já está pronto para estas colunas e degrada graciosamente
-- enquanto elas não existirem (mantém o prazo calculado localmente na ativação).
-- Aplicar quando for hora de ajustar o backend, na ordem: 1 → 6.
--
-- Contexto do problema que resolve:
--   · Ativação de plano pelo Dev era binária (ativa = infinito). Agora o Dev
--     define PRAZO no frontend (30/90/180/365 dias ou data custom) e o cálculo
--     de `plan_expires_at` já roda no cliente — mas o BANCO ainda não persiste.
--   · Contas pagas com prazo vencido precisam ser suspensas AUTOMATICAMENTE
--     (server-side), sem depender do navegador do cliente estar aberto.
--   · Quem fecha ticket deve ser o dono do ticket ou dev (hoje qualquer membro
--     do tenant pode atualizar status na RLS).
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

-- Índice para o varredura do cron (só as lojas ativas interessam).
create index if not exists ix_tenants_plan_expires
  on public.tenants (plan_expires_at)
  where status = 'active';

-- ========== 2. billing_refresh_status() — também vira plano VENCIDO ========
-- Hoje só trata trial vencido. Passa a tratar plano pago vencido e a devolver
-- planExpiresAt para o frontend (Billing.syncRemote já lê esse campo).

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
-- O guard atual (v5) lista as colunas protegidas uma a uma; adicionar
-- plan_expires_at / plan_activated_* e permitir a transição active→read_only
-- quando o próprio plano já está vencido (só suspende, nunca libera).

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
-- O frontend (checkTrial/statusInfo) já reflete isso; o cron garante mesmo
-- com o cliente offline, e a próxima sincronização dele pega o estado novo.

-- 5.1 habilitar a extensão (uma vez por projeto; exigido pelo Supabase):
-- create extension if not exists pg_cron;

-- 5.2 função de varredura (security definer para tocar todos os tenants):
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

-- 5.3 agendamento horário (ajustar '5 * * * *' ao gosto; mínimo 5 min):
-- select cron.schedule(
--   'suspend-expired-plans',
--   '5 * * * *',
--   $$select public.cron_suspend_expired_plans();$$
-- );

-- 5.4 (opcional, recomendado) e-mail de aviso 5 dias antes de vencer —
-- enfileirar para a Edge Function de e-mails ou gravar em uma tabela de
-- notificações; o banner da página Assinatura (v1.5.0) já avisa na UI:
-- select cron.schedule(
--   'warn-expiring-plans',
--   '0 12 * * *',
--   $$insert into public.audit_logs (tenant_id, acao, entidade, entidade_id, detalhes)
--     select id, 'plano.expirando', 'tenant', id::text, 'vence em <=5 dias'
--     from public.tenants
--     where status = 'active' and plan_expires_at between now() and now() + interval '5 days';$$
-- );

-- ========== 6. Edge Function billing.activate_plan — aceitar PRAZO =========
-- O frontend (v1.5.0) JÁ ENVIA: { tenantId, planId, cycle, days, expiresAt,
-- reason, extend }. Patch sugerido em supabase/functions/api/index.ts:
--
--   case "billing.activate_plan": {
--     if (me.papel !== "dev") return fail("FORBIDDEN", "Somente a equipe JR Sistemas ativa planos.", 403);
--     const tenantId = String(p.tenantId || "");
--     if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))
--       return fail("VALIDATION", "Empresa inválida.");
--     const planId = String(p.planId || "");
--     if (!["essencial", "profissional", "premium"].includes(planId))
--       return fail("VALIDATION", "Plano inválido.");
--     const cycle = p.cycle === "anual" ? "anual" : "mensal";
--     const days = parseInt(String(p.days || ""), 10);
--     const reason = String(p.reason || "pix").slice(0, 120);
--     if (!(days > 0)) return fail("VALIDATION", "Duração inválida.");
--
--     // base de cálculo: estender usa o vencimento atual (soma dias restantes);
--     // o frontend já manda `expiresAt` calculado — confiar, mas revalidar:
--     const current = await sr(`/rest/v1/tenants?select=status,plan_expires_at&id=eq.${tenantId}`);
--     const cur = (await current.json())[0] || {};
--     const base = (p.extend === true && cur.status === "active" && cur.plan_expires_at &&
--                   new Date(cur.plan_expires_at) > new Date())
--       ? new Date(cur.plan_expires_at).getTime() : Date.now();
--     const expiresAt = new Date(base + days * 864e5).toISOString();
--
--     const upd = await sr(`/rest/v1/tenants?id=eq.${tenantId}`, {
--       method: "PATCH",
--       body: JSON.stringify({
--         status: "active",
--         plan_id: planId,
--         plan_cycle: cycle,
--         plan_expires_at: expiresAt,
--         plan_activated_by: me.id,
--         plan_activated_at: new Date().toISOString(),
--         plan_activation_reason: reason,
--         next_charge_at: expiresAt,
--         canceled_at: null,
--         cancel_reason: "",
--       }),
--     });
--     if (!upd.ok) return fail("SERVICE", "Não foi possível ativar o plano agora.");
--     await sr("/rest/v1/audit_logs", { method: "POST", body: JSON.stringify({
--       tenant_id: tenantId, user_id: me.id, user_name: me.nome,
--       acao: "plano.ativado", entidade: "tenant", entidade_id: tenantId,
--       detalhes: `plano ${planId} (${cycle}) por ${days} dias até ${expiresAt} · motivo: ${reason}`,
--     })});
--     return json({ ok: true, status: "active", planId, cycle, planExpiresAt: expiresAt, nextChargeAt: expiresAt });
--   }
--
-- Também em billing.tenant_info, incluir a coluna no select:
--   `/rest/v1/tenants?select=nome,status,plan_id,plan_cycle,plan_expires_at,plan_activation_reason,trial_ends_at,next_charge_at,canceled_at&id=eq.${tenantId}`
-- (O adapter do frontend já normaliza plan_expires_at → planExpiresAt.)

-- ========== 7. RLS de tickets — fechar só quem abriu (ou dev) ==============
-- Hoje `tick_upd` permite qualquer membro do tenant atualizar status. Recomendado:
create or replace function public.can_manage_ticket(t public.support_tickets) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_dev() or t.user_id = auth.uid();
$$;

-- e trocar a policy:
-- drop policy if exists tick_upd on public.support_tickets;
-- create policy tick_upd on public.support_tickets for update
--   using (public.is_dev() or tenant_id = public.current_tenant_id())
--   with check (public.is_dev() or tenant_id = public.current_tenant_id());
-- (o refinamento por campo — status só via can_manage_ticket — pode ser feito
--  com um trigger BEFORE UPDATE semelhante ao guard de billing; o frontend
--  v1.5.0 já impõe a regra "dono fecha", e o MockAdapter também.)

-- ========== 8. Backfill das contas atuais (opcional) =======================
-- Lojas ativas hoje (ativadas sem prazo pela v5): definir um prazo inicial
-- para entrar no regime, ex. 30 dias a partir da migração:
-- update public.tenants
--    set plan_expires_at = now() + interval '30 days'
--  where status = 'active' and plan_id is distinct from 'dev'
--    and plan_expires_at is null;
