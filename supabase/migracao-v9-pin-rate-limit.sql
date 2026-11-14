-- ============================================================================
-- LojaCerta · Migração v9 — ENDURECIMENTO DO PIN DE COBRANÇA (P0, hoje)
-- ============================================================================
-- Contexto (revisão externa da v1.7.1): o PIN de cobrança — 2º fator das ops
-- billing.activate_plan / billing.suspend_tenant — foi exposto numa conversa
-- de trabalho. Além da rotação imediata do secret (`supabase secrets set`
-- com a chave `DEV_PIN`), o mecanismo ganha as três propriedades que faltavam:
--
--   1. RASTRO   — toda tentativa (certa ou errada) vira linha em pin_attempts
--                 com ator, IP e horário; tentativa errada e bloqueio também
--                 geram audit_logs (acao 'pin.tentativa_falha' / 'pin.bloqueado'),
--                 visíveis na tela "Ações do admin" (RPC admin_audit_list);
--   2. LIMITE   — 5 tentativas erradas em 15 min, contadas por ator_id E por
--                 IP (janela deslizante), travam a operação por 15 min com
--                 HTTP 429 PIN_LOCKED — implementado na Edge Function (v20);
--   3. POLÍTICA — PIN configurado com menos de 12 caracteres é RECUSADO pela
--                 Edge (erro DEV_PIN_INSECURE). 8 chars alfanuméricos são
--                 brute-forçáveis em minutos; o novo PIN tem 24.
--
-- A tabela é de uso EXCLUSIVO do service role (Edge Function): RLS ligado sem
-- nenhuma policy + REVOKE para anon/authenticated — nem o front nem um JWT
-- roubado de usuário comum conseguem ler ou escrever aqui.

-- ========== 1. Tabela de tentativas do 2º fator ============================
create table if not exists public.pin_attempts (
  id         bigint generated always as identity primary key,
  actor_id   uuid        not null,
  actor_name text        not null default '',
  ip         text        not null default 'desconhecido',
  ok         boolean     not null default false,
  created_at timestamptz not null default now()
);

alter table public.pin_attempts enable row level security;
revoke all on public.pin_attempts from anon, authenticated;

create index if not exists ix_pin_attempts_window on public.pin_attempts (created_at desc);
create index if not exists ix_pin_attempts_actor  on public.pin_attempts (actor_id, created_at desc);
create index if not exists ix_pin_attempts_ip     on public.pin_attempts (ip, created_at desc);

-- ========== 2. Rastro da migração no audit (tela Ações do admin) ===========
insert into public.audit_logs (tenant_id, user_id, user_name, acao, entidade, entidade_id, detalhes)
select t.id, null, 'migração v9', 'migracao.aplicada', 'sql', 'v9-pin-rate-limit',
       'pin_attempts (RLS deny-all) + índices + cron de limpeza — rate limit 5×/15min por ator e IP na Edge v20'
  from public.tenants t
 where t.plan_id = 'dev'
   and not exists (select 1 from public.audit_logs al
                    where al.acao = 'migracao.aplicada' and al.entidade_id = 'v9-pin-rate-limit');

-- ========== 3. Limpeza diária (pg_cron) ====================================
-- A janela de lockout é de 15 min; 24 h de histórico é suficiente para
-- investigação e mantém a tabela pequena para sempre.
select cron.schedule(
  'pin-attempts-cleanup',
  '23 3 * * *',
  $$delete from public.pin_attempts where created_at < now() - interval '24 hours'$$
);
