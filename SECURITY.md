# Segurança — LojaCerta

Política de segurança, gestão de segredos e checklist de pré-go-live.
Público: o dono do SaaS (equipe JR Sistemas) e qualquer auditor.

---

## 1. Onde vivem os segredos (e onde NÃO vivem)

| Segredo | Onde vive | Quem acessa |
|---|---|---|
| `DEV_PIN` (2º fator de cobrança) | Supabase → Project Settings → Edge Function Secrets | Só o dono (Dashboard/CLI) |
| `PURGE_SECRET` (sweeper LGPD) | Supabase Secrets + GitHub Secret (workflow keep-alive) | Só o dono |
| Service role key | Supabase Dashboard (nunca no repo, nunca no bundle) | Só o dono + Edge Function |
| Anon key | Bundle público e workflow (por design — a proteção real é o RLS) | Pública |
| Supabase Access Token (CLI/Management API) | Máquina do dono / ambiente de trabalho | Só o dono |
| Senha da conta dev oficial | Arquivo local `.devpw` (fora do repo; coberto pelo `.gitignore`) + gerenciador do dono | Só o dono |
| Senhas das contas de teste (QA/E2E) | Arquivo local `.e2e_creds.json` (fora do repo) + GitHub Secrets (`SMOKE_TEST_*`) | Dono + CI |
| Chave da API de e-mail (Resend) | **Supabase Vault** (segredo `resend_api_key` + `email_from`) — nunca em secret de função nem no repo | Só o dono |
| Assinatura de webhook InfinitePay | Supabase Secrets (`INFINITEPAY_WEBHOOK_SECRET`) — stub valida HMAC quando existir | Só o dono |

**Regras inegociáveis:**

- **Nenhum segredo entra no repositório Git** — o `.gitignore` cobre `.env`/`.env.*`
  (com exceção do `.env.example`), `.dev_pin`, `.devpw`, `.e2e_creds.json` e
  afins — inclusive se alguém copiar esses arquivos para dentro do repo por
  engano. Verifique antes de qualquer commit:
  `git log --all --full-history -- .env .dev_pin .devpw .e2e_creds.json` deve
  retornar **vazio**, e `git ls-files | grep -E 'devpw|dev_pin|e2e_creds'` também.
- Segredo escrito em conversa, chat, e-mail ou print **considera-se comprometido** —
  rotacione no mesmo dia (é o que este documento pressupõe da v1.7.2 em diante).
- Arquivos de credencial de trabalho (`.dev_pin`, `.e2e_creds.json`, tokens de API)
  vivem **fora do repo**, apenas na máquina do dono, e são rotacionados sempre que
  houver suspeita de exposição.

## 2. PIN de cobrança (2º fator das operações de cobrança)

`billing.activate_plan` e `billing.suspend_tenant` (Edge Function `api`) exigem o
header `x-dev-pin` além da sessão dev. Propriedades desde a **v1.7.2 / migração v9**:

- **Comprimento mínimo 12 caracteres** — PIN configurado mais curto é *recusado* pela
  Edge com `DEV_PIN_INSECURE` (o PIN em uso tem 24).
- **Rate limit + lockout**: 5 tentativas erradas em 15 min — contadas **por ator e por
  IP** — travam a operação de cobrança por 15 min (`PIN_LOCKED`, HTTP 429). Acertar o
  PIN zera o contador do ator.
- **Rastro total**: cada tentativa vira linha em `pin_attempts` (ator, IP, horário,
  resultado); tentativa errada e bloqueio geram `audit_logs` (`pin.tentativa_falha` /
  `pin.bloqueado`) visíveis na tela **Configurações → Ações do admin**.
- Limpeza automática: `pg_cron` diário mantém 24 h de histórico em `pin_attempts`.

**Rotacionar o PIN** (fazer sempre que houver exposição, a cada troca de equipe e no
mínimo a cada 6 meses):

```bash
# gere um PIN aleatório (24 chars) — guarde no gerenciador de senhas
python3 -c "import secrets,string; a=string.ascii_letters+string.digits; print(''.join(secrets.choice(a) for _ in range(24)))"
# defina a secret no projeto (cole o valor gerado no lugar do placeholder)
supabase secrets set --project-ref qmqllssextbxwwphawod "DEV_PIN"="<cole-aqui-o-PIN-gerado>"
```

