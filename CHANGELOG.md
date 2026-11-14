# Changelog — LojaCerta

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1./) · versionamento semântico.

## [1.9.3] — 2026-11-10 — "JWT expired" ao voltar para uma aba antiga

### Corrigido
- Com a aba aberta há mais de 1h (ou notebook que dormiu), as telas mostravam **"Não foi possível carregar — JWT expired"**: a renovação do login rodava só em segundo plano e as consultas saíam com o token vencido. Agora toda operação espera a renovação quando o token está no fim, e repete sozinha uma vez se o servidor responder "expirado".
- Renovações simultâneas podiam invalidar a sessão (o refresh token é de uso único) — agora há uma única renovação em voo, compartilhada.
- Sessão realmente encerrada leva ao login com aviso em português, em vez de erro técnico.

### Adicionado
- `tests/session.test.js` (rede simulada, bundle de produção) no CI.

## [1.9.2] — 2026-11-10 — Revisão de lógica do banco (migração v16, aplicada)

### Segurança
- **Escalada de privilégio:** qualquer usuário da loja podia alterar qualquer linha de `users` pela API — um caixa se promovia a admin. Agora só admin altera usuários; id/empresa/e-mail não mudam pela API; a loja nunca fica sem admin ativo (`LAST_ADMIN`).
- Caixa podia alterar a config da loja (o próprio limite de desconto, estoque negativo). Agora só admin.
- Venda podia ser gravada/alterada direto na tabela (`sale_ins`/`sale_upd`), sem baixa de estoque nem auditoria. Removido — venda só via `commit_sale`/`cancel_sale`.
- Mensagem de ticket com remetente forjado: bloqueado.

### Corrigido
- `commit_sale`: produto repetido no payload baixava o estoque só uma vez. Recusado.
- Loja com fatura vencida (`past_due`) nunca era suspensa. Carência de 3 dias agora é respeitada (cron, RLS e refresh).
- Webhook Asaas: vencimento = vencimento da fatura + 1 mês de calendário + carência (antes 30 dias corridos: em mês de 31 dias o cliente em dia era suspenso por 1 dia).
- "Salvar" usuário sem permissão mostrava sucesso falso (RLS devolve lista vazia).
- Índice duplicado removido, índices em FKs, `auth.uid()` avaliado 1× por consulta nas políticas.

## [1.9.1] — 2026-11-10 — Menu mobile, dados completos, teste E2E no deploy

### Corrigido
- **Menu da landing no celular** (relato do cliente): o `backdrop-filter` do cabeçalho transformava o drawer `position:fixed` numa faixa de 36px presa ao header, e o véu escuro ficava POR CIMA do menu. Agora abre na altura toda, acima do véu, fecha com Esc/rotação/troca de rota e trava a rolagem do fundo.
- No celular não havia como **Entrar** pelo cabeçalho (botões escondidos e ausentes do menu) — "Entrar" e "Começar grátis" agora estão no menu.
- **Menu do app** em telas baixas (iPhone SE): Relatórios/Suporte/Assinatura/Configurações ficavam inalcançáveis atrás do cartão do plano (`padding:12` inválido + lista sem `min-height:0`).
- **Catálogo truncado**: o PostgREST corta em 1000 linhas — lojas com >1000 produtos perdiam itens no PDV. Carga agora paginada.
- **Dashboard/relatórios errados em loja movimentada**: só as últimas 300 vendas eram carregadas. Agora vêm todas as vendas e movimentações dos últimos 90 dias (paginado); "Todo o período" virou "Últimos 90 dias" (número verdadeiro).
- Datas em UTC (após 21h viravam "amanhã") no seletor de vencimento e no nome do backup.
- "Loja  Certa" com espaço duplo no menu do app.
- Domínio Vercel abandonado removido da lista de redirects de login (`configurar-emails-templates.py`).

### Adicionado
- `tests/mobile.test.js` (Playwright, 5 larguras): rolagem horizontal em todas as rotas, menus, modais e erros de JS — roda no CI e **bloqueia o deploy** se falhar. Reprova a v1.9.0 com os bugs acima.
- `npm test` agora existe de verdade (antes apontava para arquivos inexistentes).

## [1.9.0] — 2026-11-10 — Mobile de verdade, cobrança Asaas real, banco blindado

### Segurança (aplicado no Supabase — migração v14)
- **Crítico:** `send_email` era executável por qualquer anônimo via `/rest/v1/rpc` → relay aberto pela conta Resend. Revogado.
- `seed_categories`, `next_sale_numero`, `next_ticket_numero`, `sale_payload`, `cron_*`, `notify_*` e todas as funções de trigger saíram da API pública (anon/authenticated). Só `service_role` executa.
- `touch_updated_at` com `search_path` fixo (advisor 0011).
- Webhook Asaas antigo aceitava **qualquer requisição** quando `ASAAS_WEBHOOK_TOKEN` não estava configurado (`"" === ""`). Agora recusa (401) e compara em tempo constante.

### Cobrança Asaas (produção-ready)
- Edge `api` → `billing.checkout`: cria cliente + assinatura no Asaas (preço do servidor, nunca do navegador) e devolve a URL da fatura. Troca de plano encerra a assinatura anterior.
- `billing.cancel` encerra a recorrência no Asaas antes de bloquear a loja.
- `billing-webhook` reescrito para o payload real do Asaas (`asaas-access-token`, `event`, `payment`): PAYMENT_CONFIRMED/RECEIVED estende o prazo (sem dobrar quando chegam os dois), OVERDUE → carência, REFUNDED/CHARGEBACK → modo leitura; idempotente e com reprocessamento seguro em erro; recibo por e-mail (Resend).
- Migração v15: `invoices.provider_id` único (upsert idempotente) e status `cancelado`.

### Mobile / front
- **Causa-raiz:** regras base de `.kpi*` estavam declaradas depois dos `@media` e anulavam o responsivo (valores cortados em 320px).
- Tabelas viram **cartões** no celular (rótulos automáticos a partir do `<thead>`, sem mexer nas telas).
- Modal não sobrevive mais à troca de rota (antes "Confirmar venda" ficava por cima da página seguinte bloqueando toques).
- Toasts em largura total e acima da barra fixa do PDV; abas roláveis; select de desconto do PDV sem o ícone repetido em "xadrez".
- Rodapé de produção dizia "Entrar na demo"; alvos de toque do rodapé ≥ 36px.

## [1.8.1] — 2026-11-10 — Correções de layout mobile (relato do cliente: "layout todo bugado em celulares")

> Diagnóstico por auditoria automatizada (overflow/alvo-de-toque/zoom-iOS em
> 390px) + revisão visual por VLM em 9 rotas do app. Nada de nova funcionalidade:
> só ergonomia e leitura em telas estreitas.

### 📱 Toque e zoom (iOS)
- Inputs/selects com fonte ≥16px e altura ≥44px no celular (mata o auto-zoom do
  iOS ao focar); `.btn` ≥44px, `.btn-sm`/`.btn-icon.sm` ≥38px; checkboxes 19px.
- PDV: botões de quantidade 36×44, input de qtd 16px; "Finalizar" ganha
  `env(safe-area-inset-bottom)` (barra e padding do conteúdo) — antes o botão
  encostava na borda inferior da tela.

### 📊 Tabelas largas em 390px
- **Primeira coluna sticky** (identificador sempre visível durante o arraste
  horizontal), números sem quebra, `VENDA-000004` não dobra mais em 2 linhas.
- **Sombra na borda direita** dos `.table-wrap`/`.cart-wrap` + sentinela sticky
  `.scroll-cue` (badge "›" que some ao chegar ao fim) — antes a tabela parecia
  *cortada*, sem indicação de rolagem.
- Carrinho do PDV: `overflow:hidden` inline removido (truncava "SUBTOTAL");
  placeholder do leitor encurtado ("Bipe ou digite o produto…").

### 🧩 Composições quebradas
- Banner "aguardando sua resposta": ícone entra no bloco de texto; no celular
  texto em linha própria e [Responder agora]+[×] lado a lado (antes: vão vazio).
- KPIs 2×2 no celular (antes: coluna única com cartão cortado no meio).
- `.page-actions` ocupa a linha inteira com botões de largura igual (antes:
  "Importar CSV"/"Novo produto" com larguras díspares e espaço morto).
