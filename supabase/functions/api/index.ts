// LojaCerta · Edge Function "api" (Deno/Supabase — sem imports externos)
// Backend das operações que exigem service role. Contrato: POST { op, payload }.
// Respostas: JSON ou { code, message } (mapeado como ApiError no client).
//
// Ops:
//   ping                 → health check
//   auth.signup          → cadastro público com guarda anti-abuso: registra IP +
//                          identificador do navegador, valida o limite de testes
//                          grátis por IP/dispositivo (RPC signup_begin) e só então
//                          cria a conta no Supabase Auth (o e-mail de confirmação
//                          segue pelo fluxo nativo do GoTrue)
//   users.invite         → convite de usuário para o tenant (admin) com e-mail do Supabase
//   users.invites        → lista convites pendentes do tenant (admin)
//   users.uninvite       → revoga convite pendente (admin)
//   billing.cancel       → cancelamento de assinatura pelo admin da loja (read_only)
//   billing.tenant_info  → retrato de billing de uma empresa (somente dev)
//   billing.activate_plan→ ativa/estende plano COM PRAZO para uma empresa (somente
//                          dev; payload { tenantId, planId, cycle, days, expiresAt,
//                          reason, extend } — o servidor recalcula e valida o prazo;
//                          exige header x-dev-pin quando o secret DEV_PIN estiver
//                          definido — 2º fator leve para escrita de cobrança;
//                          v1.7.2: PIN < 12 chars é recusado (DEV_PIN_INSECURE),
//                          5 tentativas erradas em 15 min (por ator E por IP)
//                          travam por 15 min (PIN_LOCKED 429) e toda tentativa
//                          errada gera rastro em pin_attempts + audit_logs
//   billing.suspend_tenant→ suspende acesso de uma empresa (somente dev; idem PIN)
//   account.request_deletion → pedido LGPD de exclusão (usuário autenticado)
//   cron.purge_deletions     → sweeper de exclusões vencidas (segredo compartilhado)
//
// Segurança: toda op autenticada valida o papel do chamador contra o banco
// (service role) e escopa por tenant. auth.signup é anônimo por natureza e
// se protege pela guarda no banco (triggers + RPCs). Nenhum segredo é
// exposto ao cliente.

const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
/* Limites do teste grátis — ajustáveis sem tocar em código:
   supabase secrets set TRIAL_LIMIT_PER_IP=2 TRIAL_LIMIT_PER_DEVICE=2 */
const TRIAL_LIMIT_PER_IP = Number(Deno.env.get("TRIAL_LIMIT_PER_IP") || 1);
const TRIAL_LIMIT_PER_DEVICE = Number(Deno.env.get("TRIAL_LIMIT_PER_DEVICE") || 1);

/* CORS: o novo runtime não adiciona cabeçalhos automaticamente — sem isso
   o navegador bloqueia a chamada (preflight OPTIONS sem Access-Control-Allow-Origin).
   v1.7.2: x-dev-pin entra na allowlist — sem ele o preflight rejeita o header
   e o navegador aborta o POST com "Failed to fetch" (o fluxo de PIN no browser
   estava quebrado na v1.7.1; o E2E de re-validação pegou o bug). */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-dev-pin, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body ?? { ok: true }), { status, headers: { "Content-Type": "application/json", ...CORS } });
const fail = (code: string, message: string, status = 400) => json({ code, message }, status);

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

async function caller(req: Request) {
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!token || token === "undefined") return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json();
  if (!user || !user.id) return null;
  const q = await sr(
    `/rest/v1/users?select=id,tenant_id,nome,papel,ativo,tenant:tenants!users_tenant_id_fkey(id,nome)&id=eq.${user.id}`
  );
  const rows = await q.json();
  const me = Array.isArray(rows) && rows[0];
  if (!me || !me.ativo) return null;
  me.email = user.email || null;
  return me;
}

/* ---------------- Asaas (cobrança) ----------------
   Secrets: ASAAS_API_KEY (obrigatória p/ checkout) · ASAAS_ENV=production|sandbox
   (padrão sandbox — produção só com ASAAS_ENV=production explícito).
   Preços SEMPRE do servidor (nunca confiar no valor enviado pelo navegador). */
const ASAAS_KEY = Deno.env.get("ASAAS_API_KEY") || "";
const ASAAS_BASE = (Deno.env.get("ASAAS_ENV") || "sandbox") === "production"
  ? "https://api.asaas.com/v3"
  : "https://api-sandbox.asaas.com/v3";
