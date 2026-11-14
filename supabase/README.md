# LojaCerta · Conexão do backend Supabase (passo a passo manual)

O front já está 100% pronto para produção: ele fala com `ApiClient` e escolhe o adapter
sozinho (`src/js/adapters.js`). Este guia é o único trabalho manual restante.

## 1. Provisionar

1. Crie um projeto em [supabase.com](https://supabase.com) (região `sa-east-1`).
2. Abra **SQL Editor** e execute todo o conteúdo de `supabase/schema.sql`
   (tabelas, índices, RLS, triggers de signup e categorias padrão) — já inclui
   a v5 (dev ilimitado + trial único com suspensão server-side) e a v5b
   (anti-abuso do teste grátis + trial na confirmação do e-mail).
   Bancos que já tinham a v4: execute `supabase/migracao-v5-billing-dev.sql` e
   `supabase/migracao-v5-anti-abuso.sql`, nesta ordem (ambas idempotentes).
   **Depois do `schema.sql`, rode as migrações posteriores NESTA ordem** (todas
   idempotentes; o `schema.sql` espelha o banco só até a v8):
   `migracao-v9-pin-rate-limit.sql` → `v10-rls-contador` → `v11-idempotencia-audit-ip`
   → `v12-email-notificacoes` → `v13-rascunhos-ticket` → `v14-revoga-rpc-internas`
   → `v15-asaas` → `v16-rls-papeis-e-cobranca`. O projeto de produção
   (`qmqllssextbxwwphawod`) já está com todas aplicadas.
3. Confirme em **Authentication → Providers** que *Email* está ativo
   (desative signup anônimo; opcional: magic link).
4. Rode `python3 supabase/configurar-emails-templates.py` (com seu token de acesso
   da API de gerenciamento) — aplica **confirmação de e-mail obrigatória**
   (`mailer_autoconfirm=false`), código com validade de **10 minutos**
   (`mailer_otp_exp=600`) e URLs de redirect. Observação Free: sem SMTP próprio o
   Supabase não deixa customizar o template — o e-mail de confirmação sai no
   formato padrão (link clicável), e o app aceita confirmação por link **ou**
   código; com SMTP próprio o script já deixa o template com o código em destaque.

## 2. Edge Functions

```bash
supabase login
supabase link --project-ref SEU_REF
supabase secrets set ASAAS_API_KEY=... ASAAS_ENV=sandbox ASAAS_WEBHOOK_TOKEN=... DEV_PIN=...
supabase secrets set TRIAL_LIMIT_PER_IP=1 TRIAL_LIMIT_PER_DEVICE=1   # v5 (padrão: 1 e 1)
supabase functions deploy api
supabase functions deploy billing-webhook
```

- `api` → recebe `{op, payload}` do front (ops de negócio; escopo por tenant + auditoria).
  - `auth.signup` (v5b) → cadastro público com guarda anti-abuso: registra IP +
    identificador do navegador (`lc_did`), valida o limite de testes grátis por
    IP/dispositivo no banco (RPC `signup_begin`) e só então cria a conta no
    Supabase Auth — o e-mail de confirmação segue pelo fluxo nativo (código de
    6 dígitos, 10 min). Ajuste os limites em `TRIAL_LIMIT_PER_IP`/
    `TRIAL_LIMIT_PER_DEVICE` sem tocar em código.
  - `users.invite`/`users.invites`/`users.uninvite` → convites de equipe (admin).
  - `billing.cancel` → cancelamento persistido no servidor (admin da loja).
  - `billing.tenant_info`/`billing.activate_plan`/`billing.suspend_tenant` →
    ferramentas da equipe no painel de suporte (somente papel `dev`).
  - `account.request_deletion` → pedido LGPD de exclusão (usuário autenticado).
  - `cron.purge_deletions` → sweeper de exclusões vencidas, chamado pelo workflow
    keep-alive a cada 6h com o segredo compartilhado `PURGE_SECRET` (GitHub Secret).
  - Ops não implementadas retornam `NOT_IMPLEMENTED` — complete conforme a demanda.
- `billing-webhook` → URL pública = `https://SEU_REF.supabase.co/functions/v1/billing-webhook`.
  Cadastre essa URL no painel do gateway (Stripe: *Webhooks* → eventos `checkout.session.completed`,
  `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`; Asaas: webhook de assinatura).

## 3. Gateway de cobrança

- **Stripe**: crie Products/Prices espelhando `Billing.PLANS` (src/js/services.js);
  implemente `billing.create_checkout` em `functions/api/index.ts` (buscar preço por metadata
  `plan_id`/`cycle`, criar Checkout Session, retornar `{ url }`). O front já redireciona.
- **Asaas** (Pix Automático/boleto): mesma função, chamando a API de assinaturas do Asaas;
  o webhook já trata os eventos `CREATE_SUBSCRIPTION`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`,
  `DELETE_SUBSCRIPTION`.

## 4. Configurar o front

```bash
cp .env.example .env      # NUNCA commite o .env
# preencha:
#   ENV=production
#   API_BASE=https://SEU_REF.supabase.co
#   SUPABASE_ANON_KEY=eyJ...          (Settings → API → anon public)
#   BILLING_PROVIDER=stripe|asaas
#   STRIPE_PK=pk_live_...            (publishable, pode ir no front)
npm run build:prod        # gera release/producao/index.html com essas chaves embutidas
```

> A `anonKey` é pública por design (o RLS protege os dados). Segredos de verdade
> (`service_role`, `STRIPE_WEBHOOK_SECRET`) vivem **somente** nas Edge Functions.

## 5. Verificar

1. Sirva `release/producao/index.html` (Vercel/Netlify/S3).
2. Cadastre uma conta → a Edge Function registra IP/dispositivo, cria a conta com
   **e-mail pendente** (trial não começou) e o Supabase envia o código de 6 dígitos
   (válido por 10 min). Informe o código no app → conta ativa e **trial de 14 dias
   começa agora**. Tentar criar uma 2ª conta de teste grátis no mesmo IP/navegador
   responde `TRIAL_LIMIT` ("contrate o plano pago").
3. Sem preencher o gateway, qualquer mutação deve responder de forma clara
   (`NOT_CONFIGURED`/`NOT_IMPLEMENTED`) — é o comportamento esperado até conectar o billing.
4. `npm test` continua testando o bundle **demo**; para testar o bundle prod sem backend,
   abra o console: `Config.env` deve ser `production` e `ApiClient.adapter !== MockAdapter`.

## 6. Anti-abuso do teste grátis + confirmação de e-mail (v5b) — como funciona

**Regra (Tarefa "1 teste grátis por IP", configurável):**

- Cada cadastro público passa pela Edge Function `api` (op `auth.signup`), que grava
  em `public.signup_audit`: e-mail, **IP real** do cliente e o **identificador do
  navegador** (cookie `lc_did`, 1 ano — camada complementar para IP compartilhado/4G).
- A RPC `signup_begin` (service role, advisory locks) conta os testes grátis daquele
  IP/dispositivo (contas criadas + reservas dos últimos 30 min) e recusa com
  `TRIAL_IP_LIMIT`/`TRIAL_DEVICE_LIMIT` acima do limite → o front mostra
  "Já existe uma conta usando o teste grátis nesta rede… contrate o plano pago".
- Contas **pagas diretas** e convites não contam no limite (`trial_granted=false`);
  se o cadastro falhar após a reserva, `signup_abort` devolve a vaga.
- Ajuste sem deploy: `supabase secrets set TRIAL_LIMIT_PER_IP=2 TRIAL_LIMIT_PER_DEVICE=2`.
  Consulta de uso: `select ip, count(*) filter (where consumed), max(created_at)
  from signup_audit group by ip order by 2 desc;`

**Confirmação de e-mail (nativa do Supabase, sem código customizado):**

- `mailer_autoconfirm=false` → a conta nasce inativa; `mailer_otp_exp=600` →
  código com **validade de 10 minutos**, uso único (aplicado pelo
  `configurar-emails-templates.py`).
- O tenant nasce com `trial_pending=true`; a trigger `handle_user_confirmed`
  liga os 14 dias só quando o e-mail é confirmado (código **ou** link).
- Tentativas erradas: 5 (depois o código invalida — pedir novo). Reenvio: até
  3 por 10 min. Login antes de confirmar → bloqueado com mensagem clara.
- **Plano Free (sem SMTP próprio)**: o template padrão do Supabase traz o link
  de confirmação (sem o código de 6 dígitos) — o app confirma por link na
  mesma lógica (trigger no UPDATE de `auth.users`). Com SMTP próprio, o
  `configurar-emails-templates.py` aplica o template com o código em destaque
  e os dois caminhos ficam disponíveis.

## Segurança (revisar antes do go-live)

- [ ] RLS ativo em todas as tabelas (o schema já entrega) + teste de isolamento entre tenants
- [ ] Webhook com assinatura verificada (o código já verifica Stripe; Asaas por token)
- [ ] Rate limit nas Edge Functions (Supabase → Gateway/Cloudflare)
- [ ] Backups automáticos + drill de restauração (Supabase → Database → Backups)
- [ ] Domínio próprio com HTTPS + headers CSP/`X-Frame-Options` no host estático
- [ ] Termos/Privacidade revisados por advogado (os bundled são modelo)