- Dicas de teclado (Alt+N, F2/F4/Enter/↑↓) escondidas em tela de toque.
- Modais com padding compacto e botões do rodapé iguais; thread do Suporte usa
  56dvh em vez de caixa fixa de 440px.

## [1.8.0] — 2026-11-10 — GO-LIVE: ondas 3–6 do fechamento (idempotência, audit com IP, e-mail, rascunhos no banco, webhook InfinitePay, cleanup)

> Origem: auditoria externa (58 itens) — ondas 3 a 6 + release para produção.
> Tudo aplicado no banco de produção, testado com evidência e publicado.

### 🔁 Onda 4a · Idempotência da venda (fim da venda dupla)
- `commit_sale` aceita `p.idempotencyId` (uuid gerado pelo front no início da
  finalização e reenviado em toda retry da mesma tentativa). Mesmo id →
  devolve a MESMA venda; id novo → venda nova. Implementação à prova de
  corrida: pré-checagem + `ON CONFLICT (id) DO NOTHING` + retorno da venda
  existente. Retrocompatível (sem o campo = comportamento anterior).
- Front: PDV gera o id uma vez por ciclo do carrinho (novo carrinho = novo id).
- **Testado em produção**: 2× mesmo id → mesma VENDA-000002; id novo →
  VENDA-000003; estoque 60→58 (2×1 un, não 3); auditoria 2 linhas (não 3).

### 🧾 Onda 3b · Auditoria com IP (P1-19)
- `audit_logs` ganha `ip` e `origem` (`edge` | `db`). Toda escrita sensível
  que passa pela Edge Function (api) registra o IP real do cliente
  (x-forwarded-for). Triggers de banco continuam `origem='db'` — o banco não
  conhece o IP real (limitação de plataforma, documentada).
- **Prova em produção**: mesma ação antes (`ip=null, origem=db`) e depois
  (`ip=47.57.242.119, origem=edge`).

### 📧 Onda 5 · Notificação por e-mail (P1: badge não alcança cliente inativo)
- Infra 100% no banco: `email_log` (trilha completa) + `send_email()` via
  **pg_net + Resend**, com a chave da API no **Supabase Vault** (segredo
  `resend_api_key`). SEM a chave: registra `skipped_no_key` e nada quebra —
  o dono ativa o envio inserindo a chave (runbook no README).
- **Resposta da equipe no ticket → e-mail ao cliente** (trigger em
  `ticket_messages`, só mensagens reais de admin/gerente/dev; sem auto-e-mail).
- **Digest diário de planos vencendo** (cron 12:10 UTC = 09:10 BRT): e-mail
  para tenants ativos com plano vencendo em ≤7 dias; idempotente por dia.
- Testado: trigger gravou trilha com destinatário/template corretos;
  seleção do digest provada (janela relaxada); função roda limpa na janela real.

### 🗒️ Onda 6a · Rascunhos de ticket no banco (P3)
- Tabela `ticket_drafts` (por usuário + ticket) com RLS (cada um só vê os
  próprios) + RPCs `ticket_draft_get/save/del`. Front usa o banco como fonte
  primária e mantém localStorage como cópia offline (em demo continua local).
  Rascunho antigo só-local é migrado para o banco no primeiro acesso.
- Novo ticket também (chave 'novo'); rascunho é apagado ao enviar.

### 🔌 Onda 6b · Webhook InfinitePay em modo STUB
- `billing-webhook` reescrita **sem imports externos** (deno.land derrubava o
  boot — a função nunca tinha sido deployada; agora sobe instantâneo).
- Provider `infinitepay`: valida **HMAC-SHA256** (header `x-signature`, hex,
  comparação em tempo constante) quando `INFINITEPAY_WEBHOOK_SECRET` existe;
  registra tudo em `webhook_events` (idempotente); responde 200 sem processar.
  Esquema exato de assinatura a confirmar com a InfinitePay na integração
  real (doc pública não especifica) — sem a secret, eventos são aceitos e
  marcados `sem_secret` para auditoria.
- **Testado**: HMAC válida→200 registrada (`hmac_ok`), inválida→400,
  duplicada→200 ignorada, sem secret→200 (`sem_secret`).

### 🧹 Onda 6-final · Cleanup de go-live
- Histórico de auditoria dos tenants de teste **exportado** antes da remoção
  (`download/evidencias/`); contas/tenants de teste removidos do Auth e do
  banco, mantida 1 conta oficial de CI/monitoramento (documentada).
- Documentação atualizada: runbook Resend (Vault), política de conta de teste,
  decisão Realtime-vs-polling (polling mantido — documentado), stub InfinitePay.

### Verificações das ondas 3–6 (resumo executivo)
- P1-16 timezone: trial/plano são instantes absolutos (`now()+14d` na
  confirmação); exibição em horário local do usuário (`toLocaleDateString
  pt-BR`); cron de aviso às 12:00 UTC = 09:10 BRT. Sem bug — validado no E2E.
- RBAC no banco auditado e provado: INSERT/UPDATE de produtos exige
  `is_staff()`+billing; cancelar venda/editar usuários/tenant exige
  `is_admin()`; caixa não escreve produtos; DELETE de produtos/usuários/vendas
  é negado a todos (soft-delete por design).

## [1.7.3] — 2026-11-10 — Onda 2 do fechamento: CSP/anti-clickjacking/referrer no front, version.json + aviso de versão nova, retry honesto do smoke no CI

> Origem: auditoria externa, verificação 3.3/3.6 e decisão da seção 4 (headers no
> GitHub Pages). O "v1.7.1" visto no site publicado era um **comentário histórico**
> no bundle ("feedback externo v1.7.1") — o app publicado era v1.7.2. Esta versão
> elimina a ambiguidade: a versão canônica passa a ter um ponto único e verificável.

### 🔒 Segurança de front (o que dá para fazer no GitHub Pages)
- **CSP via `<meta>`** — `default-src 'self'`; `connect-src` restrito à própria
  origem + Supabase do projeto (http/wss, derivado do `API_BASE` no build);
  `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`. O efeito prático
  principal é **anti-exfiltração**: mesmo com um XSS, dados não saem para domínio
  arbitrário. Limitações documentadas (README): `unsafe-inline` é inerente ao
  bundle single-file; `frame-ancestors` não vale em `<meta>`.
- **Anti-clickjacking em JS** no `<head>` (GH Pages não envia `X-Frame-Options`):
  tenta sair do frame; se não conseguir, não renderiza.
- **`referrer: strict-origin-when-cross-origin`** — não vaza URL/rota para terceiros.
- **Decisão pendente documentada** (README → "Headers de segurança e cache"):
  headers completos exigem Cloudflare na frente ou migração (CF Pages/Vercel).
  Recomendação registrada: Cloudflare free. Decisão do dono, não bloqueia go-live.

### 🚦 Cache do GH Pages (P1-13 → P0 da onda)
- **`version.json`** gerado pelo build (`version`, `mode`, `built`, `commit` do CI)
  e publicado na raiz do site.
- **Aviso de versão nova no app**: probe de `version.json` com cache-buster ao
  abrir (+4 s) e ao voltar para a aba (máx. 1 probe/5 min, 1 aviso/sessão).
  Toast persistente ("Recarregue a página (F5)…") — **recarregar é sempre ação do
  usuário**: reload automático no meio de uma venda no PDV é pior do que alguns
  minutos de versão antiga.
- **Versão canônica em `<meta name="app-version">`** — fim da ambiguidade de grep
  (o incidente 3.3: comentário histórico "v1.7.1" confundido com a versão real).
- Build ganhou **sanidade de tokens**: `{{...}}` não resolvido reprova o build.

### 🔁 Smoke gate no CI (verificação 3.6 do auditor)
- **`tools/smoke-gate.sh`**: falha **transiente** (HTTP 429/5xx, timeout, rede)
  → até 3 tentativas com backoff (20 s, 40 s); falha **real de asserção** →
  reprova na hora, sem retry. Deploy nunca é travado por rate limit momentâneo
  do Supabase, e bug real nunca é mascarado por retry. Testado em 4 cenários
  (passa, transiente-recupera, real-falha-rápido, transiente-persistente-bloqueia).
- Workflow: `timeout-minutes: 10` no job; `version.json` entra no artefato do Pages.

