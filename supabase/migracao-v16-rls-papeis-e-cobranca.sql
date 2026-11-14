-- ============================================================================
-- LojaCerta · MIGRAÇÃO v16 — fecha escalada de papel, escrita direta em vendas
-- e pontas soltas da cobrança (achados da revisão de lógica do banco)
-- ----------------------------------------------------------------------------
-- 1. ESCALADA DE PRIVILÉGIO: usr_upd deixava QUALQUER usuário da loja alterar
--    qualquer linha de users → um caixa fazia PATCH papel='admin' em si mesmo.
--    Agora só admin altera usuários; ninguém troca id/tenant/e-mail pela API;
--    a loja nunca fica sem um admin ativo.
-- 2. ten_upd deixava o caixa alterar a config da loja (ex.: o próprio limite
--    de desconto e "permitir estoque negativo"). Agora só admin.
-- 3. sale_ins / sale_upd permitiam gravar/alterar venda direto na tabela,
--    sem baixa de estoque nem auditoria. Venda só existe via commit_sale /
--    cancel_sale (SECURITY DEFINER) — políticas removidas.
-- 4. commit_sale: o mesmo produto repetido no payload baixava o estoque uma
--    única vez (UPDATE … FROM) e furava a checagem de saldo. Agora é recusado.
-- 5. ticket_messages: remetente tem de ser o próprio usuário (sem spoof).
-- 6. Cobrança: loja em past_due nunca era suspensa (cron/guard só tratavam
--    'active') → uso gratuito indefinido após fatura vencida. Agora a
--    carência (next_charge_at) é respeitada e, vencida, vira read_only.
-- 7. Desempenho (advisors): auth.uid() avaliado 1× por consulta nas políticas,
--    índice duplicado removido, índices nas FKs mais consultadas.
-- Idempotente.
-- ============================================================================

-- ---------- 1/2/3/5/7 · políticas ----------
drop policy if exists usr_upd on public.users;
create policy usr_upd on public.users for update
  using (tenant_id = (select public.current_tenant_id()) and (select public.is_admin()))
  with check (tenant_id = (select public.current_tenant_id()) and (select public.is_admin()));

drop policy if exists ten_upd on public.tenants;
create policy ten_upd on public.tenants for update
  using (id = (select public.current_tenant_id()) and (select public.is_admin()))
  with check (id = (select public.current_tenant_id()) and (select public.is_admin()));

drop policy if exists sale_ins on public.sales;
drop policy if exists sale_upd on public.sales;

drop policy if exists sale_sel on public.sales;
create policy sale_sel on public.sales for select
  using (tenant_id = (select public.current_tenant_id())
         and ((select public.is_staff()) or user_id = (select auth.uid())));

drop policy if exists tick_ins on public.support_tickets;
create policy tick_ins on public.support_tickets for insert
  with check (tenant_id = (select public.current_tenant_id()) and user_id = (select auth.uid()));

drop policy if exists drafts_owner on public.ticket_drafts;
create policy drafts_owner on public.ticket_drafts for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists tmsg_ins on public.ticket_messages;
create policy tmsg_ins on public.ticket_messages for insert
  with check (
    sender_id = (select auth.uid())
    and exists (select 1 from public.support_tickets t
                where t.id = ticket_messages.ticket_id
                  and ((select public.is_dev()) or t.tenant_id = (select public.current_tenant_id()))));

-- ---------- 1 · integridade de users (vale para chamadas da API) ----------
create or replace function public.guard_users_integrity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;  -- service role / triggers do Auth / SQL Editor
  if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
     or new.email is distinct from old.email then
    raise exception 'FORBIDDEN' using hint = 'id, empresa e e-mail do usuário não mudam pela API.';
  end if;
  if old.papel = 'admin' and old.ativo and (new.papel <> 'admin' or not new.ativo) then
    if not exists (select 1 from public.users
                   where tenant_id = old.tenant_id and papel = 'admin' and ativo and id <> old.id) then
      raise exception 'LAST_ADMIN' using hint = 'A loja precisa de pelo menos um administrador ativo.';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.guard_users_integrity() from public, anon, authenticated;
drop trigger if exists trg_users_integrity on public.users;
create trigger trg_users_integrity before update on public.users
  for each row execute function public.guard_users_integrity();