const PLAN_PRICES: Record<string, { nome: string; mensal: number; anual: number }> = {
  essencial: { nome: "Essencial", mensal: 59, anual: 588 },
  profissional: { nome: "Profissional", mensal: 129, anual: 1284 },
  premium: { nome: "Premium", mensal: 249, anual: 2484 },
};
const BILLING_TYPE: Record<string, string> = { pix: "PIX", cartao: "CREDIT_CARD", boleto: "BOLETO" };
async function asaas(path: string, init: RequestInit = {}) {
  const r = await fetch(`${ASAAS_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "User-Agent": "LojaCerta", access_token: ASAAS_KEY, ...(init.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (body?.errors?.[0]?.description as string) || `Asaas HTTP ${r.status}`;
    throw new Error(msg);
  }
  return body;
}

/* IP real do cliente: preferimos o cabeçalho do CDN/gateway; o x-forwarded-for
   pode vir com vários saltos — usamos o ÚLTIMO (adicionado pelo proxy confiável,
   não o primeiro, que pode ser forjado pelo próprio cliente). Sem IP conhecido
   → "desconhecido" (a regra por IP é ignorada; a camada do dispositivo segue). */
function clientIp(req: Request): string {
  const direct = (req.headers.get("cf-connecting-ip") || "").trim();
  if (direct) return direct;
  const xff = (req.headers.get("x-forwarded-for") || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const ip = xff[xff.length - 1] || "";
  return ip.replace(/^::ffff:/, "") || "desconhecido";
}

/* Erros do GoTrue → códigos/mensagens amigáveis (mesmo mapa do front).
   Nota: o GoTrue pode devolver {code:429, error_code:"over_email_send_rate_limit",
   msg:"email rate limit exceeded"} — error_code tem prioridade sobre o code
   numérico, e a mensagem pode vir em "msg" (não só em "message"). */
function mapGoTrueError(j: { code?: string | number; error_code?: string; msg?: string; error_description?: string; message?: string }): { code: string; message: string } {
  const code = String(j.error_code || j.code || "");
  const msg = String(j.error_description || j.msg || j.message || "");
  if (code === "user_already_exists" || code === "email_exists" || /already (been )?registered|already exists/i.test(msg))
    return { code: "EMAIL_EXISTS", message: "Já existe uma conta com este e-mail. Tente entrar ou recuperar a senha." };
  if (code === "weak_password" || /password should be at least/i.test(msg))
    return { code: "WEAK_PASSWORD", message: "Senha fraca: use no mínimo 8 caracteres, com maiúscula, minúscula e número." };
  if (code === "over_email_send_rate_limit" || /email rate limit/i.test(msg))
    return { code: "EMAIL_SEND", message: "Não conseguimos enviar o e-mail agora — o provedor de e-mail do Supabase atingiu o limite do plano (2–4 e-mails/hora sem SMTP próprio). Tente novamente em alguns minutos ou fale com o suporte." };
  if (/too many requests/i.test(msg))
    return { code: "RATE_LIMITED", message: "Muitas tentativas em pouco tempo. Aguarde alguns minutos." };
  if (/invalid request payload|validation/i.test(msg))
    return { code: "VALIDATION", message: "Dados inválidos no cadastro." };
  return { code: "AUTH", message: msg || "Falha ao criar a conta. Tente novamente." };
}

/* ---------- auth.signup: cadastro público com guarda anti-abuso ---------- */
async function signupHandler(p: Record<string, unknown>, req: Request) {
  if (!ANON_KEY) return fail("NOT_CONFIGURED", "Função sem SUPABASE_ANON_KEY configurada.");
  const email = String(p.email || "").trim().toLowerCase();
  const password = String(p.password || "");
  const nome = String(p.name || "").trim();
  const loja = String(p.storeName || "").trim();
  const segmento = String(p.segment || "outro").trim().toLowerCase();
  const deviceId = String(p.deviceId || "").trim().slice(0, 64);
  const ip = clientIp(req);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail("INVALID_EMAIL", "Informe um e-mail válido.");
  if (password.length < 8) return fail("WEAK_PASSWORD", "Senha fraca: use no mínimo 8 caracteres, com maiúscula, minúscula e número.");
  if (nome.length < 2 || loja.length < 2) return fail("VALIDATION", "Informe seu nome e o nome da loja.");

  /* 1) Guarda no banco: registra a intenção com IP/dispositivo e valida os
        limites de teste grátis — atomicamente (advisory locks no RPC). */
  const begin = await sr("/rest/v1/rpc/signup_begin", {
    method: "POST",
    body: JSON.stringify({
      p_email: email, p_ip: ip, p_device: deviceId, p_trial: true,
      p_ip_limit: TRIAL_LIMIT_PER_IP, p_device_limit: TRIAL_LIMIT_PER_DEVICE,
    }),
  });
  if (!begin.ok) {
    const err = await begin.json().catch(() => ({} as { message?: string; code?: string }));
    const raw = String(err.message || err.code || "");
    if (/TRIAL_IP_LIMIT|TRIAL_DEVICE_LIMIT/.test(raw)) {
      return fail("TRIAL_LIMIT",
        "Já existe uma conta usando o teste grátis a partir desta rede (IP) ou deste navegador. " +
        "Para criar outra conta, é necessário contratar o plano pago. " +
        "Se for um caso legítimo (ex.: outra empresa na mesma internet), fale com o suporte.", 403);
    }
    if (/EMAIL_EXISTS/.test(raw))
      return fail("EMAIL_EXISTS", "Já existe uma conta com este e-mail. Tente entrar ou recuperar a senha.", 409);
    if (/PGRST202|does not exist|42883/.test(raw))
      return fail("SIGNUP_BACKEND_MISSING", "Migração v5 ainda não aplicada neste banco.");
    return fail("SERVICE", "Não foi possível validar o cadastro agora. Tente novamente em instantes.");
  }

  /* 2) Cria a conta no Supabase Auth (fluxo nativo — a confirmação por e-mail
        com código de 6 dígitos é enviada pelo GoTrue; a trigger do banco consome
        a intenção e cria o tenant com trial PENDENTE). */
  const su = await fetch(`${SB_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify({ email, password, data: { nome, loja, segmento } }),
  });
  if (!su.ok) {
    /* 3) Cadastro não aconteceu → devolve a vaga do teste (compensação). */
    await sr("/rest/v1/rpc/signup_abort", { method: "POST", body: JSON.stringify({ p_email: email, p_ip: ip }) });
    const err = await su.json().catch(() => ({}));
    const mapped = mapGoTrueError(err);
    return fail(mapped.code, mapped.message, 400);
  }
  const j = await su.json().catch(() => ({} as { access_token?: string }));
  /* autoconfirm desligado → sem sessão: o cliente segue para a tela de código. */
  return json({ needsConfirmation: !j.access_token });
}