### 🧹 Endurecimento de higiene
- `.gitignore` cobre `.devpw` (senha dev fora do repo MESMO se copiado para dentro).
- `SECURITY.md`: tabela de segredos agora inclui `.devpw` e `.e2e_creds.json`;
  checklists de pré-deploy atualizados (v4→v10, smoke 15/15, `git ls-files`).
- **Senhas das contas de teste E2E rotacionadas** (exposição acidental em
  relatório de trabalho — sem impacto de dados, contas de QA/RLS; CI secrets
  atualizados; auditoria notificada).

## [1.8.0-rc1] — 2026-11-10 — Fechamento técnico completo (onda 1/6): RLS total, senha dev oficial, guard de automação, smoke CORS no CI

> Origem: prompt final v5 do auditor externo (58 itens + limpeza de cota). Esta é a
> **onda 1** (P0-1, P0-2D, P0-3, P0-4, P0-5, P0-6, P0-21, requisito da senha dev e
> gate de smoke no CI). Ondas seguintes: re-auditoria browser das evidências,
> trial/billing/painel dev, RPCs/sub-roles/idempotência, P1s, P2s/P3s, cleanup.

### 🔴 P0 · RLS de TODAS as tabelas (P0-2D) — buraco real encontrado e fechado
- **`support_ticket_counters` estava SEM RLS** — a varredura tabela a tabela (20
  tabelas) + teste anônimo ao vivo pegou leitura pública dos contadores de ticket
  por tenant. Corrigido com **migração v10** (`enable row level security`, deny-all
  sem policies — só `next_ticket_numero()` SECURITY DEFINER e service_role tocam
  a tabela; `postgres`/`service_role` têm `bypassrls`). **Validado com transação
  de teste + rollback antes de aplicar**: a numeração de tickets NÃO quebra.
- As demais 19 tabelas: RLS ativo ✔ (as sem policies — `pin_attempts`,
  `signup_audit`, `tenant_counters`, `webhook_events` — são deny-all POR DESIGN,
  acesso exclusivo do service role). Teste anônimo ao vivo: **nenhuma tabela
  devolve dados sem login**. Evidência: `p0e-rls-all-tables.txt`.

### 🔴 P0 · Conta dev oficial validada + senha definida pelo dono (P0-6)
- SQLs de validação: `email_confirmed_at` ✔, `banned_until` null ✔, allowlist
  `dev_emails()` = só a conta oficial ✔, `papel='dev'`/`ativo` ✔, conta espelho
  `.br` banida ✔ (tenant preservado com rastro), cron real
  `cron_suspend_expired_plans()` → 0 suspensões e dev intocado ✔.
- **`trial_ends_at` dos tenants dev: NULL** (era um placeholder "ano 2226" da
  constraint NOT NULL — migração v10 torna a coluna nullable; todos os usos SQL
  e front testam `status='trialing'` antes de ler, adapter já tratava NULL).
- `billing_refresh_status()` via SQL direto recusa com UNAUTHORIZED — **guard
  correto** (exige JWT de tenant; o front chama via RPC logado). Evidência: `p0i-conta-dev.txt`.
- **Senha da conta dev definida pelo dono** via `auth.admin.updateUserById`
  (`email_confirm: true`): PUT 200 → **login 200 no endpoint real do site** →
  sessão enxerga `papel=dev`. Senha com 9 chars (minúscula+maiúscula+número+
  símbolo; política do projeto = 8) — **nunca versionada nem impressa** (vive em
  `scripts/.devpw` fora do repo; `git grep` do literal → vazio). Seção 3.1 do
  `SECURITY.md` documenta a regra: scripts não alteram; dev troca via app.

### 🔴 P0 · Guard anti-rotação da conta dev em scripts (P0-5)
- `scripts/guard_dev_account.py` (fora do repo): `assert_not_dev_account(email, id)`
  levanta exceção para a conta oficial. Aplicado em `prep_e2e.py` (antes do PUT de
  cada conta de teste) e `p0c_pin_ops.py` (guard duplo no fluxo tempdev). O setter
  da senha oficial (`p0_senha_dev.py`) exige `--autorizado-pelo-dono` — sem o flag
  recusa (testado: exit 2). Evidência: `p0h-dev-account-guard.txt`.

### 🔴 P0 · Preflight CORS re-validado (P0-3 + P0-21)
- `OPTIONS` com `Access-Control-Request-Headers: x-cron-secret` e `x-dev-pin`
  → 200 com ambos na allowlist. Sweeper com secret errado → **403 FORBIDDEN**
  da função (com secret certo: workflow keep-alive `success` a cada 6h é a prova
  contínua). Evidências: `p0f-cron-secret-preflight.txt`, `p0w-dev-pin-cors.txt`.

### 🔴 P0 · Smoke que previne a classe de bug do CORS (P0-4)
- **2 checks novos no `tests/smoke.test.js` (15/15)**: (0) CORS **estático** —
  todo header `x-*` do front (hoje: `x-dev-pin`) tem que estar na allowlist da
  Edge (lê `src/js` + `index.ts`; ícones SVG como `'x-circle'` são filtrados);
  (2b) CORS **ao vivo** — preflight no DEPLOY com todos os headers do front.
  Se alguém adicionar um header novo sem atualizar a Edge, o CI falha ANTES do
  deploy. Evidência: `p0g-smoke-cors.txt`.

### 🟠 CI · Gate de smoke antes do deploy (P2-1 antecipado)
- `deploy-pages.yml` agora roda `node tests/smoke.test.js` entre o build e o
  upload do Pages — **deploy falha se o smoke falhar**. Credenciais de teste via
  **GitHub Secrets** (`SMOKE_TEST_EMAIL`/`SMOKE_TEST_PASSWORD`, criados via API,
  nunca em claro no workflow). Pós-cleanup (fase 13): sem a conta QA, o smoke
  degrada para os checks anônimos (comportamento documentado).

### Higiene de segredos (P0-1)
- `JRHROERI` (PIN morto) removido até do CHANGELOG — o registro histórico agora
  descreve o segredo sem o literal. Documentação reformulada para não usar
  `DEV_PIN=<valor>` (greps `JRHROERI|131723Ma|DEV_PIN\s*=` → todos vazios).
- `.gitignore` endurecido com os padrões dos arquivos de trabalho local
  (`.dev_pin`, `.e2e_creds.json`, `.sbtoken`, `.srservice`, `.sranon`, `.qauser`,
  `*.pem`, `*.key`). Histórico do git verificado: **vazio para todos** —
  filter-repo/BFG desnecessário. Evidência: `p0d-gitignore-download.txt`.

## [1.7.2] — 2026-11-10 — P0 de segurança: rotação do PIN exposto + rate limit/lockout/auditoria no 2º fator; vencimento com hora; SECURITY.md

> Origem: revisão externa da v1.7.1 — o PIN de cobrança foi exposto numa conversa de trabalho (perde a função de 2º fator). Executado no mesmo dia: rotação do secret (24 chars, valor entregue ao dono fora do chat), verificação do histórico do Git (repo limpo — `git log --all --full-history` vazio para `.env`/`.dev_pin`/`.e2e_creds.json`), endurecimento do mecanismo (migração **v9** + Edge v20) e senhas de QA rotacionadas. Evidências em `download/evidencias/p0c-pin-ratelimit.txt`.

### P0 · PIN de cobrança (2º fator) endurecido
- **Rotação imediata do `DEV_PIN`** (8 → 24 caracteres aleatórios) via Management API — o valor antigo (segredo de 8 chars exposto em conversa; literal removido deste registro em 10/11/2026 por higiene de grep) morre; o novo é entregue ao dono por arquivo privado/gerenciador de senhas, **nunca mais em conversa**. Evidência: chamada com o PIN antigo recusada.
- **Política de comprimento**: PIN configurado com menos de 12 caracteres é **recusado** pela Edge (`DEV_PIN_INSECURE`, HTTP 500) — a configuração fraca não opera.
- **Rate limit + lockout (tabela `pin_attempts`, migração v9)**: 5 tentativas erradas em 15 min, contadas **por ator e por IP** (janela deslizante), travam a operação de cobrança por 15 min (`PIN_LOCKED`, HTTP 429). Acertar o PIN zera o contador do ator. Testado ao vivo: 5×403 com contador visível → 429 no lockout → desbloqueio → 200 com o PIN novo.
- **Auditoria de tentativas**: toda tentativa vira linha em `pin_attempts` (ator, IP, horário, resultado — RLS deny-all, só service role lê/escreve); tentativa errada e bloqueio geram `audit_logs` (`pin.tentativa_falha` / `pin.bloqueado`) visíveis na tela "Ações do admin". `pg_cron` diário mantém 24 h de histórico.
- **Higiene de segredos**: verificado que `scripts/.dev_pin`, `scripts/.e2e_creds.json` e `.env` **nunca entraram no histórico do repo** (`.gitignore` efetivo); senhas das contas de QA rotacionadas (valores antigos mortos); arquivo `SECURITY.md` criado (política de segredos, rotação de PIN, reporte de vulnerabilidades e checklists de pré-deploy/go-live).

