-- ============================================================================
-- LojaCerta · MIGRAÇÃO v8 — Endurecimento de produção (pós-auditoria v1.7.0)
-- ----------------------------------------------------------------------------
-- APLICADA EM PRODUÇÃO em 2026-11-10 (Parte A antes do E2E; Parte B —
-- consolidação da conta dev — imediatamente após o E2E final). Idempotente.
--
-- Origem: revisão externa (DeepSeek) da v1.7.0. Resolve:
--   2.3 Notificações      → RPC support_badge_counts(): badge na sidebar +
--                           banner persistente (frontend), com polling 60s.
--   2.4 Conta dev dupla   → allowlist dev_emails() passa a ter UM e-mail
--                           (o da conta criada pelo dono); a conta espelho
--                           (.br) é rebaixada e desativada (Parte B).
--   2.5 Audit trail       → triggers de auditoria no BANCO para TODA escrita
--                           sensível (papel/ativo de usuários e colunas de
--                           cobrança de tenants), com antes→depois — cobre
--                           também mudanças via SQL Editor/service role que
--                           não passam pela Edge Function. RPC admin_audit_list
--                           para a tela "Ações do admin" (só dev).
--   2.7 Timezone          → sem grace period necessário: plan_expires_at é um
--                           instante absoluto (timestamptz) contado do
--                           aniversário da ativação; o cron compara pe < now()
--                           e portanto NUNCA suspende antes do instante (pior
--                           caso: até ~1h depois, granularidade horária do
--                           cron às :05). Testado nos limites ±30min/±30s.
--   2.9 Reabertura        → politica de reabertura: no máximo 3 reaberturas
--                           por chamado para o cliente (dev é isento e pode
--                           sempre reabrir). Na 4ª tentativa o banco recusa
--                           com REOPEN_LIMIT e orienta abrir novo chamado.
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
