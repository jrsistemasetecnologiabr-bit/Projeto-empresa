-- ============================================================================
-- LojaCerta · MIGRAÇÃO v5b — ANTI-ABUSO DO TESTE GRÁTIS + TRIAL NA CONFIRMAÇÃO
-- ----------------------------------------------------------------------------
-- 1) Anti-abuso de múltiplas contas em teste grátis:
--    · Toda intenção de cadastro é registrada em public.signup_audit com o IP
--      do cliente (capturado pela Edge Function "api") e um identificador de
--      navegador (cookie lc_did) como camada complementar.
--    · A RPC signup_begin (service role) valida atomicamente os limites
--      (padrão: 1 teste grátis por IP e 1 por dispositivo) ANTES da conta
--      existir; signup_abort devolve a vaga quando o cadastro falha.
--    · A trigger handle_new_user v4 consome a intenção ao criar o tenant:
--      cadastro direto no /auth/v1/signup sem passar pela guarda é recusado.
--    · Contas DEV (v5-billing-dev) e convites não consomem vaga de teste.
-- 2) Confirmação de e-mail obrigatória (código de 6 dígitos, nativo Supabase):
--    · O trial NÃO começa no cadastro: o tenant nasce com trial_pending=true
--      e a trigger handle_user_confirmed só liga os 14 dias quando o e-mail
--      é confirmado (código OU link — ambos caem no UPDATE de auth.users).
--    · billing_refresh_status() é redefinida para NÃO suspender tenant com
--      trial pendente (trial_ends_at = now() entre cadastro e confirmação).
-- COMO USAR: Supabase Dashboard → SQL Editor → cole TUDO → Run. Idempotente.
-- Roda antes ou depois da migracao-v5-billing-dev.sql (independentes).
-- Requer no Auth: "Confirm email" = ON e mailer_otp_exp = 600 (10 minutos)
-- (o script supabase/configurar-emails-templates.py já aplica via API).
-- ============================================================================

-- ---------- 1. TABELA DE AUDITORIA DE CADASTROS (IP + dispositivo) ----------
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