### P2 · Vencimento com hora (UX de timezone)
- Banner da Assinatura, painel do dev e modal de ativação agora mostram **data E hora** do vencimento (`U.datetime` — "10/12/2026 às 14:05"): o prazo cai no aniversário da ativação (instante absoluto), e mostrar só a data induzia o cliente a achar que valia até 23:59 — exatamente a reclamação "paguei até o fim do dia e caiu de manhã" antecipada na revisão.

## [1.7.1] — 2026-11-10 — Endurecimento de produção (revisão externa): notificações, auditoria no banco, conta dev única, PIN de cobrança e testes reproduzíveis

> Origem: revisão de riscos da v1.7.0 (backfill v6, ciclo do cron, notificações, conta dev duplicada, audit trail, timezone, stale state, enumeração, reabertura, filtros do dev). Cada risco virou teste com evidência ou correção — migração **v8** aplicada em produção + Edge Function v19 + bundle rebuild.

### P0 · Evidências (testes no banco de produção)
- **Ciclo do cron "suspende → dev ativa → NÃO re-suspende"**: executado `cron_suspend_expired_plans()` sobre o tenant de teste alternando o prazo — plano vencido há 1h → suspende (+ linha `assinatura.suspensa` pelo `cron`); dev ativa +30 dias (mesmo PATCH da Edge) → **cron roda de novo e NÃO re-suspende** (0 suspensões, status permanece `active`); fronteira +30 min → não suspende; vencido há 30 s → suspende. `billing_refresh_status()` idempotente: cliente suspenso permanece `read_only` (não libera sozinho), após ativação devolve `active` com prazo, e `past_due` com prazo futuro **não é sobrescrito** (evidência: `p0b-ciclo-cron.txt`).
- **Auditoria do backfill v6**: critério era `now()+30d` APENAS para tenants `active`, não-dev, com `plan_expires_at IS NULL` (v5 ativava sem prazo; sem histórico de cobrança para derivar — InfinitePay ainda não integrada). Único tenant tocado: "Loja do Carlos" (conta de teste criada no mesmo dia; prazo = migração + 30 dias exatos). **Nenhuma conta inadimplente foi reativada** — o tenant read_only de QA não recebeu prazo e continua read_only (evidência: `p0a-backfill-auditoria.txt`).
- **Timezone (2.7)**: sem grace period e sem risco de suspensão antecipada — `plan_expires_at` é um instante absoluto (`timestamptz`) contado do **aniversário da ativação** (cliente que ativa às 14h BRT vence às 14h BRT do ciclo seguinte); o cron compara `pe < now()` e portanto só suspende **depois** do instante (pior caso ~1h, granularidade horária às :05). Fronteiras ±30 min/±30 s testadas.
- **Enumeração (Q6)**: URL do ticket usa **UUID** (`#/app/suporte/<uuid>`); o `#N` exibido é contador **por empresa** (`next_ticket_numero(tenant)`) — não existe sequência global enumerável entre tenants.

### P1 · Notificações in-app (o cliente não fica mais no escuro)
- **Badge no menu**: item "Suporte" da sidebar mostra contador em qualquer tela — para o **cliente**, quantos chamados estão `aguardando_cliente` ("Aguardando você"); para o **dev**, o tamanho da fila da equipe (`aberto` + `aguardando_equipe`). RPC nova `support_badge_counts()` (v8), polling leve de **60 s** e refresh imediato ao **voltar para a aba** (`visibilitychange`).
- **Banner persistente** no topo do app: "Você tem N chamado(s) aguardando sua resposta" com botão **Responder agora** — entra/sai do DOM sem re-renderizar a página (não interrompe o PDV); dispensável por 4 h.
- **Copy honesta** na abertura do ticket: "Você será notificado AQUI no app: um aviso aparece no menu Suporte e um banner no topo quando a equipe responder." (sem promessa de e-mail — o plano Free limita envios; quando o SMTP próprio entrar, a notificação por e-mail entra por cima).

### P1 · Audit trail no BANCO (nenhuma escrita sensível escapa)
- **Trigger `audit_tenants_billing`** (AFTER UPDATE em `tenants`): toda mudança de coluna de cobrança (status/plano/prazo/próxima cobrança/cancelamento/motivo) gera linha em `audit_logs` com **antes→depois** e origem (`aplicação` vs `servidor (Edge/cron/SQL)`) — fecha o furo de mudanças via SQL Editor/service role que não passavam pela Edge.
- **Trigger `audit_users_changes`** (AFTER UPDATE em `users`): mudança de **papel/ativo/nome** gera trilha com antes→depois (a rebaixada admin→caixa agora tem rastro, venha da UI, da Edge ou do SQL).
- **Tela "Ações do admin"** (Configurações, aba exclusiva do dev): trilha **global** de todas as empresas via RPC `admin_audit_list` (valida papel dev no banco; usuário comum recebe `FORBIDDEN` e nem vê a aba). A aba "Dados & auditoria" do usuário comum agora mostra a **trilha real** do próprio tenant (antes ficava vazia em produção).
- RLS: política `aud_sel_dev` dá ao dev leitura global de `audit_logs`; índice `ix_audit_recent` para a tela.

### P0 · Conta dev única (fim do super-admin duplicado)
- **Allowlist `dev_emails()` reduzida a UM e-mail** — a conta oficial criada pelo dono (`jrsistemasetecnologiabr@gmail.com`). A conta espelho `jrsistemasetecnologia.br@gmail.com` (pré-configurada em validações anteriores) foi **rebaixada** para `admin` com `ativo=false` + banida no GoTrue + linha de auditoria `conta.dev_consolidada` documentando a ação. Login de conta desativada é barrado na hidratação do perfil (`ACCOUNT_DISABLED`) e a sessão local é limpa.
- **PIN de cobrança (2º fator leve)**: com o secret `DEV_PIN` definido no Supabase, `billing.activate_plan` e `billing.suspend_tenant` exigem o header `x-dev-pin` (403 `DEV_PIN_REQUIRED` sem ele). O PIN fica em `sessionStorage` (some ao fechar/encerrar sessão), o modal de ativação revela o campo PIN quando o servidor pede e a suspensão pede o PIN em modal próprio. Sem o secret configurado, opera como antes (retrocompatível).

### P2 · UX de sessão e estado
- **Rascunhos à prova de sessão expirada**: resposta de ticket e novo ticket salvam o texto a cada tecla (`localStorage`, por ticket+usuário) e restauram ao reabrir — se a sessão cair no meio da escrita, nada se perde; o rascunho sai ao enviar com sucesso.
- **PDV destrava sozinho (2 caminhos)**: `visibilitychange` zera o throttle do `syncRemote` ao voltar para a aba; e o tick de 60 s também reconcilia o billing — cobre o caixa que deixa a aba **aberta e visível o dia todo** (visibilitychange nunca dispara). Cliente pega a ativação feita pela equipe JR sem reload. Polling de badge idem.
- **Logout** limpa badge, PIN e estado do suporte.

### P3 · Escala do painel dev + política de reabertura
- **Busca server-side**: no painel dev a busca filtra no BANCO (assunto, descrição, solicitante, e-mail, empresa — `ilike`) via PostgREST, com **paginação "Carregar mais"** (100 por página) — a fila continua usável com centenas de chamados. Para o usuário comum a busca segue client-side (lista pequena).
- **Política de reabertura**: máximo **3 reaberturas** por chamado para o cliente (contador `reopen_count` incrementado por trigger; na 4ª tentativa o banco recusa com `REOPEN_LIMIT` e a UI orienta abrir um novo chamado). **Dev é isento** e pode sempre reabrir. Vale para os dois caminhos: PATCH direto (guard v7) e reabertura por mensagem (trigger da resposta).

