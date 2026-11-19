-- LojaCerta · migração v17 — segredos de integração no Vault (aplicada)
-- Motivo: a gravação de Edge Function Secrets pelo painel/conector ficou
-- indisponível na véspera do go-live. As Edge Functions passam a ler a
-- configuração do Asaas do Vault (criptografado) e caem para as variáveis de
-- ambiente (Edge Function Secrets) se o Vault não tiver o nome.
--
-- Nomes aceitos (allowlist — nada além disso sai do Vault por aqui):
--   asaas_api_key        chave da API Asaas ($aact_prod_… = produção)
--   asaas_env            "production" | "sandbox" (opcional: o prefixo da chave decide)
--   asaas_webhook_token  token do header asaas-access-token do webhook
--
-- Gravar/trocar (SQL Editor — nunca commitar o valor):
--   select vault.create_secret('<valor>', 'asaas_api_key');
--   select vault.update_secret((select id from vault.secrets where name='asaas_api_key'), '<novo>');

create or replace function public.app_secret(p_name text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ds.decrypted_secret
    from vault.decrypted_secrets ds
   where ds.name = p_name
     and p_name in ('asaas_api_key', 'asaas_env', 'asaas_webhook_token')
   limit 1
$$;

revoke all on function public.app_secret(text) from public, anon, authenticated;
grant execute on function public.app_secret(text) to service_role;
