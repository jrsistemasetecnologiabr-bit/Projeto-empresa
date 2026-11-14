-- ============================================================================
-- LojaCerta · MIGRAÇÃO v15 — cobrança Asaas (webhook idempotente)
-- ----------------------------------------------------------------------------
-- • invoices.provider_id único → o webhook faz upsert (on_conflict=provider_id)
--   sem duplicar faturas quando o Asaas reenvia eventos.
-- • status 'cancelado' (fatura removida no Asaas) além de pendente/pago/falhou/refundado.
-- • Índice p/ a checagem de duplicidade CONFIRMED→RECEIVED no webhook.
-- Colunas reaproveitadas (sem renomear p/ não quebrar o front):
--   tenants.stripe_customer_id     = id do cliente Asaas   (cus_…)
--   tenants.stripe_subscription_id = id da assinatura Asaas (sub_…)
-- Idempotente.
-- ============================================================================
create unique index if not exists ux_invoices_provider_id on public.invoices (provider_id);

alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status = any (array['pendente','pago','falhou','refundado','cancelado']));

create index if not exists ix_webhook_events_payment
  on public.webhook_events ((payload->'payment'->>'id'))
  where tipo like 'asaas:%';