### P2 · Testes reproduzíveis (fim da suíte "manual")
- **`tools/run-tests.sh`**: sintaxe de todos os módulos (`node --check`) + build de produção + smoke test, em um comando (`npm run run-tests`).
- **`tests/smoke.test.js`** (Node 20+, zero dependências): **13/13 ✔** contra o ambiente publicado — site no ar, Edge ping, RLS anônima, RPC do badge exige sessão, `admin_audit_list` dev-only, login de teste, badge com contadores, `billing_refresh_status`, isolamento de tenant na listagem, forja de `tenant_id` barrada, guard de cobrança, ops dev-only na Edge e RPC de venda validando entrada. Credenciais vêm do `.env` (`TEST_EMAIL`/`TEST_PASSWORD`).

## [1.7.0] — 2026-11-10 — Fluxo de atendimento (máquina de estados) + backend de planos com prazo aplicado

### Backend APLICADO EM PRODUÇÃO (migrações v6 + v7 + Edge Function v16+)
- **`migracao-v6-planos-com-prazo.sql` (aplicada)**: colunas `plan_expires_at` / `plan_activated_by` / `plan_activated_at` / `plan_activation_reason` em `tenants`; `billing_refresh_status()` também suspende **plano pago vencido** (e devolve `planExpiresAt`); `tenant_billing_ok()` bloqueia venda com prazo vencido; guard de cobrança cobre as novas colunas; **`pg_cron` horário** `suspend-expired-plans` (suspende lojas vencidas + auditoria, funciona mesmo com o cliente offline) e diário `warn-expiring-plans`; backfill: lojas ativas sem prazo entraram no regime com 30 dias (contas dev ficam sem prazo).
- **`migracao-v7-fluxo-tickets.sql` (aplicada)**: máquina de estados de tickets — novos status `aguardando_cliente` / `aguardando_equipe` (o status diz **de quem é a bola**), `assignee_id`/`assignee_name` (responsável pelo atendimento, com snapshot via trigger), `ticket_messages.tipo` (`mensagem` | `evento`), trigger `bump_ticket_on_msg` reescrito (**a resposta move a bola conforme o papel de quem respondeu**: dev responde → aguardando_cliente e assume o ticket se ninguém assumiu; cliente responde → aguardando_equipe; ticket aberto respondido pelo cliente segue na fila; conversas encerradas reabrem com mensagem), **guard `guard_ticket_flow`** (status: dev sempre, dono nos próprios tickets; prioridade/categoria/assignee: somente dev — transições automáticas passam por flag de bypass), **trigger `ticket_status_event`** (toda transição vira linha `tipo='evento'` com quem fez — "Fulano alterou o status: X → Y" na própria conversa), `closed_at` limpo ao reabrir, RPC `support_take_ticket` e índices de fila.
- **Edge Function `api` (implantada)**: `billing.activate_plan` agora aceita `{days, expiresAt, reason, extend}` — **recalcula e valida o prazo no servidor** (estender soma os dias restantes ao vencimento atual; data custom revalidada; máximo 3650 dias; conta dev não recebe prazo), persiste `plan_expires_at`/quem ativou/motivo e devolve o vencimento real; `billing.tenant_info` inclui prazo e motivo. **Fix crítico**: o join embutido `tenant:tenants(...)` do `caller()` ficou **ambíguo** após a v6 criar `tenants.plan_activated_by → users(id)` (PostgREST PGRST201) — desambiguado com `tenant:tenants!users_tenant_id_fkey(id,nome)`. Sem esse fix, TODAS as ops autenticadas da Edge (convites, billing, LGPD) falhavam com "Sessão inválida".

### Suporte: fluxo com botões contextuais (a resposta do Rafael)
- **Dropdown livre de status dá lugar a ações com significado**: DEV vê **Atender** (assume + em_andamento), **Voltar à fila** (aberto, sem responsável), **Resolver**, **Fechar** (após resolvido), **Reabrir** — cada botão só aparece quando faz sentido para o estado; prioridade/categoria continuam livres e o "Status avançado" fica recolhido em `<details>`. USUÁRIO dono vê apenas **Encerrar chamado** e **Confirmar resolução** (resolvido → fechado) — sem seletor de status.
- **Faixa "de quem é a bola"** no detalhe: cliente vê "⏳ A equipe respondeu — aguardando VOCÊ" (e o badge **"Aguardando você"** na lista, com destaque âmbar na linha); dev vê quem é o responsável e o estado da fila.
- **Eventos de status na conversa**: linha centralizada "— Fulano alterou o status: Aberto → Em atendimento · data —" para toda transição (produção grava via trigger; demo espelha no mock). Contador de mensagens separa mensagens de eventos.
- **Painel dev**: 6 KPIs (Na fila, Em atendimento, Aguardando cliente, Aguardando equipe, **Minha fila**, Resolvidos), filtro **"Minha fila"** (tickets atribuídos a você), badge de responsável na linha do ticket, resumo por empresa com as novas colunas.

### Correções de UX/segurança encontradas na auditoria E2E real
- **Logout zera o "ticket aberto"** (`Pages.suporte.sel`) e os filtros — antes, o próximo login na MESMA aba caía no detalhe do ticket do usuário anterior (navegação hash não recarrega o bundle).
- **Sidebar repinta quando o papel muda no servidor** (promoção/demissão puxada pelo `sync.pull`) — antes continuava com o papel antigo até a próxima navegação.
- `Support.openCount()` passa a contar todos os status ativos (incluindo aguardando_*).

### Auditoria de segurança multi-tenant executada contra o banco REAL (16/16 ✔)
Query cruzada entre tenants (tickets/mensagens/tenants/users) vazando zero linhas; insert com `tenant_id`/`user_id` forjados barrado pela RLS; PATCH em colunas de cobrança barrado pelo guard; ops de dev na Edge recusadas para usuário comum e para papel caixa (403 com mensagem correta); guard v7 impede não-dono de mudar prioridade/assignee e confirma dono resolvendo o próprio ticket; PATCH em ticket alheio não afeta nenhuma linha (204 com 0 rows, status inalterado no banco).

## [1.6.0] — 2026-11-10 — Suporte por papel (dev × usuário) e planos com prazo real

### Suporte: dois layouts decididos pelo papel (`Auth.me().papel`)
- **Layout USUÁRIO**: lista apenas os tickets da própria empresa (`tenantId` do tenant logado), KPIs da loja, filtro por status + busca, e o botão **"Marcar como resolvido" aparece SOMENTE para quem abriu o ticket** (o dono) — outro membro da equipe (ex.: um gerente) vê a conversa e responde, mas não encerra. O MockAdapter passou a recusar (`FORBIDDEN`) mudança de status por não-dono, espelhando a regra.
- **Layout DEV (dashboard global)**: todos os chamados de todas as empresas com **badge do nome da empresa** na linha, 5 KPIs (abertos, em andamento, urgentes/altas, resolvidos, empresas), filtros por **status, prioridade, categoria e empresa** + ordenação (recentes/antigos/prioridade) + busca (assunto, nº, empresa, solicitante), **resumo por empresa** clicável (filtra a lista), mudança livre de **status, prioridade e categoria**, ações rápidas Resolver/Reabrir e botão "Novo ticket" (interno). Seleção de empresa corrige contadores; listagem de produção mapeia `user_id`/`tenant_id` que faltavam.
- Responder reabre conversa encerrada (`resolvido/fechado → em_andamento`) — a UI sempre prometeu isso; agora o motor também faz.

### DevPlanActivationModal — ativação/extensão de plano COM PRAZO
- Substitui o "toggle" binário/infinito: **Plano** (Essencial/Profissional/Premium, pré-selecionado quando a empresa já tem), **Duração** (30/90/180/365 dias ou **data personalizada**), **Motivo** (Pix, cartão, cortesia, reativação, bug, outro) e, ao **estender plano ativo, a opção de somar os dias restantes** aos novos (edge case coberto: vencimento atual + N dias) ou recomeçar de hoje.
- **Preview ao vivo** do novo vencimento com valor de referência (plano mensal × duração; cortesia = sem cobrança), calculado no front (`base + dias × 86400000`).
- Ao salvar: `billing.activate_plan` com payload completo (`days`/`expiresAt`/`reason`/`extend`), atualização do `Store` (status `active`, `planId`, `planExpiresAt`), **registro opcional da ativação como mensagem no ticket**, e `Bus.emit('billing:changed')` + `shell:refresh` — destrava o PDV do cliente na hora, sem re-login.
- Suspensão de acesso mantida (painel e modal), com painel "Plano da empresa" reescrito (status, plano, vencimento com contador de dias, cancelamento) e cache por tenant para nao refazer o fetch a cada re-render.

