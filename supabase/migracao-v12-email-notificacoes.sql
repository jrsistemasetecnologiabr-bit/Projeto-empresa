-- ============================================================================
-- LojaCerta · Migração v12 — Notificação por e-mail (Resend via pg_net + Vault)
-- ----------------------------------------------------------------------------
-- ONDA 5 do fechamento para produção (P1: badge in-app não alcança cliente
-- inativo). A infraestrutura fica 100% no banco — funciona mesmo quando a
-- escrita vem do app, da Edge ou do SQL Editor:
--   · email_log: trilha de todo envio (status: dispatched | skipped_no_key |
--     error) — sem RLS para usuário comum (acesso exclusivo service/owner).
--   · send_email(): lê a chave da API no Supabase VAULT (segredo
--     'resend_api_key'). SEM a chave, registra skipped_no_key e NÃO quebra
--     nada — o dono ativa o envio real inserindo a chave (runbook no README).
--   · Trigger na resposta da equipe (ticket_messages tipo 'mensagem',
--     sender admin/gerente/dev) → e-mail ao cliente dono do ticket.
--   · notify_expiring_plans() + cron diário 12:10 UTC (09:10 BRT): avisa
--     planos que vencem em ≤7 dias (idempotente por dia via email_log).
-- Requisitos: extensão pg_net (habilitada nesta onda) e, para envio real,
-- 'resend_api_key' e 'email_from' no Vault (passo do dono, documentado).
-- ============================================================================

-- ---------- 1 · trilha de e-mails ----------
create table if not exists public.email_log (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references public.tenants(id) on delete cascade,
  to_email   text not null,
  template   text not null default 'ad_hoc',
  subject    text not null default '',
  status     text not null default 'queued',   -- queued | dispatched | skipped_no_key | error
  detail     text,
  request_id bigint,                            -- id do pg_net (rastreio)
  created_at timestamptz not null default now()
);
create index if not exists email_log_tenant_idx on public.email_log (tenant_id, created_at desc);
create index if not exists email_log_template_idx on public.email_log (template, tenant_id, ((created_at at time zone 'utc')::date));
alter table public.email_log enable row level security;
-- sem policies: escrita apenas por SECURITY DEFINER/service role; leitura dev-only
-- (a tela "Ações do admin" pode expor futuramente; hoje só o owner via SQL/Dashboard)

-- ---------- 2 · envio (Resend) ----------
create or replace function public.send_email(
  p_to text, p_subject text, p_html text,
  p_tenant uuid default null, p_template text default 'ad_hoc'
) returns uuid
language plpgsql
security definer
set search_path = 'public', 'vault', 'net'
as $$
declare
  v_key text; v_from text; v_id uuid; v_rid bigint;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'resend_api_key' limit 1;
  v_from := coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'email_from' limit 1),
                     'LojaCerta <onboarding@resend.dev>');

  insert into public.email_log (tenant_id, to_email, template, subject, status)
  values (p_tenant, p_to, p_template, p_subject, 'queued')
  returning id into v_id;

  if v_key is null or v_key = '' then
    update public.email_log set status = 'skipped_no_key',
      detail = 'segredo resend_api_key ausente no Vault — ver runbook de e-mail no README'
    where id = v_id;
    return v_id;
  end if;

  begin
    v_rid := net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key),
      body := jsonb_build_object(
        'from', v_from,
        'to', jsonb_build_array(p_to),
        'subject', p_subject,
        'html', p_html)
    );
    update public.email_log set status = 'dispatched', request_id = v_rid where id = v_id;
  exception when others then
    update public.email_log set status = 'error', detail = left(sqlerrm() || ' / ' || coalesce(sqlstate(),''), 300) where id = v_id;
  end;
  return v_id;
end $$;