> **Regra de ouro:** o novo PIN **nunca** é colado em chat/conversa — o dono guarda no
> gerenciador de senhas (Bitwarden/1Password/keepass) e informa a equipe por canal privado.

## 3. Conta dev (allowlist) e conta de CI

- `public.dev_emails()` define quem **nasce** `dev` no signup. Hoje: um único e-mail
  (conta oficial do dono). Alterar = SQL Editor do dono + fica na trilha de auditoria.
- Mudança de papel (`dev` ↔ outros) por usuário autenticado é bloqueada pelo trigger
  `guard_papel_dev()`; mudanças por service role ficam registradas em `audit_logs`
  (trigger `audit_users_changes`, antes→depois).

### 3.1 Senha da conta dev oficial — regra do dono

> **Senha da conta dev oficial definida pelo dono. Scripts automatizados não
> podem alterá-la. O dev pode alterar via app. Ao alterar, atualize este documento.**

- Definida em 10/11/2026 pelo dono (via prompt de trabalho → `auth.admin.updateUserById`
  com `email_confirm: true`; política do projeto: `password_min_length = 8`).
- A senha **nunca** é versionada no repo nem impressa em log/evidência/CI. O grep
  de auditoria (rodar na raiz do repo, substituindo `<literal-atual>` pela senha
  vigente, que só o dono e o arquivo local `.devpw` conhecem):
  `git grep -r "<literal-atual>"` deve retornar **vazio** em qualquer commit.
- **Troca de senha**: pelo app em **Configurações → Conta & senha** (ou Dashboard →
  Authentication). Depois de trocar, atualize a nota acima (nova data) e o literal
  do grep de auditoria nesta seção.
- **Scripts**: `scripts/guard_dev_account.py` (fora do repo) exporta
  `assert_not_dev_account(email, id)` — todo script que tocar `/auth/v1/admin/users`
  DEVE chamá-lo antes da escrita. A definição inicial pontual usou o setter
  `p0_senha_dev.py --autorizado-pelo-dono` (operação única, documentada em
  `download/evidencias/p0h-dev-account-guard.txt`).
- **Se o login falhar** (regra do dono): diagnosticar **sem alterar a senha** —
  `429` → rate limit do GoTrue, aguardar 60 s; ban acidental → `ban_duration: 'none'`;
  e-mail não confirmado → `email_confirm: true`; `weak_password` → conferir
  `password_min_length` (deve ser 8).

### 3.2 Conta oficial de CI/monitoramento (pós-cleanup v1.8.0)

- **`qa.lojacerta@example.com`** (tenant “QA Validação — LojaCerta”) é a ÚNICA conta
  de teste permanente: alimenta o smoke do CI (`SMOKE_TEST_*`) e o E2E. Senha forte
  rotacionada, fora do repo (`.e2e_creds.json`). Não é conta de cliente — não pode
  ser removida sem substituir os secrets do CI.
- Todas as demais contas de teste (cliente de demonstração, espelho `.br`) foram
  removidas no cleanup de go-live (histórico de auditoria exportado antes — ver
  `download/evidencias/cleanup-audit-export-*.txt`).

## 4. Como reportar vulnerabilidades

- Canal: e-mail do dev (consta no rodapé do site e no README) com assunto
  `[segurança] LojaCerta`.
- **Não abra issue público** para falhas de segurança.
- Prazo de resposta: 72 h; correção crítica: até 7 dias.
- Reporte responsável com detalhes técnicos é bem-vindo e creditado (se o autor quiser).

## 5. Checklist de pré-deploy (antes de cada release)

- [ ] `npm run run-tests` — suíte reproduzível passando (smoke 15/15)
- [ ] `git log --all --full-history -- .env .dev_pin .devpw .e2e_creds.json` → vazio
- [ ] `git ls-files | grep -E 'devpw|dev_pin|e2e_creds|\.env$'` → vazio
- [ ] Nenhum segredo novo no diff (`git diff --staged | grep -iE "pin|secret|token|password"`)
- [ ] Migrações SQL aplicadas na ordem (v4 → v13) e sem erro
- [ ] Edge Function publicada e `op: ping` respondendo
- [ ] Auditoria da tela "Ações do admin" sem eventos inesperados

