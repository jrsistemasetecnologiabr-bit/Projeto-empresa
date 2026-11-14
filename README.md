# 🧱 LojaCerta — SaaS de gestão de estoque e vendas (multi-empresa)

Produto web completo (landing de marketing + aplicação SaaS multi-vertical) com PDV, estoque,
relatórios, central de suporte e multiusuário — **em produção real no Supabase** e publicado
no GitHub Pages a cada push na `main`.

> Status: **v1.9.3 — produção ativa** (backend Supabase + GitHub Pages + área de suporte).
> Site: https://jrsistemasetecnologiabr-bit.github.io/Projeto-empresa/
> Suporte dev: `jrsistemasetecnologiabr@gmail.com` (única conta `dev` — ver "Conta dev" abaixo).
> Segurança e pré-deploy: ver **`SECURITY.md`** (política de segredos, rotação de PIN, checklist de go-live).

## Começar agora

```bash
npm install                # deps de dev (opcional — build é zero-dependência)
npm run build              # bundle final single-file → release/index.html
npm run build:prod         # produção (lê .env: SITE_URL + API_BASE + SUPABASE_ANON_KEY)
npm run run-tests          # suíte reproduzível: sintaxe + build + smoke de produção (13 checks)
```

O deploy é automático: **push na `main` → GitHub Actions → Pages** (ver `.github/workflows/deploy-pages.yml`).

### Acessos e papéis

| Papel | O que vê |
|---|---|
| `admin` (1º cadastro da empresa) | Tudo + cancelamento de vendas + convites |
| `gerente` | Operação completa + relatórios + custos |
| `caixa` | PDV, vendas próprias e suporte |
| `dev` (equipe JR Sistemas) | Painel de suporte de TODAS as empresas + conta + ativação de planos com prazo + trilha global "Ações do admin" |

### Conta dev (allowlist de e-mails)

A função `public.dev_emails()` (schema) é uma **allowlist de e-mails que nascem com papel `dev`** no signup — acesso total, cross-tenant, sem prazo. Desde a v8 ela contém **um único e-mail** (a conta oficial do dono, `jrsistemasetecnologiabr@gmail.com`); a conta espelho `.br` foi rebaixada e desativada (linha `conta.dev_consolidada` no audit log). **Alterar a allowlist é responsabilidade exclusiva do dono do SaaS** (SQL Editor ou migração versionada) — cada e-mail adicionado é um super-admin. A escrita de cobrança (`billing.activate_plan` / `billing.suspend_tenant`) exige ainda o **PIN da equipe** (secret `DEV_PIN` no painel do Supabase ou via `supabase secrets set --from-stdin`; header `x-dev-pin`) como 2º fator leve — desde a v1.7.2 com **mínimo de 12 caracteres, rate limit de 5 tentativas erradas / 15 min (por ator e por IP) com lockout, e rastro de toda tentativa em `pin_attempts` + `audit_logs`** (migração v9).

**Reverter o banimento da conta espelho `.br`** (se o dono um dia quiser): no Supabase Dashboard → Authentication → Users → `jrsistemasetecnologia.br@gmail.com` → *Unban*, ou via Admin API `auth.admin.updateUserById(id, { ban_duration: 'none' })`. O papel continua `admin` com `ativo=false` — reativar exige edição manual na tabela `users` (e a mudança fica registrada na trilha "Ações do admin").

No **Suporte**, o papel define o layout: **usuário** vê os tickets da própria empresa (e só quem abriu encerra); **dev** vê o dashboard global (badge de empresa, filtros, resumo por empresa) e gerencia assinatura com **prazo real** (30/90/180/365 dias ou data personalizada, somando dias restantes ao estender) via `DevPlanActivationModal` — planos pagos têm `plan_expires_at` e o acesso é suspenso ao vencer até a renovação (`Billing.planExpired`, banner de expiração na Assinatura e bloqueio do PDV). A migração de banco correspondente (coluna + `pg_cron` de suspensão automática) está pronta como recomendação em `supabase/recomendacao-v6-planos-com-prazo.sql`.

### O que já está conectado