-- ---------- 3 · resposta da equipe → e-mail ao cliente ----------
create or replace function public.notify_ticket_reply()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_requester uuid; v_email text; v_nome text; v_numero int; v_assunto text; v_tenant uuid;
begin
  if new.tipo <> 'mensagem' then return new; end if;
  if new.sender_role not in ('admin','gerente','dev') then return new; end if;

  select t.user_id, t.numero, t.assunto, t.tenant_id
    into v_requester, v_numero, v_assunto, v_tenant
    from public.support_tickets t where t.id = new.ticket_id;
  if v_requester is null or v_requester = new.sender_id then return new; end if;  -- sem auto-e-mail

  select u.email, u.nome into v_email, v_nome from public.users u where u.id = v_requester;
  if v_email is null or v_email = '' then return new; end if;

  perform public.send_email(
    v_email,
    'Ticket #' || v_numero || ' — a equipe respondeu sua solicitação',
    '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">'
      || '<div style="background:#0B1220;color:#fff;padding:16px 22px;font-weight:700">Loja<span style="color:#FB923C">Certa</span> · Suporte</div>'
      || '<div style="padding:22px;color:#334155;font-size:14px;line-height:1.6">'
      || '<p>Olá, ' || coalesce(v_nome, 'tudo bem?') || '!</p>'
      || '<p>Sua solicitação <b>#' || v_numero || ' — ' || coalesce(v_assunto, '') || '</b> tem uma nova resposta da nossa equipe.</p>'
      || '<p style="margin:22px 0"><a href="https://jrsistemasetecnologiabr-bit.github.io/Projeto-empresa/#/app/suporte" style="background:#C2410C;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700">Ver a resposta no sistema</a></p>'
      || '<p style="color:#64748B;font-size:12px">Você recebe este e-mail porque tem uma conta LojaCerta. Se preferir, responda pelo próprio sistema.</p>'
      || '</div></div>',
    v_tenant,
    'ticket_resposta'
  );
  return new;
end $$;

drop trigger if exists trg_ticket_reply_email on public.ticket_messages;
create trigger trg_ticket_reply_email
  after insert on public.ticket_messages
  for each row execute function public.notify_ticket_reply();

-- ---------- 4 · digest diário de planos vencendo (≤7 dias) ----------
create or replace function public.notify_expiring_plans()
returns integer
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  r record; v_enviados int := 0; v_dias int;
begin
  for r in
    select t.id as tenant_id, t.nome, t.plan_expires_at, u.email, u.nome as contato
      from public.tenants t
      join public.users u on u.tenant_id = t.id and u.papel = 'admin' and u.ativo
     where t.status = 'active'
       and t.plan_expires_at between now() and now() + interval '7 days'
       and not exists (  -- idempotente: 1 e-mail por tenant por dia
         select 1 from public.email_log e
          where e.tenant_id = t.id and e.template = 'plano_expirando'
            and (e.created_at at time zone 'utc')::date = (now() at time zone 'utc')::date)
       and not exists (select 1 from unnest(public.dev_emails()) d(e) where lower(e) = lower(u.email))
  loop
    v_dias := greatest(1, ceil(extract(epoch from (r.plan_expires_at - now())) / 86400)::int);
    perform public.send_email(
      r.email,
      'Sua assinatura LojaCerta vence em ' || v_dias || ' dia(s)',
      '<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">'
        || '<div style="background:#0B1220;color:#fff;padding:16px 22px;font-weight:700">Loja<span style="color:#FB923C">Certa</span> · Assinatura</div>'
        || '<div style="padding:22px;color:#334155;font-size:14px;line-height:1.6">'
        || '<p>Olá, ' || coalesce(r.contato, 'tudo bem?') || '!</p>'
        || '<p>A assinatura da loja <b>' || r.nome || '</b> vence em <b>' || v_dias || ' dia(s)</b> (' || to_char(r.plan_expires_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') || ' horário de Brasília).</p>'
        || '<p>Para não perder o acesso ao PDV e ao estoque, renove em: Assinatura → Renovar plano.</p>'
        || '<p style="margin:22px 0"><a href="https://jrsistemasetecnologiabr-bit.github.io/Projeto-empresa/#/app/assinatura" style="background:#C2410C;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700">Abrir assinatura</a></p>'
        || '</div></div>',
      r.tenant_id,
      'plano_expirando'
    );
    v_enviados := v_enviados + 1;
  end loop;
  return v_enviados;
end $$;

select cron.schedule(
  'notify-expiring-emails',
  '10 12 * * *',   -- 12:10 UTC = 09:10 de Brasília (logo após o warn-expiring-plans de 12:00)
  $$select public.notify_expiring_plans()$$
)
where not exists (select 1 from cron.job where jobname = 'notify-expiring-emails');
