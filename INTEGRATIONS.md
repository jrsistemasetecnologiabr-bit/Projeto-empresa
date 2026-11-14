# LojaCerta · Integrações — pontos de conexão prontos para produção

A camada de dados é **totalmente isolada da UI**: páginas só falam com os serviços de domínio
(`Auth`, `Billing`, `Catalog`, `Inventory`, `Sales`, `Reports`, `Audit`, `DataOps`), que falam com
`ApiClient.request(op, payload)`, que delega a um **adapter**. Trocar o adapter não altera nenhuma tela.

**Auth 100% interna já implementada** (`auth-core.js`): hash salgado iterado, tokens de uso único com expiração, rate-limit, sessão 1h + janela de renovação 30d, recuperação/redefinição/troca de e-mail completos — o provider real (Supabase Auth) entra via `SupabaseAuthAdapter` sem reescrever telas ou fluxos.

**Implementações prontas neste repositório:** `src/js/adapters.js` (SupabaseAdapter + HttpAdapter +
seleção automática por `Config.env` + guard anti-mock em produção) · `supabase/schema.sql` (tabelas,
índices, RLS multi-tenant, triggers de signup/categorias + anti-abuso do teste grátis e trial na
confirmação do e-mail) · `supabase/functions/api` (backend das ops — inclui `auth.signup` com guarda
por IP/dispositivo) · `supabase/functions/billing-webhook` (Stripe/Asaas, idempotente) · passo a passo de conexão em
`supabase/README.md` · chaves via `.env` (ver `.env.example`).

```
UI (pages/*.js)  →  Serviços de domínio  →  ApiClient.request(op, payload)  →  Adapter
                                                                                    ├─ MockAdapter   (hoje: localStorage, latência e falhas simuláveis)
                                                                                    ├─ SupabaseAdapter (esqueleto abaixo)
                                                                                    └─ HttpAdapter     (API própria / BFF)
```

## 1. Contrato do adapter

```js
// interface Adapter { request(op: string, payload: object): Promise<any> }
// O MockAdapter já implementa: latência (Config.latency), injeção de falha
// (Config.simulateFailures / Config.failOps), persistência após mutação e
// emissão de Bus 'store:changed' (as páginas re-renderizam sozinhas).
ApiClient.adapter = SupabaseAdapter; // ← única linha para virar produção
```

Operações existentes (todas retornam Promise; erros são `ApiError{code,message}`):

| Grupo | ops |
|---|---|
| auth | `auth.signup` `auth.login` `auth.logout` |
| billing | `billing.subscribe` `billing.cancel` `billing.setPastDue` |
| produtos | `products.create` `products.update` `products.toggle` |
| estoque | `inventory.entry` `inventory.adjust` |
| vendas | `sales.commit` `sales.cancel` |
| conta | `tenant.update` `users.invite` `users.update` |

## 2. SupabaseAdapter (esqueleto pronto)

```js
window.SupabaseAdapter = {
  async request(op, payload) {
    const { baseUrl, anonKey } = Config.api;            // injetados no build (env), nunca hardcoded
    const res = await fetch(baseUrl + '/functions/v1/' + op, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey,
                 Authorization: 'Bearer ' + (await currentSessionToken()) },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { const e = await res.json(); throw ApiError(e.code, e.message); }
    return res.json();
  }
};
```

No banco (Postgres/Supabase), o schema espelha o estado do mock — tabelas com `tenant_id` +
**Row Level Security** por tenant e papel:

```
tenants(id, nome, cnpj, endereco, telefone, status, trial_ends_at, plan_id, plan_cycle,
        stripe_customer_id, stripe_subscription_id, next_charge_at, config jsonb)
users(id auth.uid, tenant_id, nome, email, papel[admin|gerente|caixa], ativo)
categories(id, tenant_id, nome)
products(id, tenant_id, codigo, nome, category_id, unidade, preco_custo, preco_venda,
         estoque_atual, estoque_minimo, fornecedor, ativo, created_at)
sales(id, tenant_id, numero, created_at, user_id, subtotal, desconto, total, status,
      motivo_cancelamento) + sale_items(sale_id, product_id, qtd, preco, subtotal)
      + sale_payments(sale_id, forma, valor, troco)
stock_movements(id, tenant_id, product_id, tipo[entrada|saida|ajuste|venda_cancelada],
                qtd, user_id, origem, obs, created_at)
invoices(id, tenant_id, provider, provider_id, plan_id, cycle, valor, status, paid_at)
audit_logs(id, tenant_id, user_id, acao, entidade, entidade_id, detalhes jsonb, created_at)
```