- **Banco/Auth Supabase** (projeto `qmqllssextbxwwphawod`, região sa-east-1): schema completo com RLS por empresa, RPCs atômicas (venda/estoque), triggers de signup/convite, área de suporte, conta **dev ilimitada** + trial único com suspensão server-side (`migracao-v5-billing-dev.sql`) e **guarda anti-abuso do teste grátis com confirmação de e-mail** (`migracao-v5-anti-abuso.sql`) — tudo já espelhado em `supabase/schema.sql`.
- **Edge Function `api`** (`/functions/v1/api`): cadastro público com guarda por IP/dispositivo (`auth.signup` — limites ajustáveis via secrets), convites de equipe com e-mail nativo, ferramentas de billing/suporte (somente papel `dev`), cancelamento persistido e pedido LGPD de exclusão com sweeper cron (`supabase/functions/api/index.ts`).
- **E-mails**: confirmação de e-mail obrigatória (`mailer_autoconfirm=false`, código com validade de 10 min) + templates tematizados pt-BR prontos em `supabase/configurar-emails-templates.py`. Plano Free sem SMTP: template padrão do Supabase (link de confirmação; o app aceita link **ou** código) e ~2–4 e-mails/hora; com SMTP próprio, o template com código de 6 dígitos é aplicado e o limite sobe para 30/hora.
- **Cobrança**: arquitetura pronta; InfinitePay na próxima fase (a página Assinatura informa o cliente).

## Documentação por arquivo

- `supabase/README.md` — passo a passo do backend (schema, functions, secrets)
- `supabase/schema.sql` — setup completo idempotente (tabelas + RLS + triggers + suporte + billing-dev + anti-abuso/trial-na-confirmação)
- `supabase/migracao-v4-suporte.sql` — migração da área de suporte/convites/papel dev
- `supabase/migracao-v5-billing-dev.sql` — dev ilimitado, trial único não renovável (guard de cobrança) e suspensão server-side
- `supabase/migracao-v5-anti-abuso.sql` — anti-abuso do teste grátis (IP + dispositivo) e trial iniciando na confirmação do e-mail
- `supabase/migracao-v6-planos-com-prazo.sql` — `plan_expires_at` + `pg_cron` de suspensão automática (aplicada)
- `supabase/migracao-v7-fluxo-tickets.sql` — máquina de estados de tickets com guard por papel (aplicada)
- `supabase/migracao-v8-endurecimento.sql` — badge do Suporte (RPC), auditoria no banco p/ toda escrita sensível (triggers antes→depois), trilha global dev, limite de reabertura (3), allowlist dev única e PIN de cobrança (aplicada)
- `supabase/migracao-v9-pin-rate-limit.sql` — endurecimento do PIN de cobrança: tabela `pin_attempts` (RLS deny-all), rate limit 5×/15 min por ator e IP com lockout, política de comprimento ≥ 12 (aplicada)
- `supabase/migracao-v10…v13` — RLS em 100% das tabelas, idempotência da venda, e-mail (Resend), rascunhos de ticket (aplicadas)
- `supabase/migracao-v14-revoga-rpc-internas.sql` — funções internas fora da API pública (aplicada)
- `supabase/migracao-v15-asaas.sql` — faturas idempotentes para o webhook Asaas (aplicada)
- `supabase/migracao-v16-rls-papeis-e-cobranca.sql` — fecha escalada de papel (caixa→admin), escrita direta em vendas, suspensão de inadimplente (aplicada)
- `tests/mobile.test.js` — E2E mobile (Playwright) que bloqueia o deploy
- `SECURITY.md` — política de segurança: segredos, rotação de PIN, como reportar vulnerabilidades e checklist de pré-go-live
- `tests/smoke.test.js` + `tools/run-tests.sh` — suíte reproduzível contra o ambiente publicado
- `INTEGRATIONS.md` — pontos de integração (billing, analytics, fiscal)
- `CHANGELOG.md` — histórico de versões

## Modos de build

| Modo | Build | Para quê |
|---|---|---|
| **produção** (deploy automático) | push na `main` → Actions → **GitHub Pages** | Site oficial conectado ao Supabase (auth, dados, suporte e convites reais) |
| **final** | `npm run build` → `release/index.html` | Bundle single-file com motor local (apresentações offline) |
| **demo** | `npm run build:demo` → `release/demo/` | Homologação: seed populado, contas demo, chip e simuladores |

Para publicar fora do Pages: sirva `release/producao/` (após `npm run build:prod` com `.env`)
em qualquer host estático com HTTPS — o app é um único `index.html` autocontido.

## Estrutura