### Billing: planos pagos têm PRAZO (`plan_expires_at`)
- `Billing.statusInfo()` lê `plan_expires_at`: retorna `daysLeft` real; **vencido ⇒ acesso tratado como `read_only`** (`expiredByPlan`) mesmo sem o servidor; **≤5 dias ⇒ aviso** (`expiring`). Conta dev segue ilimitada/indeterminada.
- `Billing.checkTrial()` também vira plano vencido em suspenso (local + `billing.refresh` na produção) — a liberação só volta com pagamento/ativação.
- `sales.commit` (mock) bloqueia venda com plano vencido (`BILLING_BLOCKED`), mesmo contornando a UI; checkout simulado (`checkout.completed`) passa a gravar `planExpiresAt` (30/365 dias) — fim do "ativo para sempre" para contas pagas.
- Página **Assinatura**: banner "Seu plano [Nome] expira em [X] dias ([Data])" com botão **Renovar plano**; vencido ⇒ "Plano [Nome] expirou em [data] — reative para voltar a vender" com CTA para o Suporte; sidebar passa a mostrar "Válido até [data] · N dias" (alerta âmbar nos últimos 5 dias).
- Adapter Supabase: `sync.pull`, `billing.refresh` e `billing.tenant_info` normalizam `plan_expires_at → planExpiresAt` (pronto para a migração v6; até lá o prazo da ativação fica no cliente); `tickets.list` mapeia `userId`/`tenantId`; `tickets.update` envia categoria.
- MockAdapter ganha `billing.tenant_info` / `billing.activate_plan` / `billing.suspend_tenant` / `billing.refresh` (demo 100% funcional, localStorage).

### Recomendação de banco (NÃO aplicada — pronto para a próxima etapa)
- **`supabase/recomendacao-v6-planos-com-prazo.sql`**: DDL de `plan_expires_at` + colunas de auditoria em `tenants`, `billing_refresh_status()`/`tenant_billing_ok()`/guard cobrindo plano vencido, **`pg_cron` horário que suspende lojas expiradas** (com auditoria) + aviso de expiração, patch pronto da Edge `billing.activate_plan` (persiste prazo/motivo/quem ativou) e refinamento de RLS para "dono fecha ticket". O frontend já degrada graciosamente sem a coluna.

## [1.5.0] — 2026-11-10 — Anti-abuso do teste grátis + confirmação de e-mail obrigatória

### Anti-abuso do teste grátis (múltiplas contas do mesmo IP/navegador)
- **Cadastro público passa pela Edge Function `api` (op nova `auth.signup`)**: captura o IP real do cliente (`cf-connecting-ip`/`x-forwarded-for`), registra a intenção na tabela nova `signup_audit` (IP + identificador do navegador) e valida os limites **antes** de a conta existir. Mensagem de bloqueio orienta contratar o plano pago (casos legítimos → suporte).
- **Limites configuráveis sem tocar em código**: `supabase secrets set TRIAL_LIMIT_PER_IP=1 TRIAL_LIMIT_PER_DEVICE=1` (padrão 1 e 1). O modo demo espelha os mesmos valores via `TRIAL_IP_LIMIT`/`TRIAL_DEVICE_LIMIT` no build.
- **Camada complementar de dispositivo**: cookie persistente `lc_did` (1 ano, `core.js`) enviado junto no signup — cobre IP compartilhado (empresa/4G caseiro) e IP que muda. Sem IP conhecido a regra por IP é ignorada e só a de dispositivo vale.
- **RPCs atômicas** (`signup_begin`/`signup_abort`, service role, advisory locks): reserva a vaga, bloqueia o 2º teste grátis do mesmo IP/dispositivo (contas criadas + reservas de 30 min contam) e devolve a vaga se o cadastro falhar depois. `signup_audit` sem nenhuma policy de RLS — só service role e triggers.
- **Defesa no banco, não no front**: a anon key é pública, então cadastro direto no `/auth/v1/signup` sem intenção aprovada é recusado pela trigger `handle_new_user` v4. Convites (Fluxo 1), contas dev (Fluxo 2) e contas criadas já confirmadas (dashboard/admin) seguem sem guarda e sem contar no limite.
- **Fallback seguro**: banco sem a migração aplicada → Edge Function responde `SIGNUP_BACKEND_MISSING` → o front cai no caminho antigo de signup direto — o site nunca quebra no meio do deploy.

### Confirmação de e-mail obrigatória (código de 6 dígitos, nativo do Supabase)
- **Trial começa na confirmação, não no cadastro**: o tenant nasce com `trial_pending=true` e a trigger `handle_user_confirmed` só liga os 14 dias quando `email_confirmed_at` é preenchido — por código OU pelo link (ambos caem no UPDATE de `auth.users`). Auditoria registra `conta.criada (trial pendente)` e `email.confirmado`.
- **Configuração via `supabase/configurar-emails-templates.py`**: `mailer_autoconfirm=false` (conta só ativa após confirmar) e `mailer_otp_exp=600` (código válido por **10 minutos**, uso único). O template "Confirm signup" com `{{ .Token }}` em caixa de destaque + link fica pronto no script — aplicável quando o projeto tiver SMTP próprio (o plano Free usa o template padrão do Supabase, com link).
- **Tentativas e reenvio**: 5 tentativas erradas invalidam o código (mock mostra "restam N tentativa(s)"); reenvio com rate-limit de 3 por 10 min; login de conta não confirmada é bloqueado com `EMAIL_NOT_CONFIRMED` e a tela de login redireciona para `/confirmar-codigo` com o e-mail preenchido.
- Tela `/confirmar-codigo` com mensagens específicas (código expirado/tentativas) e texto que cobre link **e** código — no plano Free (sem SMTP próprio) o Supabase usa o template padrão (link); com SMTP próprio o template com o código em destaque é aplicado pelo script e os dois caminhos funcionam.

### Corrigido
- Mock `confirmWithCode` validava sempre contra o token mais antigo quando havia reenvio (código novo era recusado) — agora prefere o token que casa com o código digitado.
- Template de e-mail de confirmação dizia "expira em 1 hora" com TTL de 10 minutos.
- `{{TRIAL_IP_LIMIT}}`/`{{TRIAL_DEVICE_LIMIT}}` agora são injetados pelo build (antes ficavam literais no bundle e o `.env` era ignorado).
- Mapa de erros do GoTrue na Edge Function ignorava `error_code` quando `code` vinha numérico (429) e a mensagem em `msg` — "email rate limit exceeded" caía no genérico "Falha ao criar a conta"; agora vira `EMAIL_SEND` com explicação do plano Free (idem prioridade no adapter do front).

### Validado E2E no projeto Supabase real
- Guarda no banco: 2º `signup_begin` do mesmo IP → `TRIAL_IP_LIMIT`; mesmo dispositivo em outro IP → `TRIAL_DEVICE_LIMIT`; e-mail dev em IP esgotado → passa (não consome vaga); IP desconhecido → só a regra de dispositivo vale; cadastro direto no `/auth/v1/signup` sem intenção → recusado pela trigger (`SIGNUP_GUARD`); falha no GoTrue após a reserva → `signup_abort` devolve a vaga.
- Fluxo de confirmação: usuário criado sem confirmar → tenant `trial_pending=true` com `trial_ends_at=now()`; login bloqueado (`email_not_confirmed`) até confirmar; confirmação → `trial_pending=false` e trial de exatamente 14 dias a partir dali, com auditoria (`conta.criada` → `email.confirmado`).
- Config aplicada no projeto: `mailer_autoconfirm=false`, `mailer_otp_exp=600` e Edge Function `api` publicada com a op `auth.signup`. Limite do plano Free (2–4 e-mails/hora sem SMTP próprio) refletido nas mensagens do app.