**Auth real:** substituir o login demo por Supabase Auth (e-mail/senha + magic link);
senhas nunca residem no front; `users.senha` do mock existe só na demo e é removida em exports.

## 3. Cobrança (Stripe / Asaas — Pix Automático, cartão, boleto)

`BillingService` não conhece gateway: ele aplica **eventos** que o webhook traduz:

| Evento do gateway | Ação no tenant |
|---|---|
| `checkout.session.completed` / assinatura criada | `status = active`, grava `invoices` |
| `invoice.paid` | renova `next_charge_at`, invoice `pago` |
| `invoice.payment_failed` (1ª vez) | `status = past_due` (carência 3 dias, PDV segue aberto com aviso) |
| falha após carência / `customer.subscription.deleted` | `status = read_only` (PDV bloqueado; relatórios + exportação LGPD liberados) |
| reativação / nova assinatura | `status = active` |

- **Pix Automático** (débito recorrente do BC): no Asaas, criar `subscription` com `billingType=PIX`;
  no Stripe (2026+), usar recurring com Pix mandate. O checkout da UI já oferece as 3 formas.
- Webhook deve **verificar assinatura** do provider e ser idempotente (chave = event id).
- Preços/limites vivem em `Billing.PLANS` (fonte única usada pela landing e pelo app).

## 4. Analytics, notificações, storage, fiscal

- **Analytics**: `Analytics.track(event, props)` já emite `Bus 'analytics:track'` com
  `signup`, `sale_commit`, `subscribe`, `cancel_subscription`. Plugar GA4/Meta:
  `Bus.on('analytics:track', e => gtag('event', e.event, e.props))`.
- **Notificações (WhatsApp/e-mail)**: `NotificationsService` stub — chamar em
  `sales.cancel`, `billing.*`, estoque mínimo (hook natural: `Bus 'store:changed'` + diff).
- **Storage (logos, PDFs de comprovante)**: `DataOps` hoje gera via Blob; trocar por
  Supabase Storage/S3 mantendo a mesma assinatura (`exportJSON/exportCSV`).
- **Fiscal NFC-e/NF-e (fase 2)**: ponto de entrada = `Sales.commit` (pós-gravação) →
  fila `fiscal_queue` → API parceira (Focus NFe/TecnoSpeed/PlugNotas). UI já reserva o
  recurso no plano Premium e no painel de integrações.

## 5. Configuração de ambiente

```js
Config.env            // demo | staging | production (build injeta)
Config.api.baseUrl    // URL da API/edge functions — vazio na demo
Config.api.anonKey    // chave pública do Supabase (segredos NUNCA aqui; server-side no webhook)
Config.latency        // 0 em produção
Config.providers      // {auth, db, billing, analytics, notifications, fiscal} — painel exibe na UI
```

Build-time: `tools/build.js` pode substituir placeholders `%%API_BASE%%`/`%%ANON_KEY%%`
(adicionar um passo de replace lendo `process.env`) — mantendo o bundle single-file.

## 6. Checklist de endurecimento para produção

- [ ] RLS ativo em todas as tabelas + testes de isolamento entre tenants
- [ ] Segredos apenas server-side (webhook/BFF); anonKey pública limitada por RLS
- [ ] CSP com nonces ao servir (o bundle inline de demo vira assets separados ou nonces)
- [ ] Rate limiting em auth/commit; idempotência em webhooks
- [ ] Backups diários do Postgres + drill de restauração
- [ ] Termos/Privacidade revisados por advogado (os atuais são modelo de demonstração)
- [ ] Monitoramento: Sentry no front + logs estruturados no BFF