```
obracerta/
├── src/
│   ├── index.html            # shell: SEO completo (meta/OG/JSON-LD) + landing estática indexável
│   ├── css/
│   │   ├── design-system.css # tokens (cores/tipo/espaço/sombra/movimento), reset, componentes, a11y
│   │   ├── landing.css       # header, hero, seções, planos, FAQ, footer, drawer mobile
│   │   └── app.css           # shell (sidebar/topbar/drawer), páginas, PDV, impressão, responsivo
│   ├── js/
│   │   ├── core.js           # utils, template html`` com escape anti-XSS, Bus, Store persistente,
│   │   │                     # Router hash com guards, UI (toasts/modais/focus-trap), ícones SVG,
│   │   │                     # validação de formulários, RBAC
│   │   ├── services.js       # Config central + ApiClient→MockAdapter (seam de produção),
│   │   │                     # Auth/Billing/Catalog/Inventory/Sales/Reports/Audit/DataOps + Seed
│   │   ├── views-landing.js  # interações de marketing (menu, planos mensal/anual, FAQ, reveal)
│   │   ├── pages-sales.js    # Dashboard, PDV (autocomplete, atalhos, pagamento misto), Vendas
│   │   ├── pages-manage.js   # Produtos (+import CSV), Estoque, Relatórios, Assinatura,
│   │   │                     # Configurações (loja/regras/equipe/dados/integrações), Auth views
│   │   └── main.js           # shell do app, rotas+guards, dispatcher, atalhos globais, boot
│   └── img/                  # loja.jpg (IA→otimizada), og-cover.png, app-hero.jpg (captura real)
├── tools/
│   ├── build.js              # bundle single-file: CSS+JS inline, imagens data-URI, robots/sitemap
│   ├── optimize-images.js    # sharp: redimensiona/comprime (5,9 MB → 193 KB no hero de foto)
│   └── shoot.js              # Puppeteer: captura o dashboard real p/ hero da landing
├── tests/
│   ├── unit.test.js          # jsdom roda o BUNDLE de produção: utils→serviços→DOM/E2E
│   ├── visual.test.js        # Puppeteer: 10 viewports, overflow, E2E cliques reais, a11y, perf
│   └── shots/                # screenshots gerados (inspeção visual automatizada)
├── release/                  # ARTEFATO: index.html (100% autocontido), assets/, robots, sitemap
├── INTEGRATIONS.md           # como plugar Supabase/Stripe/Pix Automático/analytics sem refatorar
└── package.json              # scripts: build / test / test:visual / check / hero / optimize
```

## Decisões de arquitetura

- **Single-file bundle de produção** (`release/index.html`, ~660 KB): 0 requisições, abre offline,
  preview em qualquer sandbox. Fonte modular em `src/` mantém manutenção profissional.
- **Camada de serviços isolada**: toda leitura/escrita passa por `ApiClient → adapter`.
  O `MockAdapter` (localStorage) é trocável por `SupabaseAdapter`/`HttpAdapter` **sem tocar em nenhuma tela**
  (contrato e esqueletos prontos em `INTEGRATIONS.md`). Cada mutação persiste e notifica (`store:changed`).
- **Router hash com guards** de sessão e de papel (RBAC: admin/gerente/caixa — caixa não vê relatórios/config,
  desconto limitado, cancelamento de venda só admin — validado no cliente **e** no "servidor" mock).
- **Templates com escape automático** (`html\`\``): todo dado dinâmico é escapado por padrão;
  `raw()` é opt-in explícito. Teste de XSS dedicado no suite.
- **Máquina de estados de assinatura**: `trialing → active → past_due → read_only`,
  com PDV bloqueado em `read_only` (modo leitura + exportação LGPD) e reativação em 1 clique.
- **Design system por tokens** (cores AA WCAG, escala de tipo/espaço/sombra/movimento),
  componentes reutilizáveis (KPI, panel, badge, modal, toast, empty, skeleton) e ícones SVG inline.
- **Imagens**: foto da loja e capa OG geradas por IA e otimizadas (sharp); o "screenshot do produto"
  na landing é uma **captura real do app** (shoot.js) — sempre fiel ao produto.

## Qualidade verificada (última execução)

| Área | Resultado |
|---|---|
| Unitários + integração (jsdom sobre o bundle) | **50/50** ✔ |
| Responsividade: 10 viewports (360→3440 ultrawide) × 9 páginas | **0 overflow horizontal** ✔ |
| Console/pageerror em toda a matriz | **0 erros** ✔ |
| E2E cliques reais: RBAC caixa, venda PDV, logout, ciclo de assinatura, reload persistente | **6/6** ✔ |
| Acessibilidade: nomes acessíveis, alt, skip-link, foco visível, focus-trap em modais | **4/4** ✔ |
| Performance: DCL ~200 ms local, 431 nós DOM na landing, 1 documento/0 requisições, bundle 660 KB | ✔ |