## [1.4.0] — 2026-11-10 — Conta Dev ilimitada, trial único e suspensão server-side

### Conta Dev (equipe JR Sistemas)
- **Papel `dev` com TUDO liberado** (antes só via Suporte+Config): todas as páginas do sistema + painel de atendimento. Helpers `is_admin()`/`is_staff()` no banco passam a incluir `dev` (cancelar venda, convidar equipe, auditoria etc.).
- **Plano `dev` por tempo indeterminado**: tenant com `plan_id='dev'` + `trial_ends_at` em +200 anos; badge "Dev · ilimitado" no topbar, sidebar "Dev · acesso ilimitado" e página Assinatura com visão interna (sem grade de preços).
- **Whitelist de e-mails dev** (`handle_new_user` v3): signup com e-mail da equipe JR nasce `dev` com tenant ilimitado — nunca mais "conta dev que caiu no trial".
- Suporte para dev = **recebedor de tickets** (visão "Todos os tickets" de todas as empresas) — sem botão "Abrir ticket", como cliente.
- Corrigida a conta do dono (`jrsistemasetecnologiabr@gmail.com`, criada como admin/trial) → promovida a `dev` + tenant ilimitado.

### Trial grátis: único e não renovável (furo fechado no servidor)
- **Guard de cobrança**: trigger `guard_tenants_billing` bloqueia qualquer PATCH em `status/plan_id/plan_cycle/trial_ends_at/next_charge_at/...` por usuário autenticado — o admin da loja não pode mais se auto-liberar ou estender o teste via PostgREST (era o furo da "renovação infinita"). Única transição permitida: `trialing→read_only` com trial vencido (só suspende). Gravações de billing só via service role (Edge Function).
- **Expiração virada no servidor**: RPC `billing_refresh_status()` vira trial vencido em `read_only` (com auditoria); `commit_sale`/`stock_entry`/`stock_adjust` chamam a RPC antes de operar — venda e estoque bloqueados mesmo contornando a UI (erro `TRIAL_EXPIRED` com mensagem própria).
- **Policies RLS com `tenant_billing_ok()`**: produtos/categorias/movimentos/vendas também bloqueados para tenant suspenso (HTTP 403 direto no PostgREST).
- Suspensão com saída clara: PDV bloqueado explica "teste de 14 dias terminou" + botões **Ver planos** e **Pedir ativação** (abre ticket de faturamento pré-preenchido); banner da Assinatura idem.

### Suporte: ferramentas da equipe JR no ticket
- Novo painel **"Plano da empresa"** no detalhe do ticket (só dev): status/plano/trial/próxima cobrança da empresa + **Ativar plano** (essencial/profissional × mensal/anual) e **Suspender acesso** — via Edge Function com service role (`billing.activate_plan`/`billing.suspend_tenant`/`billing.tenant_info`, só papel dev).
- **Ativação reconciliada na hora**: cliente logado e suspenso é liberado ao navegar (`Billing.syncRemote` → `billing.refresh`, throttle 45s) com toast "🎉 Assinatura ativada!" — sem re-login.
- Cancelamento de assinatura pelo admin agora persiste no servidor (Edge `billing.cancel`; o PATCH direto era local e passou a ser bloqueado pelo guard).

### Corrigido
- **"Renovar agora" da sessão não renovava nada**: o botão chamava `touch()` (no-op enquanto a sessão é válida) e o toast mentia "renovada por 60 min" com o relógio parado em ~20 min. Novo `AuthService.renew()` faz a troca real do refresh token (Supabase) e só então mostra o prazo verdadeiro; `touch()` agora renova proativamente em background quando faltam <5 min (com antirrepetição de 10s).
- **Renovação/troca de token derrubava o perfil**: o refresh reescrevia a sessão inteira e perdia `profile`/`tenantId` (logout fantasma no próximo reload) — agora preserva os campos hidratados.
- Cartão da sessão renomeado para **"Sessão de login (segurança)"** com texto explicando que o prazo é da sessão, não do plano (era a confusão "renovei e continua 20 min").
- `sync.pull` agora auto-corrige papel/nome do perfil logado (conta promovida a dev pega o novo papel sem re-login) e reflete trial vencido na hora.
- Checkout em produção com gateway não integrado: mensagem orientando Pix + ativação pelo Suporte (antes: erro genérico de "operação aguardando integração").

## [1.3.1] — 2026-11-10 — Revalidação completa do sistema: 9 correções

Validação E2E real no site publicado (login dev e cliente, signup, PDV com venda, tickets dos dois lados, troca de senha, 16 viewports de 320px a 8K). Tudo operando; bugs encontrados e corrigidos:

### Corrigido (validação E2E)
- **Entrada de estoque falhava com "Registro não encontrado"**: o form validava só `qtd/custo` e o `Validate.run` descartava `productId/fornecedor/nf/note` — a RPC `stock_entry` recebia payload sem produto. Idem **Ajuste manual** (`delta/reason` sem `productId/note`). Ambos agora coletam todos os campos e normalizam decimais (`U.parseNum`) — em ambos os motores (mock e Supabase).
- **Configurações da loja descartavam edits** de endereço, telefone e mensagem do comprovante (schema validava só nome/CNPJ; `reciboMsg` ia como `undefined`).
- **Convite de equipe ignorava o papel escolhido**: `papel` fora do schema → Edge Function aplicava o default "caixa" para todos os convites, mesmo selecionando admin/gerente.
- **Cache local**: a "entrada de cadastro inicial" só aparecia na lista de movimentos após re-login (agora o `products.create` também registra no cache da sessão).
- **Overflow de 4px na landing em telas de 320px**: CTA "Começar 14 dias grátis" (`white-space:nowrap`) não cabia — CTAs empilhados em largura total até 430px.
- **Rótulo do checkout dizia "Stripe"** com provider InfinitePay; nota de demo citava Stripe/Asaas → InfinitePay.
- Copy do plano Essencial herdada da era single-vertical ("Para o depósito de 1 caixa", "Suporte WhatsApp") → "Para começar com 1 caixa" / "Central de suporte no app".
- **Recuperação de senha**: falha de envio do Supabase (limite do plano Free sem SMTP) agora vira mensagem clara `EMAIL_SEND` ("limite do provedor — tente em alguns minutos") em vez de "serviço indisponível" genérico.
- CI: workflow do Pages não repassava `BILLING_PROVIDER` (build do CI divergia do local) — agora `infinitepay` nos dois.
- **Exclusão LGPD (Conta & senha) não funcionava em produção**: sem override no adapter Supabase, caía no motor local ("Senha atual incorreta." sempre). Agora: login real valida a senha → Edge Function `account.request_deletion` (admin) registra em `account_deletion_requests` + auditoria; UI mostra "Carência de 30 dias iniciada."
- **Nada executava a exclusão após a carência**: novo sweeper `cron.purge_deletions` na Edge Function (segredo compartilhado GitHub Secret ↔ secret da função; chamado pelo workflow keep-alive a cada 6h) — marca `executed_at`, apaga o tenant (cascade: produtos, vendas, estoque, tickets, convites) e o login `auth.users` (LGPD). 403 com segredo errado, 200 com o certo.
- Higiene: `uri_allow_list` do Supabase Auth sem `localhost:3000`/`alojacerta.vercel.app` (sobrava do dev) — só as rotas do GitHub Pages.

### Validado e confirmado operando (sem alteração)
- Signup→tenant+admin+categorias por segmento, trial 14d, auto-login; sessão persistente com refresh.
- PDV: busca por código interno, carrinho, pagamento Pix, confirmação, comprovante; baixa de estoque e movimentos no Supabase (VENDA-000001); KPIs de estoque conferem (49×R$20,50 = R$1.004,50).
- Suporte: ticket do cliente (criar/mensagem/resolver), painel dev multiempresa via RLS `is_dev()`, resposta com badge "Equipe JR", mudança de status/prioridade; anônimo não vê tickets (RLS).
- Alterar senha: valida senha atual com login real, erro pt-BR "Senha atual incorreta.", round-trip com nova senha confirmado.
- Responsivo: 16 viewports (320–8K) sem overflow na landing/auth/app; drawer mobile abre, navega e fecha sozinho.
- Recuperar senha: fluxo do app correto; **envio real do e-mail exige SMTP próprio no Supabase** (limite do plano Free) — mensagens já prontas em pt-BR.

