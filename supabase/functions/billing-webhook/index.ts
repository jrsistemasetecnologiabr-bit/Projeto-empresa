// LojaCerta · Edge Function "billing-webhook" (Deno/Supabase — sem imports externos)
// Recebe webhooks do gateway de cobrança e aplica a máquina de estados do tenant:
//   checkout/assinatura criada      → status = 'active'   + invoice 'pago'/'pendente'
//   invoice.paid                    → renova next_charge_at + invoice 'pago'
//   invoice.payment_failed (1ª)     → status = 'past_due' (carência)
//   falha após carência / deleted   → status = 'read_only' (PDV bloqueado)
// Idempotente via public.webhook_events.
//
// v13 (Onda 6b): provider "infinitepay" em modo STUB — valida HMAC-SHA256
// (header x-signature, hex, tempo constante) quando INFINITEPAY_WEBHOOK_SECRET
// está configurada, registra o evento em webhook_events e responde 200 SEM
// processar (integração real futura; esquema de assinatura a confirmar com a
// InfinitePay — a doc pública de checkout não o especifica).
//
// Segredos (config do projeto Supabase, NUNCA no front):
//   STRIPE_WEBHOOK_SECRET | ASAAS_WEBHOOK_TOKEN | INFINITEPAY_WEBHOOK_SECRET
//   | SUPABASE_SERVICE_ROLE_KEY (injetada pela plataforma)
// Zero imports externos — mesmo padrão da função "api" (boot instantâneo,
// sem dependência de deno.land/esm.sh, que derrubava o boot desta função).

const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const stripeSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const graceDays = 3;

const sr = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(init.headers || {}),
    },
  });

async function alreadyProcessed(eventId: string, tipo: string, payload: unknown) {
  const r = await sr("/rest/v1/webhook_events", {
    method: "POST",
    body: JSON.stringify({ provider_event_id: eventId, tipo, payload }),
  });
  return !r.ok; // 201 = gravou (novo) · 409/23505 = já processado
}