Atalhos: `F2` foco no PDV · `Enter` adiciona · `F4` finaliza · `Alt+1..8` navega · `Esc` fecha.

## Segurança e privacidade (demo e produção)

- Demo: **nenhum dado sai do navegador** (localStorage com fallback em memória se bloqueado).
- `html``` escapa tudo por padrão; validação de formulários com mensagens e `aria-invalid`;
  exportação LGPD **remove senhas**; senhas demo nunca vão para exports.
- Produção (checklist em `INTEGRATIONS.md`): senhas fora do front (Supabase Auth), RLS por tenant,
  segredos só em variáveis de ambiente, webhooks assinados, CSP via `<meta>` (ver seção abaixo).

## Headers de segurança e cache — o que o GitHub Pages dá (e o que não dá)

O site é publicado no GitHub Pages, que **não permite configurar headers HTTP**
(nada de `_headers` — isso é Netlify/Cloudflare; nada de `X-Frame-Options`, CSP
por header ou HSTS customizado). O que a plataforma faz sozinha: **HSTS**
(`strict-transport-security: max-age=31556952`) e `cache-control: max-age=600`
no HTML (~10 min de retenção no edge).

**O que o app faz por conta própria (v1.7.3):**

- **CSP via `<meta>`** — `default-src 'self'`; `connect-src` só a própria origem
  e o Supabase do projeto (http+wss): mesmo que um XSS exista, os dados não
  saem para domínio arbitrário; `object-src 'none'`; `base-uri 'self'`;
  `form-action 'self'`; `img-src` permite `data:` (imagens inline do bundle).
  Limitações honestas: o bundle é single-file com JS/CSS inline →
  `'unsafe-inline'` é obrigatório em `script-src`/`style-src`; e `frame-ancestors`
  **não vale em `<meta>`** (spec) → o anti-clickjacking é feito em JS no `<head>`
  (se não conseguir sair do frame, não renderiza).
- **`referrer` strict-origin-when-cross-origin** — não vaza URL completa
  (incluindo fragmento de rota do app) para sites de terceiros.
- **`version.json` + aviso de atualização** — o HTML pode ficar retido até
  ~10 min no edge após um deploy; o app faz probe de `version.json` com
  cache-buster ao abrir e ao voltar para a aba e avisa o usuário quando há
  versão mais nova. Recarregar é **sempre ação do usuário** — nunca automático
  (um reload surpresa no meio de uma venda no PDV é pior do que minutos de
  versão antiga). A versão canônica também está em `<meta name="app-version">`.

**⚠️ Decisão pendente do dono (pré-go-live comercial):** para a proteção
completa — `frame-ancestors`/`X-Frame-Options`, CSP com nonce (sem
`unsafe-inline`), HSTS customizado, `X-Content-Type-Options` — é preciso um
proxy na frente. **Recomendação: Cloudflare free na frente do GH Pages**
(mantém a origem, adiciona WAF/CDN e headers via Transform Rules; ~1h de
esforço; free tier cobre folgadamente o volume atual). Alternativas: migrar
para Cloudflare Pages ou Vercel (build nativo + headers via config). Sem isso,
relatórios de auditoria de segurança devem registrar a limitação da plataforma.

Verificação rápida:

```bash
SITE="https://jrsistemasetecnologiabr-bit.github.io/Projeto-empresa"
curl -sI "$SITE/?cb=$(date +%s)" | grep -iE 'strict-transport|cache-control|age'   # HSTS + max-age=600
curl -s "$SITE/version.json?ts=$(date +%s)"                                      # versão publicada + commit
curl -s "$SITE/?cb=$(date +%s)" | grep -oE '<meta name="app-version" content="[^"]+"'  # versão no HTML
```

## Fallback do smoke no CI (deploy-pages.yml)

O deploy é bloqueado se o smoke falhar — mas nem toda falha é bug. O wrapper
`tools/smoke-gate.sh` classifica: **falha transiente** (HTTP 429/5xx, timeout,
erro de rede do Supabase/GH Pages) repete até 3× com backoff (20s, 40s);
**falha real de asserção** (RLS vazando, CORS quebrado, login 4xx…) reprova
na hora, sem retry — bug não se resolve com sorte. Na dúvida, reprova
(conservador). O job inteiro tem `timeout-minutes: 10` de teto.

## ⚠️ Antes de abrir para clientes: SMTP do Supabase Auth (2 min, urgente)