## 6. Checklist de go-live (antes do 1º cliente pagante)

- [ ] **Rotacionar o PIN** de cobrança (procedimento acima) e guardar no gerenciador
- [ ] **Remover as contas/tenants de teste** do banco de produção:
      ```sql
      -- apagar tenant de teste "Loja do Carlos" (cascade: produtos, vendas, tickets…)
      delete from public.tenants where id = 'fff1ad88-242c-4480-bc9e-da6e87730058';
      -- apagar tenant QA (cascade idem)
      delete from public.tenants where id = '058653cc-1612-4105-88a6-6e71adbf5f1f';
      -- remover os logins de teste do Auth (QA, Carlos e espelho .br)
      -- (Dashboard → Authentication → Users, ou Admin API deleteUserById)
      ```
      > Decisão do dono: remover **ou** transformar uma delas em conta-demo oficial com
      > senha forte e dados fictícios assumidos. Hoje elas existem para E2E.
      > **Atenção:** o tenant dev órfão (`5900d1fd…`, da antiga conta espelho) guarda o
      > histórico de auditoria da consolidação — só apagar após exportar/aceitar a perda
      > do rastro (FK `audit_logs.tenant_id` é `on delete cascade`).
- [ ] Senhas de contas de teste rotacionadas ou contas removidas (nunca commitadas)
- [ ] **SMTP próprio no Auth do Supabase** (Resend) — SEM isso o plano Free
      limita ~2 e-mails/h e **cadastros de clientes novos podem ser recusados**
      por até 1h quando o limite é atingido (achado do go-live 10/11/2026;
      ver README → "SMTP do Supabase Auth"). Troca de senha também consome 1 e-mail.
- [ ] Chave do Resend no Vault (`resend_api_key` + `email_from`) — liga o e-mail
      de resposta de ticket e o digest de vencimento (runbook no README)
- [ ] Revisar "Ações do admin" (eventos `pin.*` sem explicação = investigar)

## 7. Limitações conhecidas (aceitas até a próxima fase)

- **E-mail sai via Resend só com a chave no Vault** (`resend_api_key`): sem ela,
  respostas de ticket e avisos de vencimento ficam in-app + trilha `skipped_no_key`
  (runbook de ativação no README). O SMTP nativo do Supabase (free) segue como
  canal do e-mail de confirmação de cadastro (limite ~2/h).
- **Webhook InfinitePay é stub**: valida HMAC (se secret configurada) e registra —
  o processamento de cobrança real é a próxima integração (formato de assinatura
  a confirmar com o provedor).
- **Headers HTTP no GitHub Pages**: a plataforma não permite configurar headers —
  sem `X-Frame-Options`, sem CSP por header, sem `frame-ancestors` (nem em
  `<meta>`, por spec). Desde a v1.7.3 o app se protege no que dá: CSP via
  `<meta>` (bloqueia script/fonte externa e exfiltração — `connect-src` só o
  Supabase do projeto), `referrer` restrito e anti-clickjacking em JS. Para a
  proteção completa (headers com nonce, `frame-ancestors`, HSTS customizado),
  a decisão pendente é **Cloudflare free na frente do GH Pages** (ver README →
  "Headers de segurança e cache"). Auditoria de segurança deve registrar a
  limitação da plataforma enquanto a decisão não for tomada.
- **Auditoria com IP**: escritas mediadas pela Edge registram IP (`origem='edge'`);
  escritas diretas no banco (triggers) não têm como conhecer o IP real do cliente
  (`origem='db'`, `ip=null`) — limitação de plataforma, aceita.
- **Polling de 60s** (badge/billing) mantido por decisão documentada: carga
  aceitável na escala atual e simplicidade operacional; Supabase Realtime
  (wss já liberado na CSP) é a evolução natural quando o volume justificar.
- **Notificação de ticket** tem agora DUAS camadas (v1.8.0): in-app (badge+banner)
  + e-mail quando o Resend estiver ativado.
