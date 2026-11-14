-- ============================================================================
-- LojaCerta · MIGRAÇÃO v7 — Fluxo de atendimento (máquina de estados de tickets)
-- ----------------------------------------------------------------------------
-- APlicada em produção em 2026-11-10. Idempotente (pode reexecutar).
--
-- Problema que resolve (relato do cliente: "tem opção de encerrado, voltar pra
-- fila ou atender, só que não tá muito funcional"):
--   · O status era um seletor livre sem semântica de "de quem é a bola".
--   · Qualquer membro do tenant podia mudar o status do ticket de outro.
--   · Não havia rastro de quem mudou o quê (auditoria por transição).
--   · Não havia responsável (assignee) nem fila pessoal para o dev.
--
-- Modelo novo (o status reflete DE QUEM É A BOLA no momento):
--   aberto              → na fila, ninguém da equipe assumiu ainda      (bola: equipe)
--   em_andamento        → dev assumiu e está trabalhando                (bola: dev)
--   aguardando_cliente  → equipe respondeu, espera o cliente            (bola: cliente)
--   aguardando_equipe   → cliente respondeu, espera a equipe            (bola: equipe)
--   resolvido           → solução proposta, aguardando confirmação
--   fechado             → encerrado definitivamente (reabre com mensagem)
--
-- Quem pode mudar o quê (guard no banco, além do RLS):
--   · DEV: tudo (atender, voltar à fila, resolver, fechar, reabrir, prioridade,
--     categoria, assignee).
--   · DONO do ticket (quem abriu): encerrar (→ resolvido) e confirmar resolução
--     (resolvido → fechado). Sem seletor livre de status.
--   · Outros membros do tenant: apenas respondem (a resposta move o status
--     automaticamente para aguardando_equipe).
--   · Transições automáticas (resposta move a bola) são feitas por trigger com
--     flag de bypass — não passam pela regra "dono ou dev".
--
-- Auditoria: toda transição de status gera uma linha em ticket_messages com
-- tipo='evento' (formato 'status:<de>><para>'), visível na conversa como
-- "Fulano alterou o status: X → Y". Funciona no banco real e no modo demo.
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