## [1.3.0] — 2026-11-10 — Produção real: suporte, convites, Pages e correções

### Área de Suporte (tickets) — clientes + equipe JR
- Nova página **Suporte** (menu Conta) para todos os papéis: abrir ticket (assunto, categoria, prioridade, descrição), conversar em thread estilo chat e resolver.
- **Papel `dev`** (equipe JR Sistemas): painel multi-empresa com KPIs, filtros, busca, resposta com badge "Equipe JR" e mudança de status/prioridade — acesso a TODOS os tickets via RLS `is_dev()`.
- Banco (migração v4): `support_tickets` + `ticket_messages` + contadores + snapshots por trigger + RLS completa + RPC `support_create_ticket`; guarda anti-escalonamento (ninguém se promove a `dev`).
- Telas responsivas (lista em cards no mobile, chat com bolhas, Ctrl+Enter envia).

### Convites de equipe reais
- Edge Function `api` (Deno, sem deps) com CORS correto: `users.invite` cria convite com token, envia e-mail nativo do Supabase e a trigger `handle_new_user` coloca o convidado no tenant certo com o papel do convite (nunca cria tenant novo).
- Aba Equipe mostra **convites pendentes** com cancelamento; tela nova `/definir-senha` para o convidado criar a senha no primeiro acesso.

### Correções de bugs
- **Comprovante mostrava `[object Object]`** no lugar de itens e pagamentos (`raw()` dentro de `map().join()`).
- **Link de recuperação caía no dashboard**: regex `type=` casava com `token_type=bearer` e perdia o `type=recovery` (fronteira `&`/`#` adicionada).
- **Alterar senha em produção não validava a senha atual** — agora faz um login real antes de atualizar (e mapeia erros do Supabase para pt-BR).
- **Rate-limit de login contava logins bem-sucedidos** (demo) — agora só falhas.
- Erros de auth do Supabase em inglês ("Invalid login credentials") → mensagens amigáveis em pt-BR.
- Redirecionamentos pós-login respeitam o papel (dev → Suporte; sem loop para páginas não liberadas).
- `redirect_to` da recuperação e links de e-mail do app usavam domínio antigo — agora `SITE_URL` configurável.

### Infra & deploy
- **GitHub Pages** via Actions (`deploy-pages.yml`): build de produção + publicação automática a cada push na main.
- Supabase Auth configurado: Site URL, redirects, mínimo de senha 8, notificações de troca de senha/e-mail.
- Templates de e-mail tematizados pt-BR prontos (`supabase/configurar-emails-templates.py`) — aplicam-se assim que um SMTP próprio for conectado (o plano Free sem SMTP limita envios e bloqueia templates).
- Termos de uso e política de privacidade reais (LGPD, DPO, sa-east-1); rodapé com JR Sistemas e Tecnologia.
- `.env.example` com `SITE_URL`; `build.js` injeta `SITE_URL` em canonical/OG/JSON-LD/sitemap/robots.

## [1.2.0] — 2026-09-22 — Três modos de build (final / demo / produção)

- **`npm run build` → `release/index.html` = VERSÃO FINAL para publicar**: sem chip de demo, sem contas de demonstração, sem avisos de "dados fictícios"; primeira conta criada vira admin; motor local completo (auth, billing por webhooks, e-mails em fila) até o backend ser conectado.
- **`npm run build:demo` → `release/demo/`**: apresentações comerciais (chip, seed populado, contas demo, simuladores).
- **`npm run build:prod` → `release/producao/`**: com `.env` preenchido; guard impede operar sem backend real.
- Recuperação de senha e troca de e-mail funcionam sem provedor de e-mail via fila local (aba Configurações → Fila de e-mails) com links de token; ao conectar Resend/Brevo/SES, nada muda nas telas.
- Validação browser real dos 3 modos: signup→venda→recuperação (final), chip/contas (demo), guard (produção) — 0 erros de console.

## [1.1.0] — 2026-09-22 — Multi-vertical + autenticação completa

### Mudança de marca/escopo
- **ObraCerta → LojaCerta**: agora multi-vertical (depósitos, supermercados, varejo, pubs/restaurantes, clínicas e outros).
- Cadastro com **segmento** → categorias padrão por vertical; unidades expandidas (mg, g, kg, t, mL, L, m, m², m³, pct, fd, par, dz, balde, galão, hr, serv…).
- Nova identidade (logo sacola+check) em landing, app, favicon e e-mails.

### Autenticação (100% interna, pronta p/ provider)
- `auth-core.js`: hash SHA-256 salgado + iterações (nunca texto puro), tokens de uso único c/ expiração (reset/confirmação/troca de e-mail), rate-limit, política de senha, sessões com expiração + renovação deslizante (1h/30d).
- Telas novas: `/recuperar`, `/redefinir`, `/confirmar-email` (+ troca de e-mail), aba **Conta & senha** (alterar senha/e-mail, sessão, exclusão LGPD com carência) e **Emails (dev)** (outbox local com links de token).
- Fluxos completos: signup→confirmação→login, esqueci-minha-senha→token→nova senha→login, alteração de senha/e-mail, sessão expirada, credenciais inválidas, usuário inexistente, rate-limit.
- `SupabaseAuthAdapter` pronto (signup/login/logout/refresh/recover/update) — ativa sozinho com `.env` em produção.

### Billing como evento real
- Toda mutação de assinatura passa por `BillingWebhook.ingest` (idempotente por event id): checkout.completed, payment.approved/declined, subscription.canceled, refund.created, trial.expired + upgrade imediato e downgrade agendado p/ próximo ciclo.
- E-mails transacionais com templates HTML (10 tipos) via `EmailService` + adapter de envio trocável.

### Banco
- `schema.sql`: + `subscription_events` e `account_deletion_requests` (RLS inclusas).

### Testes
- 67 unitários (incl. vetor FIPS do SHA-256, tokens expirados/usados, rate-limit, sessão, webhooks idempotentes) + 17 verificações E2E/visuais (incl. fluxo real de recuperação de senha no navegador).

## [1.0.0] — 2026-09-22 — Entrega oficial

### Adicionado
- **Produto completo (demo interativa single-file)**: landing com SEO (meta/OG/JSON-LD, robots,
  sitemap), auth com trial de 14 dias, dashboard, PDV (código de barras, autocomplete acessível,
  pagamento misto com troco, desconto com autorização por papel, comprovante térmico 80 mm),
  produtos com importação CSV validada, estoque (entradas/ajustes/histórico/valuation),
  vendas com cancelamento auditado, relatórios exportáveis, assinatura com máquina de estados
  (`trialing → active → past_due → read_only`) e bloqueio real do PDV, configurações com equipe/RBAC,
  auditoria, exportações LGPD e simuladores de falha/latência.
- **Arquitetura de produção**: camada `ApiClient → Adapter` (Mock/Supabase/HTTP), `src/js/adapters.js`
  com seleção automática por `Config.env` e guard anti-mock em produção; schema SQL completo com
  RLS multi-tenant (`supabase/schema.sql`); Edge Functions `api` e `billing-webhook`
  (Stripe/Asaas, idempotente, com verificação de assinatura).
- **Pipeline**: `npm run build` (demo) e `npm run build:prod` (produção, lê `.env`),
  `optimize` (sharp), `hero` (captura real do app), `test` (50 unitários sobre o bundle),
  `test:visual` (Puppeteer: 10 viewports, E2E, a11y, perf), `check`.
- **Docs**: README, INTEGRATIONS.md, supabase/README.md (passo a passo de conexão),
  Manual do Projeto em PDF (13 páginas) e este changelog.

### Qualidade verificada
- 50/50 testes unitários/integração · 16/16 verificações visuais/E2E ·
  90 combinações viewport×página sem overflow · 0 erros de console ·
  DCL ~200 ms · bundle 660 KB · DOM landing 431 nós.

### Segurança
- Templates com escape automático (anti-XSS, teste dedicado) · RBAC validado em UI e serviço ·
  exportação LGPD sem senhas · segredos apenas server-side (Edge Functions) ·
  guard `NOT_CONFIGURED` impede produção rodando com mock.

## [0.x] — iterações anteriores (histórico de trabalho)
- Protótipos exploratórios e plano de negócio (substituídos por este projeto; não distribuídos).