-- ---------- 6 · cobrança: past_due com carência vencida ----------
create or replace function public.tenant_billing_ok() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare t uuid; st text; te timestamptz; pe timestamptz; nc timestamptz; pid text;
begin
  t := public.current_tenant_id();
  if t is null then return false; end if;
  select status, trial_ends_at, plan_expires_at, next_charge_at, plan_id
    into st, te, pe, nc, pid from public.tenants where id = t;
  if st is null then return false; end if;
  if st = 'trialing' and te < now() then return false; end if;                 -- trial vencido
  if st = 'active' and pid is distinct from 'dev'
     and pe is not null and pe < now() then return false; end if;              -- plano vencido
  if st = 'past_due' and coalesce(nc, pe, now()) <= now() then return false; end if; -- carência vencida
  return st in ('trialing','active','past_due');
end $$;

create or replace function public.cron_suspend_expired_plans() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; r record;
begin
  for r in
    select id, status, plan_expires_at, next_charge_at from public.tenants
    where plan_id is distinct from 'dev'
      and ( (status = 'active'   and plan_expires_at is not null and plan_expires_at < now())
         or (status = 'past_due' and coalesce(next_charge_at, plan_expires_at, now()) <= now()) )
  loop
    update public.tenants set status = 'read_only', updated_at = now() where id = r.id;
    insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
    values (r.id, null, 'cron', 'assinatura.suspensa', 'tenant', r.id::text,
            case when r.status = 'past_due'
                 then 'fatura em atraso — carência encerrada em ' || coalesce(r.next_charge_at, r.plan_expires_at, now())::text
                 else 'plano venceu em ' || r.plan_expires_at::text end || ' — suspensão automática (pg_cron)');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.cron_suspend_expired_plans() from public, anon, authenticated;

-- ---------- 4/6 · remendos cirúrgicos em funções grandes (sem reescrever o corpo) ----------
do $$
declare def text; novo text;
begin
  -- commit_sale: recusa produto repetido no payload
  def := pg_get_functiondef('public.commit_sale(jsonb)'::regprocedure);
  if position('DUP_ITEM' in def) = 0 then
    novo := regexp_replace(def,
      'raise\s+exception\s+''EMPTY_CART'';\s*end\s+if;',
      E'raise exception ''EMPTY_CART''; end if;\n  -- v16 (DUP_ITEM): mesmo produto 2× baixava o estoque só 1×\n  if (select count(*) <> count(distinct x->>''productId'') from jsonb_array_elements(p->''items'') x) then\n    raise exception ''VALIDATION'';\n  end if;');
    if novo = def then raise exception 'v16: âncora de commit_sale não encontrada'; end if;
    execute novo;
  end if;

  -- billing_refresh_status: past_due com carência vencida → read_only
  def := pg_get_functiondef('public.billing_refresh_status()'::regprocedure);
  if position('carência encerrada' in def) = 0 then
    novo := regexp_replace(def,
      'elsif\s+st\s*=\s*''active''',
      E'elsif st = ''past_due'' and coalesce(nc, pe, now()) <= now() then\n    update public.tenants set status = ''read_only'', updated_at = now() where id = t;\n    st := ''read_only'';\n    insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)\n    values (t, auth.uid(), (select nome from public.users where id = auth.uid()),\n            ''assinatura.suspensa'', ''tenant'', t::text, ''fatura em atraso — carência encerrada — modo leitura'');\n  elsif st = ''active''');
    if novo = def then raise exception 'v16: âncora de billing_refresh_status não encontrada'; end if;
    execute novo;
  end if;

  -- guard_tenants_billing: permite SÓ a suspensão automática past_due → read_only
  def := pg_get_functiondef('public.guard_tenants_billing()'::regprocedure);
  if position('past_due' in def) = 0 then
    novo := regexp_replace(def,
      'if\s+new\.status\s+is\s+distinct\s+from\s+old\.status',
      E'if old.status = ''past_due'' and new.status = ''read_only''\n     and coalesce(old.next_charge_at, old.plan_expires_at, now()) <= now()\n     and new.plan_expires_at is not distinct from old.plan_expires_at\n     and new.next_charge_at is not distinct from old.next_charge_at\n     and new.plan_id is not distinct from old.plan_id then\n    return new;\n  end if;\n  if new.status is distinct from old.status');
    if novo = def then raise exception 'v16: âncora de guard_tenants_billing não encontrada'; end if;
    execute novo;
  end if;
end $$;

-- ---------- 7 · índices ----------
drop index if exists public.ix_tick_status;  -- idêntico a ix_tick_fila
create index if not exists ix_mov_product      on public.stock_movements (product_id);
create index if not exists ix_prod_category    on public.products (category_id);
create index if not exists ix_tick_user        on public.support_tickets (user_id);
create index if not exists ix_tmsg_sender      on public.ticket_messages (sender_id);
create index if not exists ix_invites_tenant   on public.user_invites (tenant_id);
create index if not exists ix_delreq_tenant    on public.account_deletion_requests (tenant_id);