const SITE_URL = "https://jrsistemasetecnologiabr-bit.github.io/Projeto-empresa";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: CORS });
  if (req.method !== "POST") return json({ ok: true });
  let body: { op?: string; payload?: Record<string, unknown> } = {};
  try {
    body = await req.json();
  } catch (_e) {
    return fail("VALIDATION", "Corpo da requisição inválido.");
  }
  const op = body.op || "";
  const p = body.payload || {};

  if (op === "ping") return json({ ok: true, pong: true });

  /* Cadastro é anônimo por natureza — tratado ANTES da checagem de sessão. */
  if (op === "auth.signup") return signupHandler(p, req);

  /* ---------- cron: executa exclusões LGPD vencidas (carência 30d) ----------
     Protegido por segredo compartilhado (env PURGE_SECRET = GitHub Secret).
     Chamado pelo workflow keep-alive-supabase a cada 6h. */
  if (op === "cron.purge_deletions") {
    const secret = Deno.env.get("PURGE_SECRET") || "";
    const given = req.headers.get("x-cron-secret") || "";
    if (!secret || given.length !== secret.length || given !== secret) return fail("FORBIDDEN", "Não autorizado.", 403);
    const since = new Date().toISOString();
    const q = await sr(
      `/rest/v1/account_deletion_requests?select=id,tenant_id,user_id&executed_at=is.null&cancelado=eq.false&grace_until=lt.${since}&limit=50`
    );
    const rows = (await q.json()) as Array<{ id: string; tenant_id: string; user_id: string | null }>;
    let purged = 0;
    for (const r of rows) {
      await sr(`/rest/v1/account_deletion_requests?id=eq.${r.id}`, {
        method: "PATCH",
        body: JSON.stringify({ executed_at: new Date().toISOString() }),
      });
      // cascade: produtos, vendas, estoque, tickets, convites, usuários da loja…
      const del = await sr(`/rest/v1/tenants?id=eq.${r.tenant_id}`, { method: "DELETE" });
      // LGPD: o login (auth.users) também deixa de existir
      if (r.user_id) {
        await fetch(`${SB_URL}/auth/v1/admin/users/${r.user_id}`, {
          method: "DELETE",
          headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        }).catch(() => {});
      }
      if (del.ok) purged++;
    }
    return json({ ok: true, purged, checked: rows.length });
  }

  const me = await caller(req);
  if (!me) return fail("FORBIDDEN", "Sessão inválida ou usuário inativo.", 403);
  const isAdminRole = me.papel === "admin" || me.papel === "dev";

  /* Escrita de cobrança exige 2º fator leve: o header x-dev-pin deve casar com
     o secret DEV_PIN (`supabase secrets set` com a chave `DEV_PIN`). Sem o secret
     configurado, a operação segue só com senha (retrocompatível).
     Endurecimento v1.7.2 (revisão externa — PIN exposto em conversa):
     · política de comprimento: PIN configurado com < 12 caracteres é RECUSADO
       (um PIN de 8 chars alfanuméricos é brute-forçável em minutos);
     · rate limit + lockout: 5 tentativas erradas em 15 min (contadas por
       ator_id E por IP — quem atinge o limite fica travado por 15 min, 429);
     · rastro: toda tentativa vira linha em pin_attempts (certa ou errada) e
       tentativa errada/bloqueio gera audit_logs (visível na tela Ações do
       admin). Acertar o PIN zera o contador do ator (reset amigável). */
  const PIN_MAX_FAILS = 5;
  const PIN_WINDOW_MS = 15 * 60 * 1000;
  const PIN_MIN_LEN = 12;

  async function checkDevPin(
    me: { id: string; tenant_id: string; nome: string },
    req: Request,
  ): Promise<{ ok: true } | { ok: false; resp: Response }> {
    const pin = Deno.env.get("DEV_PIN") || "";
    if (!pin) return { ok: true };
    if (pin.length < PIN_MIN_LEN) {
      return {
        ok: false,
        resp: fail("DEV_PIN_INSECURE",
          `O PIN configurado é curto demais (mínimo ${PIN_MIN_LEN} caracteres). Redefina a secret DEV_PIN no painel do Supabase (Edge Function Secrets).`, 500),
      };
    }

    const ip = clientIp(req);
    const since = new Date(Date.now() - PIN_WINDOW_MS).toISOString();
    /* falhas recentes do MESMO ator OU do mesmo IP (janela deslizante de 15 min) */
    const q = await sr(
      `/rest/v1/pin_attempts?select=id&ok=eq.false&created_at=gte.${since}` +
        `&or=(actor_id.eq.${me.id},ip.eq.${encodeURIComponent(ip)})`,
    );
    const rows = (await q.json()) as unknown[];
    const fails = Array.isArray(rows) ? rows.length : 0;

    if (fails >= PIN_MAX_FAILS) {
      await sr("/rest/v1/pin_attempts", {
        method: "POST",
        body: JSON.stringify({ actor_id: me.id, actor_name: me.nome, ip, ok: false }),
      });
      await sr("/rest/v1/audit_logs", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: me.tenant_id, user_id: me.id, user_name: me.nome,
          acao: "pin.bloqueado", entidade: "billing", entidade_id: String(me.id),
          detalhes: `lockout: ${fails}+ tentativas incorretas na janela de 15 min · IP ${ip}`,
          ip, origem: "edge",
        }),
      });
      return {
        ok: false,
        resp: fail("PIN_LOCKED",
          "Muitas tentativas incorretas — o acesso de cobrança fica bloqueado por 15 minutos por segurança.", 429),
      };
    }

    const given = req.headers.get("x-dev-pin") || "";
    const ok = given === pin;
    await sr("/rest/v1/pin_attempts", {
      method: "POST",
      body: JSON.stringify({ actor_id: me.id, actor_name: me.nome, ip, ok }),
    });

    if (!ok) {
      await sr("/rest/v1/audit_logs", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: me.tenant_id, user_id: me.id, user_name: me.nome,
          acao: "pin.tentativa_falha", entidade: "billing", entidade_id: String(me.id),
          detalhes: `PIN incorreto (${fails + 1}/${PIN_MAX_FAILS}) · IP ${ip}`,
          ip, origem: "edge",
        }),
      });
      return {
        ok: false,
        resp: fail("DEV_PIN_REQUIRED",
          `PIN incorreto (tentativa ${fails + 1} de ${PIN_MAX_FAILS}). Após ${PIN_MAX_FAILS} erradas, o acesso de cobrança fica bloqueado por 15 minutos.`,
          403),
      };
    }

    /* acertou: zera as falhas do ator — o PIN certo prova posse do fator */
    await sr(`/rest/v1/pin_attempts?actor_id=eq.${me.id}&ok=eq.false`, { method: "DELETE" });
    return { ok: true };
  }

  switch (op) {
    /* ---------- convites de equipe (admin do tenant) ---------- */
    case "users.invite": {
      if (!isAdminRole) return fail("FORBIDDEN", "Somente administradores convidam usuários.", 403);
      const nome = String(p.nome || "").trim();
      const email = String(p.email || "").trim().toLowerCase();
      const papel = ["admin", "gerente", "caixa"].includes(String(p.papel)) ? String(p.papel) : "caixa";
      if (nome.length < 2) return fail("VALIDATION", "Informe o nome do usuário.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail("INVALID_EMAIL", "E-mail inválido.");
      // já existe na equipe?
      const eq = await sr(`/rest/v1/users?select=id&tenant_id=eq.${me.tenant_id}&email=eq.${encodeURIComponent(email)}`);
      if ((await eq.json()).length) return fail("EMAIL_EXISTS", "Este e-mail já pertence à sua equipe.");
      // convite já pendente?
      const pend = await sr(
        `/rest/v1/user_invites?select=id&tenant_id=eq.${me.tenant_id}&email=eq.${encodeURIComponent(email)}&accepted_at=is.null&revoked_at=is.null`
      );
      if ((await pend.json()).length) return fail("EMAIL_EXISTS", "Já existe um convite pendente para este e-mail.");

      // cria o convite (token aleatório) — a trigger on_auth_user_created consome
      const token = crypto.randomUUID();
      const ins = await sr("/rest/v1/user_invites", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: me.tenant_id, email, nome, papel, token,
          invited_by: me.id, expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
        }),
      });
      if (!ins.ok) return fail("VALIDATION", "Não foi possível registrar o convite.");

      // envia o e-mail de convite (template tematizado no Auth)
      const inv = await fetch(`${SB_URL}/auth/v1/admin/invite_user_by_email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({
          email,
          data: { nome, loja: me.tenant?.nome || "", invite_token: token, papel },
          redirect_to: `${SITE_URL}/#/entrar`,
        }),
      });
      if (!inv.ok) {
        const err = await inv.json().catch(() => ({}));
        const code = (err as { code?: string }).code || "";
        if (code === "user_already_exists" || code === "email_exists") {
          return fail("EMAIL_EXISTS", "Já existe uma conta LojaCerta com este e-mail. Peça para a pessoa entrar e usar a opção de suporte.");
        }
        if (code === "over_email_send_rate_limit") {
          return fail("RATE_LIMITED", "Limite de envios de e-mail atingido. Tente novamente em alguns minutos ou configure um provedor SMTP.");
        }
        return fail("SERVICE", "Convite registrado, mas o e-mail não pôde ser enviado agora. Tente novamente em instantes.");
      }
      return json({ ok: true });
    }

    case "users.invites": {
      if (!isAdminRole) return fail("FORBIDDEN", "Somente administradores.", 403);
      const q = await sr(
        `/rest/v1/user_invites?select=id,email,nome,papel,created_at,expires_at,accepted_at,revoked_at&tenant_id=eq.${me.tenant_id}&accepted_at=is.null&revoked_at=is.null&order=created_at.desc`
      );
      return json(await q.json());
    }

    case "users.uninvite": {
      if (!isAdminRole) return fail("FORBIDDEN", "Somente administradores.", 403);
      const id = String(p.id || "");
      if (!id) return fail("VALIDATION", "Convite inválido.");
      const upd = await sr(
        `/rest/v1/user_invites?id=eq.${id}&tenant_id=eq.${me.tenant_id}&accepted_at=is.null`,
        { method: "PATCH", body: JSON.stringify({ revoked_at: new Date().toISOString() }) }
      );
      if (!upd.ok) return fail("NOT_FOUND", "Convite não encontrado ou já utilizado.");
      return json({ ok: true });
    }

    /* ---------- LGPD: pedido de exclusão da conta (carência 30 dias) ---------- */
    case "account.request_deletion": {
      if (!isAdminRole) return fail("FORBIDDEN", "Somente o administrador da loja solicita a exclusão da conta.", 403);
      // já existe pedido pendente (não executado e não cancelado)?
      const pend = await sr(
        `/rest/v1/account_deletion_requests?select=id,grace_until&tenant_id=eq.${me.tenant_id}&executed_at=is.null&cancelado=eq.false&order=requested_at.desc&limit=1`
      );
      const pendRows = (await pend.json()) as Array<{ grace_until: string }>;
      if (pendRows.length) {
        return fail("VALIDATION", `Já existe um pedido de exclusão pendente (carência até ${new Date(pendRows[0].grace_until).toLocaleDateString("pt-BR")}). Fale com o suporte para reverter.`);
      }
      const grace = new Date(Date.now() + 30 * 864e5).toISOString();
      const ins = await sr("/rest/v1/account_deletion_requests", {
        method: "POST",
        body: JSON.stringify({ tenant_id: me.tenant_id, user_id: me.id, grace_until: grace }),
      });
      if (!ins.ok) return fail("SERVICE", "Não foi possível registrar o pedido de exclusão agora. Tente novamente.");
      await sr("/rest/v1/audit_logs", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: me.tenant_id, user_id: me.id, user_name: me.nome,
          acao: "conta.exclusao_solicitada", entidade: "tenant", entidade_id: String(me.tenant_id),
          detalhes: "carência de 30 dias (LGPD) — reversível pelo suporte",
          ip: clientIp(req), origem: "edge",
        }),
      });
      return json({ ok: true, graceUntil: grace });
    }

    /* ---------- BILLING: checkout Asaas (admin da loja) ----------
       Cria/reaproveita o cliente no Asaas, (re)cria a assinatura com
       externalReference = "<tenant>|<plano>|<ciclo>" e devolve a URL da
       1ª fatura. A ativação acontece SÓ no webhook (pagamento confirmado). */
    case "billing.checkout": {
      if (me.papel !== "admin") return fail("FORBIDDEN", "Somente o administrador da loja assina um plano.", 403);
      if (!ASAAS_KEY) {
        return fail("NOT_CONFIGURED",
          "Pagamento online ainda não habilitado. Para ativar hoje: pague via Pix e peça a ativação pelo Suporte — a equipe JR ativa em minutos.", 503);
      }
      const planId = String(p.planId || "");
      const cycle = p.cycle === "anual" ? "anual" : "mensal";
      const plan = PLAN_PRICES[planId];
      if (!plan) return fail("VALIDATION", "Plano inválido.");
      const billingType = BILLING_TYPE[String(p.method || "pix")] || "UNDEFINED";
      const tq = await sr(`/rest/v1/tenants?select=id,nome,cnpj,telefone,stripe_customer_id,stripe_subscription_id&id=eq.${me.tenant_id}`);
      const t = ((await tq.json()) as Array<Record<string, string | null>>)[0];
      if (!t) return fail("NOT_FOUND", "Empresa não encontrada.", 404);
      const doc = String(t.cnpj || p.cpfCnpj || "").replace(/\D/g, "");
      if (doc.length !== 11 && doc.length !== 14) {
        return fail("CPF_CNPJ_REQUIRED", "Informe o CNPJ (ou CPF) da loja em Configurações → Loja antes de assinar — é exigido para emitir a cobrança.");
      }
      try {
        let customerId = t.stripe_customer_id && String(t.stripe_customer_id).startsWith("cus_") ? String(t.stripe_customer_id) : "";
        if (!customerId) {
          const c = await asaas("/customers", {
            method: "POST",
            body: JSON.stringify({
              name: t.nome, cpfCnpj: doc, email: me.email || undefined,
              mobilePhone: String(t.telefone || "").replace(/\D/g, "") || undefined,
              externalReference: me.tenant_id, notificationDisabled: false,
            }),
          });
          customerId = c.id;
        }
        /* troca de plano: encerra a assinatura anterior (sem estornar o já pago) */
        if (t.stripe_subscription_id && String(t.stripe_subscription_id).startsWith("sub_")) {
          await asaas(`/subscriptions/${t.stripe_subscription_id}`, { method: "DELETE" }).catch(() => null);
        }
        const valor = cycle === "anual" ? plan.anual : plan.mensal;
        const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // data em America/Sao_Paulo
        const sub = await asaas("/subscriptions", {
          method: "POST",
          body: JSON.stringify({
            customer: customerId, billingType, value: valor, nextDueDate: hoje,
            cycle: cycle === "anual" ? "YEARLY" : "MONTHLY",
            description: `LojaCerta · Plano ${plan.nome} (${cycle})`,
            externalReference: `${me.tenant_id}|${planId}|${cycle}`,
          }),
        });
        await sr(`/rest/v1/tenants?id=eq.${me.tenant_id}`, {
          method: "PATCH",
          body: JSON.stringify({ stripe_customer_id: customerId, stripe_subscription_id: sub.id, scheduled_plan: planId }),
        });
        const pays = await asaas(`/subscriptions/${sub.id}/payments?limit=1`);
        const first = pays?.data?.[0];
        await sr("/rest/v1/audit_logs", {
          method: "POST",
          body: JSON.stringify({
            tenant_id: me.tenant_id, user_id: me.id, user_name: me.nome,
            acao: "assinatura.checkout", entidade: "tenant", entidade_id: String(me.tenant_id),
            detalhes: `Asaas ${sub.id} · ${planId}/${cycle} · R$ ${valor} · ${billingType}`,
            ip: clientIp(req), origem: "edge",
          }),
        });
        if (!first?.invoiceUrl) return fail("SERVICE", "Assinatura criada, mas a fatura ainda não foi gerada. Tente de novo em instantes.", 502);
        return json({ ok: true, url: first.invoiceUrl, subscriptionId: sub.id });
      } catch (e) {
        console.error("asaas checkout", (e as Error).message);
        return fail("GATEWAY", `Não foi possível iniciar o pagamento: ${(e as Error).message}`, 502);
      }
    }

    /* ---------- BILLING: cancelamento pelo admin da própria loja ---------- */
    case "billing.cancel": {
      if (!isAdminRole) return fail("FORBIDDEN", "Somente o administrador da loja cancela a assinatura.", 403);
      const motivo = String(p.reason || "").slice(0, 200);
      /* encerra a recorrência no gateway ANTES de bloquear (evita cobrar loja cancelada) */
      if (ASAAS_KEY) {
        const sq = await sr(`/rest/v1/tenants?select=stripe_subscription_id&id=eq.${me.tenant_id}`);
        const subId = ((await sq.json()) as Array<{ stripe_subscription_id: string | null }>)[0]?.stripe_subscription_id;
        if (subId && subId.startsWith("sub_")) {
          try { await asaas(`/subscriptions/${subId}`, { method: "DELETE" }); }
          catch (e) { return fail("GATEWAY", `Não foi possível encerrar a cobrança no Asaas: ${(e as Error).message}`, 502); }
        }
      }
      const upd = await sr(`/rest/v1/tenants?id=eq.${me.tenant_id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "read_only",
          canceled_at: new Date().toISOString(),
          cancel_reason: motivo,
        }),
      });
      if (!upd.ok) return fail("SERVICE", "Não foi possível cancelar agora. Tente novamente.");
      await sr("/rest/v1/audit_logs", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: me.tenant_id, user_id: me.id, user_name: me.nome,
          acao: "assinatura.cancelada", entidade: "tenant", entidade_id: String(me.tenant_id),
          detalhes: "cancelada pelo admin da loja — modo leitura",
          ip: clientIp(req), origem: "edge",
        }),
      });
      return json({ ok: true, status: "read_only" });
    }

    /* ---------- BILLING: ferramentas da equipe JR (papel dev) ---------- */
    case "billing.tenant_info": {
      if (me.papel !== "dev") return fail("FORBIDDEN", "Somente a equipe JR Sistemas.", 403);
      const tenantId = String(p.tenantId || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))
        return fail("VALIDATION", "Empresa inválida.");
      const q = await sr(
        `/rest/v1/tenants?select=nome,status,plan_id,plan_cycle,plan_expires_at,plan_activation_reason,trial_ends_at,next_charge_at,canceled_at&id=eq.${tenantId}`
      );
      const rows = (await q.json()) as Array<Record<string, unknown>>;
      if (!rows.length) return fail("NOT_FOUND", "Empresa não encontrada.", 404);
      return json(rows[0]);
    }

    case "billing.activate_plan": {
      if (me.papel !== "dev") return fail("FORBIDDEN", "Somente a equipe JR Sistemas ativa planos.", 403);
      const pinGate = await checkDevPin(me, req);
      if (!pinGate.ok) return pinGate.resp;
      const tenantId = String(p.tenantId || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))
        return fail("VALIDATION", "Empresa inválida.");
      const planId = String(p.planId || "");
      if (!["essencial", "profissional", "premium"].includes(planId))
        return fail("VALIDATION", "Plano inválido.");
      const cycle = p.cycle === "anual" ? "anual" : "mensal";
      const days = parseInt(String(p.days || ""), 10);
      const reason = String(p.reason || "pix").slice(0, 120);
      if (!(days > 0) || days > 3650) return fail("VALIDATION", "Duração inválida (1 a 3650 dias).");

      // Situação atual da empresa: estender plano ativo soma os dias restantes.
      const curq = await sr(`/rest/v1/tenants?select=status,plan_expires_at,plan_id&id=eq.${tenantId}`);
      const curRows = (await curq.json()) as Array<{ status: string; plan_expires_at: string | null; plan_id: string | null }>;
      if (!curRows.length) return fail("NOT_FOUND", "Empresa não encontrada.", 404);
      const cur = curRows[0];
      if (cur.plan_id === "dev") return fail("VALIDATION", "A conta interna da equipe JR não recebe prazo.");

      const base =
        p.extend === true && cur.status === "active" && cur.plan_expires_at &&
        new Date(cur.plan_expires_at).getTime() > Date.now()
          ? new Date(cur.plan_expires_at).getTime()
          : Date.now();
      let expiresAt = new Date(base + days * 864e5).toISOString();
      // Data custom (expiresAt) enviada pelo front: confiar, mas revalidar o mínimo
      if (p.expiresAt) {
        const custom = new Date(String(p.expiresAt)).getTime();
        if (!isFinite(custom)) return fail("VALIDATION", "Data de vencimento inválida.");
        if (custom <= Date.now()) return fail("VALIDATION", "A data de vencimento deve ser futura.");
        if (custom > Date.now() + 3650 * 864e5) return fail("VALIDATION", "Prazo acima do máximo (3650 dias).");
        expiresAt = new Date(custom).toISOString();
      }

      const upd = await sr(`/rest/v1/tenants?id=eq.${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "active",
          plan_id: planId,
          plan_cycle: cycle,
          plan_expires_at: expiresAt,
          plan_activated_by: me.id,
          plan_activated_at: new Date().toISOString(),
          plan_activation_reason: reason,
          next_charge_at: expiresAt,
          canceled_at: null,
          cancel_reason: "",
        }),
      });
      if (!upd.ok) return fail("SERVICE", "Não foi possível ativar o plano agora.");
      await sr("/rest/v1/audit_logs", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: tenantId, user_id: me.id, user_name: me.nome,
          acao: "plano.ativado", entidade: "tenant", entidade_id: tenantId,
          detalhes: `plano ${planId} (${cycle}) por ${days} dias até ${expiresAt} · motivo: ${reason}`,
          ip: clientIp(req), origem: "edge",
        }),
      });
      return json({ ok: true, status: "active", planId, cycle, planExpiresAt: expiresAt, nextChargeAt: expiresAt });
    }

    case "billing.suspend_tenant": {
      if (me.papel !== "dev") return fail("FORBIDDEN", "Somente a equipe JR Sistemas suspende acessos.", 403);
      const pinGate2 = await checkDevPin(me, req);
      if (!pinGate2.ok) return pinGate2.resp;
      const tenantId = String(p.tenantId || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId))
        return fail("VALIDATION", "Empresa inválida.");
      const reason = String(p.reason || "").slice(0, 200) || "suspenso pela equipe JR Sistemas";
      const upd = await sr(`/rest/v1/tenants?id=eq.${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "read_only",
          canceled_at: new Date().toISOString(),
          cancel_reason: reason,
        }),
      });
      if (!upd.ok) return fail("SERVICE", "Não foi possível suspender agora.");
      await sr("/rest/v1/audit_logs", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: tenantId, user_id: me.id, user_name: me.nome,
          acao: "assinatura.suspensa", entidade: "tenant", entidade_id: tenantId,
          detalhes: reason,
          ip: clientIp(req), origem: "edge",
        }),
      });
      return json({ ok: true, status: "read_only" });
    }

    default:
      return fail("NOT_IMPLEMENTED", `Operação "${op}" não existe no backend.`);
  }
});