**Achado do go-live (10/11/2026):** o plano Free do Supabase limita o envio de
e-mails do Auth em **~2/hora**. Quando o limite é atingido, o GoTrue **recusa
novos cadastros** (o usuário vê "Não conseguimos enviar o e-mail agora…").
Cada troca de senha também consome 1 e-mail — um dia de operação com poucos
usuários pode travar cadastros de clientes novos por até 1h.

**Como resolver (dono, ~5 min):** Dashboard do Supabase → Project Settings →
Authentication → SMTP Settings → preencha com o SMTP do Resend (o mesmo da
seção abaixo): host `smtp.resend.com`, porta `465`, usuário `resend`,
senha = a API key do Resend, remetente `no-reply@seudominio.com.br`. Com SMTP
próprio, o limite sobe para dezenas/hora e o cadastro nunca trava.

## Notificação por e-mail (Resend) — como ligar (runbook do dono)

Desde a v1.8.0 a infraestrutura de e-mail está **100% no banco e ativa em
modo seguro**: toda resposta da equipe em ticket e o digest diário de planos
vencendo são registrados em `email_log`. Sem a chave da API, os envios ficam
como `skipped_no_key` (nada quebra; nada é enviado). Para LIGAR o envio real:

1. Crie uma conta no [Resend](https://resend.com) (free tier: 3.000 e-mails/mês
   — suficiente para as ~40 lojas) e **verifique um domínio** próprio
   (recomendado; sem domínio, o `onboarding@resend.dev` só envia para o
   e-mail da sua própria conta Resend).
2. Gere uma API key no painel do Resend.
3. No SQL Editor do Supabase, guarde a chave no Vault (nunca em texto no chat/repo):
   ```sql
   select vault.create_secret('<sua-api-key-do-resend>', 'resend_api_key');
   select vault.create_secret('LojaCerta <no-reply@seudominio.com.br>', 'email_from');
   ```
4. Pronto — o gatilho de resposta de ticket e o cron das 09:10 (BRT) passam a
   enviar. Acompanhe em `select * from email_log order by created_at desc limit 20;`
   (status `dispatched` = entregue ao Resend; entrega final no painel deles).

Sem domínio verificado ainda? Insira só a `resend_api_key` — o remetente cai
no padrão de testes do Resend até você configurar `email_from`.

## Cobrança Asaas — como ligar (runbook do dono, ~10 min)

Desde a v1.9.0 o fluxo completo está no ar: botão **Assinar** → Edge `api`
(`billing.checkout`) cria cliente + assinatura no Asaas com o preço do
**servidor** → cliente paga a fatura (Pix/cartão/boleto) → Asaas chama o
`billing-webhook` → plano liberado com prazo (30/365 dias, renovação soma os
dias restantes) + recibo por e-mail (Resend). Sem a chave, o botão mostra
"pagamento online ainda não habilitado" e a ativação manual pelo Suporte segue
funcionando.

1. **Sandbox primeiro**: crie conta em sandbox.asaas.com → Integrações → gere a
   API key. Em Supabase → Edge Functions → Secrets, defina:
   `ASAAS_API_KEY` = a chave · `ASAAS_ENV` = `sandbox` ·
   `ASAAS_WEBHOOK_TOKEN` = um texto aleatório longo (ex.: `openssl rand -hex 32`).
2. **Webhook no Asaas** (Integrações → Webhooks → Cobranças e Assinaturas):
   URL `https://qmqllssextbxwwphawod.supabase.co/functions/v1/billing-webhook`,
   token de autenticação = o mesmo `ASAAS_WEBHOOK_TOKEN`, fila ativa,
   eventos `PAYMENT_*` e `SUBSCRIPTION_*`.
3. Teste: loja de teste com **CNPJ/CPF preenchido** em Configurações → Loja →
   Assinatura → Assinar → pague a fatura no sandbox ("Confirmar pagamento").
   Confira em `select * from webhook_events where tipo like 'asaas:%' order by processed_at desc;`
4. **Produção**: troque `ASAAS_API_KEY` pela chave de produção e
   `ASAAS_ENV=production`; recadastre o webhook na conta de produção.

Mapeamento: `tenants.stripe_customer_id`/`stripe_subscription_id` guardam os ids
`cus_…`/`sub_…` do Asaas (colunas reaproveitadas). Faturas em `invoices`
(upsert por `provider_id`). O provider `infinitepay` continua aceito em modo stub.

## Roadmap do produto

1. **Fase 2**: NFC-e/NF-e via API parceira · modo offline do PDV (fila de sincronização) ·
   clientes/fiado/crediário · orçamentos que viram venda · WhatsApp.
2. **Fase 3**: multi-loja · app mobile do dono (notificações de venda) · API pública.