/* HMAC-SHA256 hex do corpo bruto com a secret dada (tempo constante no compare) */
async function hmacHex(secret: string, raw: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqualHex(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function setTenantStatus(tenantId: string, status: string, extra: Record<string, unknown> = {}) {
  await sr(`/rest/v1/tenants?id=eq.${tenantId}`, { method: "PATCH", body: JSON.stringify({ status, ...extra }) });
}

async function tenantBySubscription(subId: string) {
  const q = await sr(`/rest/v1/tenants?select=id&stripe_subscription_id=eq.${subId}&limit=1`);
  const rows = await q.json();
  return Array.isArray(rows) && rows[0] ? rows[0].id : null;
}

/* ============================================================================
   ASAAS — integração real (v1.9)
   Configure no painel Asaas → Integrações → Webhooks:
     URL:   https://<projeto>.supabase.co/functions/v1/billing-webhook
     Token: o mesmo valor do secret ASAAS_WEBHOOK_TOKEN (header asaas-access-token)
     Eventos: cobranças (PAYMENT_*) e assinaturas (SUBSCRIPTION_*)
   Payload: { id, event, payment: { id, subscription, value, billingType,
              externalReference: "<tenant>|<plano>|<ciclo>", ... } }
   Mapeamento de tenant: externalReference (gravado no checkout) → fallback
   pela assinatura (tenants.stripe_subscription_id, coluna reaproveitada).
   ============================================================================ */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METODO: Record<string, string> = { PIX: "pix", CREDIT_CARD: "cartao", BOLETO: "boleto", DEBIT_CARD: "debito" };

async function handleAsaas(req: Request, raw: string): Promise<Response> {
  const expected = Deno.env.get("ASAAS_WEBHOOK_TOKEN") || "";
  const got = req.headers.get("asaas-access-token") || "";
  // sem token configurado = recusa (antes: "" === "" aceitava qualquer requisição)
  if (!expected || !safeEqualHex(got, expected)) return new Response("token inválido", { status: 401 });

  let ev: { id?: string; event?: string; payment?: Record<string, any>; subscription?: Record<string, any> };
  try { ev = JSON.parse(raw); } catch (_e) { return new Response("json inválido", { status: 400 }); }
  const type = String(ev.event || "");
  const pay = ev.payment || {};
  const subObj = ev.subscription || {};
  const eventId = `asaas:${ev.id || `${type}:${pay.id || subObj.id || crypto.randomUUID()}`}`;

  // idempotência: grava o evento antes; se o processamento falhar, apaga para o Asaas reenviar
  if (await alreadyProcessed(eventId, `asaas:${type}`, ev)) return new Response("duplicado ignorado", { status: 200 });
  const undo = () => sr(`/rest/v1/webhook_events?provider_event_id=eq.${encodeURIComponent(eventId)}`, { method: "DELETE" });

  try {
    const ref = String(pay.externalReference || subObj.externalReference || "");
    const [refTenant, refPlan, refCycle] = ref.split("|");
    const subId = String(pay.subscription || subObj.id || "");
    let tenantId = UUID_RE.test(refTenant || "") ? refTenant : null;
    if (!tenantId && subId) tenantId = await tenantBySubscription(subId);
    if (!tenantId) return new Response("tenant não mapeado (registrado)", { status: 200 });

    const tq = await sr(`/rest/v1/tenants?select=status,plan_id,plan_cycle,plan_expires_at,stripe_subscription_id&id=eq.${tenantId}`);
    const t = ((await tq.json()) as Array<Record<string, string | null>>)[0];
    if (!t) return new Response("tenant inexistente (registrado)", { status: 200 });
    if (t.plan_id === "dev") return new Response("conta dev ignorada", { status: 200 });
    // evento de uma assinatura antiga (já trocada) não mexe no status atual
    const isCurrentSub = !subId || !t.stripe_subscription_id || t.stripe_subscription_id === subId;

    const planId = refPlan || t.plan_id || "profissional";
    const cycle = refCycle === "anual" ? "anual" : (refCycle === "mensal" ? "mensal" : (t.plan_cycle || "mensal"));
    const audit = (acao: string, detalhes: string) => sr("/rest/v1/audit_logs", {
      method: "POST",
      body: JSON.stringify({ tenant_id: tenantId, user_name: "Asaas", acao, entidade: "tenant", entidade_id: tenantId, detalhes, origem: "webhook" }),
    });
    const upsertInvoice = (status: string, extra: Record<string, unknown> = {}) =>
      sr("/rest/v1/invoices?on_conflict=provider_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          tenant_id: tenantId, provider: "asaas", provider_id: String(pay.id), plan_id: planId, cycle,
          valor: Number(pay.value || 0), status, metodo: METODO[String(pay.billingType)] || "pix", ...extra,
        }),
      });

    switch (type) {
      case "PAYMENT_CREATED":
        if (pay.id) await upsertInvoice("pendente");
        break;
      case "PAYMENT_CONFIRMED":
      case "PAYMENT_RECEIVED": {
        if (pay.id) await upsertInvoice("pago", { paid_at: new Date().toISOString() });
        if (!isCurrentSub) break;
        // Vencimento = vencimento DESTA fatura + 1 ciclo de calendário + carência.
        // (v1.9.2: antes somava 30 dias corridos — em mês de 31 dias o plano vencia
        //  1 dia ANTES da próxima fatura e o cron suspendia cliente em dia.)
        // Determinístico por fatura → CONFIRMED + RECEIVED do mesmo pagamento não dobram.
        const due = pay.dueDate ? new Date(`${pay.dueDate}T12:00:00-03:00`) : new Date();
        const next = new Date(Math.max(due.getTime(), Date.now() - 45 * 864e5)); // dueDate absurda/antiga não reduz
        if (cycle === "anual") next.setUTCFullYear(next.getUTCFullYear() + 1);
        else next.setUTCMonth(next.getUTCMonth() + 1);
        const cur = t.plan_expires_at ? new Date(t.plan_expires_at).getTime() : 0;
        const exp = new Date(Math.max(next.getTime() + graceDays * 864e5, cur)).toISOString();
        const upd = await sr(`/rest/v1/tenants?id=eq.${tenantId}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: "active", plan_id: planId, plan_cycle: cycle, scheduled_plan: null,
            plan_expires_at: exp, next_charge_at: exp, started_at: t.status === "active" ? undefined : new Date().toISOString(),
            canceled_at: null, cancel_reason: null, trial_pending: false,
            plan_activated_at: new Date().toISOString(), plan_activation_reason: `Asaas ${pay.id}`,
          }),
        });
        if (!upd.ok) throw new Error(`PATCH tenant ${upd.status}: ${await upd.text()}`);
        await audit("assinatura.paga", `plano ${planId} (${cycle}) até ${exp} · R$ ${pay.value} · ${pay.billingType}`);
        // recibo por e-mail (Resend via public.send_email; sem chave no Vault → log "skipped_no_key")
        try {
          const aq = await sr(`/rest/v1/users?select=email,nome&tenant_id=eq.${tenantId}&papel=eq.admin&ativo=eq.true&limit=1`);
          const adm = ((await aq.json()) as Array<{ email: string; nome: string }>)[0];
          if (adm?.email) {
            const fim = new Date(exp).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
            const valor = Number(pay.value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
            const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
            await sr("/rest/v1/rpc/send_email", {
              method: "POST",
              body: JSON.stringify({
                p_to: adm.email, p_tenant: tenantId, p_template: "pagamento_confirmado",
                p_subject: `Pagamento confirmado — LojaCerta ${planId}`,
                p_html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#0f172a"><h2 style="color:#c2410c">Pagamento confirmado ✅</h2><p>Olá, ${esc(adm.nome || "")}!</p><p>Recebemos <b>${valor}</b> referente ao plano <b>${esc(planId)}</b> (${cycle}). Seu acesso está liberado até <b>${fim}</b>.</p><p style="color:#64748b;font-size:13px">LojaCerta · JR Sistemas e Tecnologia</p></div>`,
              }),
            });
          }
        } catch (_e) { /* e-mail é best-effort: não reprocessa o pagamento */ }
        break;
      }
      case "PAYMENT_OVERDUE":
        if (pay.id) await upsertInvoice("falhou");
        if (isCurrentSub && t.status === "active") {
          await setTenantStatus(tenantId, "past_due", { next_charge_at: new Date(Date.now() + graceDays * 864e5).toISOString() });
          await audit("assinatura.atrasada", `fatura ${pay.id} vencida — carência de ${graceDays} dias`);
        }
        break;
      case "PAYMENT_REFUNDED":
      case "PAYMENT_CHARGEBACK_REQUESTED":
      case "PAYMENT_DELETED":
        if (pay.id) await upsertInvoice(type === "PAYMENT_DELETED" ? "cancelado" : "refundado");
        if (isCurrentSub && type !== "PAYMENT_DELETED") {
          await setTenantStatus(tenantId, "read_only");
          await audit("assinatura.estornada", `${type} · fatura ${pay.id}`);
        }
        break;
      case "SUBSCRIPTION_DELETED":
      case "SUBSCRIPTION_INACTIVATED":
        // só registra: o acesso segue até plan_expires_at (o pg_cron suspende ao vencer)
        if (isCurrentSub) await audit("assinatura.encerrada", `${type} · ${subId}`);
        break;
      default:
        break; // demais eventos: registrados em webhook_events, sem efeito
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("asaas webhook", (e as Error).message);
    await undo();
    return new Response("erro ao processar — reenvie", { status: 500 });
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });
  const raw = await req.text();
  const provider = (req.headers.get("x-provider") || (req.headers.has("asaas-access-token") ? "asaas" : "stripe")).toLowerCase();
  let event: { id: string; type: string; data: { object: any } };

  if (provider === "stripe") {
    /* Verificação de assinatura Stripe (formato: t=...,v1=...) */
    if (!stripeSecret) return new Response("assinatura inválida", { status: 400 });
    const sig = req.headers.get("stripe-signature") || "";
    const parts = Object.fromEntries(sig.split(",").map((s) => s.split("=")));
    if (!parts.t || !parts.v1) return new Response("assinatura inválida", { status: 400 });
    const hex = await hmacHex(stripeSecret, `${parts.t}.${raw}`);
    if (!safeEqualHex(hex, parts.v1)) return new Response("assinatura inválida", { status: 400 });
    event = JSON.parse(raw);
  } else if (provider === "infinitepay") {
    /* STUB (Onda 6b) — contrato: validar HMAC (se secret configurada), registrar
       em webhook_events (idempotente), responder 200 SEM processar. */
    const secret = Deno.env.get("INFINITEPAY_WEBHOOK_SECRET") || "";
    const sig = req.headers.get("x-signature") || req.headers.get("x-webhook-signature") || "";
    let signed = "sem_secret";
    if (secret) {
      const hex = await hmacHex(secret, raw);
      if (!safeEqualHex(hex, sig.toLowerCase())) return new Response("assinatura inválida", { status: 400 });
      signed = "hmac_ok";
    }
    let evt: { id?: string; type?: string; event?: string } = {};
    try { evt = JSON.parse(raw); } catch (_e) { /* corpo não-JSON: registra como está */ }
    const r = await sr("/rest/v1/webhook_events", {
      method: "POST",
      body: JSON.stringify({
        provider_event_id: String(evt.id || crypto.randomUUID()),
        tipo: `infinitepay:${String(evt.type || evt.event || "desconhecido")} · ${signed}`,
        payload: { raw: raw.slice(0, 8000), stub: true, nota: "validado e registrado; processamento na integração real" },
      }),
    });
    if (!r.ok) return new Response("duplicado ignorado", { status: 200 });
    return new Response("stub: validado e registrado (processamento na integração real)", { status: 200 });
  } else if (provider === "asaas" || req.headers.has("asaas-access-token")) {
    return handleAsaas(req, raw);
  } else {
    return new Response("provedor desconhecido", { status: 400 });
  }

  if (await alreadyProcessed(event.id, event.type, event.data.object)) {
    return new Response("duplicado ignorado", { status: 200 });
  }

  const obj = event.data.object || {};
  const subId = obj.subscription || obj.subscriptionId || obj.id;
  const tenantId = await tenantBySubscription(subId);
  if (!tenantId) return new Response("tenant não mapeado", { status: 200 });

  switch (event.type) {
    case "checkout.session.completed":
    case "customer.subscription.created":
    case "CREATE_SUBSCRIPTION": // asaas
      await setTenantStatus(tenantId, "active", {
        started_at: new Date().toISOString(),
        next_charge_at: new Date(Date.now() + 30 * 864e5).toISOString(),
        stripe_subscription_id: subId,
        stripe_customer_id: obj.customer || obj.customerId || null,
      });
      await sr("/rest/v1/invoices", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: tenantId, provider, provider_id: obj.id, plan_id: obj.metadata?.plan_id || "profissional",
          cycle: obj.metadata?.cycle || "mensal", valor: (obj.amount_total ?? obj.value ?? 0) / (provider === "stripe" ? 100 : 1),
          status: "pago", metodo: obj.metadata?.metodo || "pix", paid_at: new Date().toISOString(),
        }),
      });
      break;

    case "invoice.paid":
    case "PAYMENT_RECEIVED": // asaas
      await sr("/rest/v1/tenants?id=eq." + tenantId, {
        method: "PATCH",
        body: JSON.stringify({ status: "active", next_charge_at: new Date(Date.now() + 30 * 864e5).toISOString() }),
      });
      await sr(`/rest/v1/invoices?provider_id=eq.${obj.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "pago", paid_at: new Date().toISOString() }),
      });
      break;

    case "invoice.payment_failed":
    case "PAYMENT_OVERDUE": // asaas
      await sr(`/rest/v1/invoices?provider_id=eq.${obj.id}`, { method: "PATCH", body: JSON.stringify({ status: "falhou" }) });
      // carência: agende o bloqueio (pg_cron ou retry do gateway); simplificado aqui:
      await setTenantStatus(tenantId, "past_due", {
        next_charge_at: new Date(Date.now() + graceDays * 864e5).toISOString(),
      });
      break;

    case "customer.subscription.deleted":
    case "DELETE_SUBSCRIPTION": // asaas
      await setTenantStatus(tenantId, "read_only", { canceled_at: new Date().toISOString() });
      break;
  }
  return new Response("ok", { status: 200 });
});
