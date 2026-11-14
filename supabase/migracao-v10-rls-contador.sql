-- ============================================================================
-- LojaCerta · Migração v10 — RLS do contador de tickets + trial_ends_at nullable
-- ============================================================================
-- Origem: auditoria v1.8.0 (P0-2D — RLS de TODAS as tabelas). A varredura
-- apontou que public.support_ticket_counters estava SEM Row Level Security,
-- permitindo leitura anônima dos contadores (tenant_id + sequência de tickets).
-- Impacto de confidencialidade baixo, mas toda tabela multi-tenant deve ter RLS.
--
-- Quem acessa essa tabela: apenas a função next_ticket_numero() (SECURITY
-- DEFINER, dono = postgres, que tem bypassrls) e o service_role. Logo, RLS
-- habilitado SEM policies (deny-all para anon/authenticated) fecha o buraco
-- sem quebrar a numeração de tickets — validado em produção com transação
-- de teste + rollback antes do deploy.
--
-- Parte 2: trial_ends_at passa a aceitar NULL — plano 'dev' não tem teste
-- grátis; o valor fake "ano 2226" era um placeholder da constraint NOT NULL.
-- Todos os usos (SQL e front) testam status='trialing' antes de ler o campo,
-- e o adapter já trata NULL. Default (now()+14d) preservado para novos tenants.

-- 1) Contador de tickets: RLS deny-all (só postgres/service_role tocam)
alter table public.support_ticket_counters enable row level security;
-- nenhuma policy criada de propósito: anon/authenticated não têm nada a fazer aqui

-- 2) Trial nullable (plano dev = sem teste grátis)
alter table public.tenants alter column trial_ends_at drop not null;

-- 3) Tenants dev existentes: trial NULL (idempotente)
update public.tenants set trial_ends_at = null, updated_at = now()
where plan_id = 'dev' and trial_ends_at is not null;

-- 4) Verificação (deve listar support_ticket_counters com rls=true e 0 policies)
--    e nenhum tenant dev com trial preenchido:
-- select c.relname, c.relrowsecurity,
--        (select count(*) from pg_policies p
--          where p.schemaname='public' and p.tablename=c.relname) as policies
--   from pg_class c join pg_namespace n on n.oid=c.relnamespace
--  where n.nspname='public' and c.relname='support_ticket_counters';
-- select id, nome, plan_id, trial_ends_at from public.tenants where plan_id='dev';
