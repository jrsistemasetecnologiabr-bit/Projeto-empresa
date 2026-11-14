/* ==========================================================================
   LojaCerta · Adapters de produção
   Carregado após services.js. Implementa o contrato Adapter (request(op,payload))
   para backends reais e faz a seleção automática conforme Config.env:

     env=demo        → MockAdapter (localStorage; apresentações e homologação)
     env=production  → SupabaseAdapter (se .env configurado)
                       ou AdapterGuard (rejeita tudo com NOT_CONFIGURED até configurar)

   Nenhum arquivo de UI precisa mudar para virar produção: a troca é aqui.
   ========================================================================== */
;(function () {
  'use strict';

  function cfgError(what) {
    return ApiError('NOT_CONFIGURED',
      what + ' não está configurado para o modo produção. ' +
      'Copie .env.example para .env, preencha as chaves, siga supabase/README.md e rode: npm run build:prod');
  }

  function handleJson(r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (!r.ok) throw ApiError(j.code || j.error || 'API', j.message || j.error_description || j.msg || ('Erro HTTP ' + r.status));
      return j;
    });
  }

  /* ---------------- Supabase (Auth REST + Edge Function "api") ---------------- */
  var SupabaseAdapter = {
    token: null,
    base: function () { return String(Config.api.baseUrl || '').replace(/\/+$/, ''); },
    ready: function () { return !!(Config.api.baseUrl && Config.api.anonKey); },
    headers: function () {
      var h = { 'Content-Type': 'application/json', apikey: Config.api.anonKey };
      h.Authorization = 'Bearer ' + (this.token || Config.api.anonKey);
      return h;
    },
    request: function (op, payload) {
      if (!this.ready()) return Promise.reject(cfgError('Backend'));
      var self = this;
      payload = payload || {};

      /* Auth nativo do Supabase (senhas/magic link ficam fora do front) */
      if (op === 'auth.signup') {
        return fetch(this.base() + '/auth/v1/signup', {
          method: 'POST', headers: this.headers(),
          body: JSON.stringify({ email: payload.email, password: payload.password, data: { nome: payload.name, loja: payload.storeName } })
        }).then(handleJson).then(function (j) {
          return { userId: j.id || (j.user && j.user.id) || null, needsConfirmation: !!j.id };
        });
      }
      if (op === 'auth.login') {
        return fetch(this.base() + '/auth/v1/token?grant_type=password', {
          method: 'POST', headers: this.headers(),
          body: JSON.stringify({ email: payload.email, password: payload.password })
        }).then(handleJson).then(function (j) {
          self.token = j.access_token || null;
          return { userId: j.user && j.user.id, token: j.access_token };
        }).catch(function (e) {
          throw e.code === 'API' ? ApiError('BAD_CREDENTIALS', 'E-mail ou senha incorretos.') : e;
        });
      }
      if (op === 'auth.logout') { this.token = null; return Promise.resolve({ ok: true }); }

      /* Demais ops → Edge Function "api" (server-side, com service role e RLS) */
      return fetch(this.base() + '/functions/v1/api', {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({ op: op, payload: payload })
      }).then(handleJson);
    }
  };

  /* ---------------- HTTP genérico (API própria / BFF) ----------------
     Use se preferir hospedar um backend próprio: cada op vira POST {baseUrl}/api/{op}. */
  var HttpAdapter = Object.assign({}, SupabaseAdapter, {
    request: function (op, payload) {
      if (!this.ready()) return Promise.reject(cfgError('Backend'));
      return fetch(this.base() + '/api/' + op, {
        method: 'POST', headers: this.headers(), body: JSON.stringify(payload || {})
      }).then(handleJson);
    }
  });

  /* ---------------- Supabase Auth Adapter (produção) ----------------
     Mapeia as MESMAS chamadas do AuthService para o Supabase Auth REST.
     Ativa automaticamente quando ENV=production e as chaves existem. */
  /* v1.9.3 · renovação de sessão em voo ÚNICO. O refresh token do Supabase é de
     uso único: duas renovações simultâneas invalidam a sessão. Todo mundo
     (touch em background, botão "renovar", retry de requisição) passa por aqui. */
  var SessionRefresh = {
    _p: null,
    run: function () {
      if (this._p) return this._p;
      var self = this, s = Store.state.session || {};
      if (!s.refresh) { var e0 = ApiError('UNAUTHORIZED', 'Sessão expirada. Entre novamente.'); e0.fatal = true; return Promise.reject(e0); }
      var base = String(Config.api.baseUrl || '').replace(/\/+$/, '');
      this._p = fetch(base + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: Config.api.anonKey, Authorization: 'Bearer ' + Config.api.anonKey },
        body: JSON.stringify({ refresh_token: s.refresh })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok || !j.access_token) {
            var e = ApiError('UNAUTHORIZED', 'Sessão expirada. Entre novamente.');
            e.fatal = r.status >= 400 && r.status < 500; /* refresh recusado = sessão morta; 5xx = tenta depois */
            throw e;
          }
          /* preserva profile/tenantId já hidratados — só troca os tokens */
          var sess = Store.state.session || {};
          if (j.user && j.user.id) sess.userId = j.user.id;
          sess.token = j.access_token; sess.refresh = j.refresh_token;
          sess.expiresAt = Date.now() + (j.expires_in || 3600) * 1000;
          sess.refreshUntil = Date.now() + 30 * 864e5;
          delete sess._refreshingAt;
          Store.persist();
          return true;
        });
      }).then(function (ok) { self._p = null; return ok; }, function (err) { self._p = null; throw err; });
      return this._p;
    }
  };

  var SupabaseAuthOverrides = {
    id: 'supabase',
    _base: function () { return String(Config.api.baseUrl || '').replace(/\/+$/, ''); },
    _ready: function () { return !!(Config.api.baseUrl && Config.api.anonKey); },
    _h: function (token) {
      var h = { 'Content-Type': 'application/json', apikey: Config.api.anonKey };
      h.Authorization = 'Bearer ' + (token || Config.api.anonKey);
      return h;
    },
    /* Traduz erros do Supabase Auth (e da Edge Function) para códigos/mensagens amigáveis em pt-BR */
    _mapAuthError: function (j) {
      var code = j && (j.error_code || j.code || j.error) || '';
      var msg = (j && (j.error_description || j.msg || j.message)) || '';
      var m;
      if (code === 'TRIAL_LIMIT')
        return ApiError('TRIAL_LIMIT', msg || 'Já existe uma conta usando o teste grátis nesta rede. Para criar outra conta, contrate o plano pago.');
      if (code === 'email_not_confirmed' || /email not confirmed/i.test(msg))
        return ApiError('EMAIL_NOT_CONFIRMED', 'Confirme seu e-mail antes de entrar — enviamos um código de 6 dígitos (válido por 10 minutos).');
      if (code === 'SIGNUP_BACKEND_MISSING' || code === 'NOT_IMPLEMENTED')
        return ApiError('NOT_IMPLEMENTED', msg || 'Operação não disponível no backend.');
      if ((m = msg.match(/already (been )?registered|already exists/i)) || code === 'user_already_exists' || code === 'email_exists')
        return ApiError('EMAIL_EXISTS', 'Já existe uma conta com este e-mail. Tente entrar ou recuperar a senha.');
      if (code === 'weak_password' || /password should be at least/i.test(msg))
        return ApiError('WEAK_PASSWORD', 'Senha fraca: use no mínimo 8 caracteres, com maiúscula, minúscula e número.');
      if (code === 'invalid_grant' || /invalid login credentials/i.test(msg))
        return ApiError('BAD_CREDENTIALS', 'E-mail ou senha incorretos.');
      if (code === 'over_email_send_rate_limit' || /email rate limit/i.test(msg))
        return ApiError('EMAIL_SEND', 'Não conseguimos enviar o e-mail agora — o provedor de e-mail do Supabase atingiu o limite do plano (2–4 e-mails/hora sem SMTP próprio). Tente novamente em alguns minutos ou fale com o suporte.');
      if (/too many requests/i.test(msg))
        return ApiError('RATE_LIMITED', 'Muitas tentativas em pouco tempo. Aguarde alguns minutos.');
      if (/error sending (recovery |confirmation |invite )?email/i.test(msg))
        return ApiError('EMAIL_SEND', 'Não conseguimos enviar o e-mail agora — o provedor de e-mail do Supabase atingiu o limite do plano. Tente novamente em alguns minutos (ou fale com o suporte).');
      if (code === 'refresh_token_not_found' || code === 'refresh_token_already_used')
        return ApiError('UNAUTHORIZED', 'Sessão expirada. Entre novamente.');
      return ApiError('AUTH', msg || 'Falha de autenticação. Tente novamente.');
    },
    _json: function (r) {
      var self = this;
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw self._mapAuthError(j);
        return j;
      });
    },
    /* pós-login: grava a sessão e hidrata o perfil + dados do tenant */
    _afterSession: function (j) {
      Store.state.session = { userId: j.user.id, token: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000, refreshUntil: Date.now() + 30 * 864e5 };
      Store.persist();
      return SupabaseDataAdapter.hydrateProfile().then(function () { return SupabaseDataAdapter.request('sync.pull', {}); }).then(function () { return { userId: j.user.id }; });
    },
    signup: function (d) {
      if (!this._ready()) return Promise.reject(ApiError('NOT_CONFIGURED', 'Autenticação Supabase não configurada (.env).'));
      var self = this;
      /* Cadastro passa pela Edge Function "api" (op auth.signup): ela registra o
         IP + identificador do navegador, valida o limite de testes grátis por
         IP/dispositivo no banco e cria a conta no Supabase Auth — o e-mail de
         confirmação (código de 6 dígitos) segue pelo fluxo NATIVO do GoTrue.
         Fallback: se o backend ainda não tem a op (deploy em andamento), usa o
         signup direto como antes — o site nunca fica quebrado no meio do deploy. */
      return fetch(this._base() + '/functions/v1/api', {
        method: 'POST', headers: this._h(),
        body: JSON.stringify({ op: 'auth.signup', payload: { email: d.email, password: d.password, name: d.name, storeName: d.storeName, segment: d.segment, deviceId: U.deviceId() } })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) {
            var err = self._mapAuthError(j);
            if (err.code === 'NOT_IMPLEMENTED' || err.code === 'SIGNUP_BACKEND_MISSING') return { fallback: true };
            throw err;
          }
          return j;
        });
      }).then(function (j) {
        if (j && j.fallback) {
          /* backend sem a guarda: caminho antigo (direto no GoTrue) */
          return fetch(self._base() + '/auth/v1/signup', { method: 'POST', headers: self._h(), body: JSON.stringify({ email: d.email, password: d.password, data: { nome: d.name, loja: d.storeName, segmento: d.segment } }) }).then(self._json.bind(self)).then(function (jj) {
            if (jj.access_token) return self._afterSession(jj);
            return { needsConfirmation: true };
          });
        }
        if (j && j.needsConfirmation) return { needsConfirmation: true };
        /* já confirmado (autoconfirm): entra direto (o token NÃO transita pela função) */
        return self.login({ email: d.email, password: d.password });
      });
    },
    login: function (d) {
      if (!this._ready()) return Promise.reject(ApiError('NOT_CONFIGURED', 'Autenticação Supabase não configurada (.env).'));
      return fetch(this._base() + '/auth/v1/token?grant_type=password', { method: 'POST', headers: this._h(), body: JSON.stringify({ email: d.email, password: d.password }) }).then(this._json.bind(this)).then(function (j) {
        Store.state.session = { userId: j.user.id, token: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000, refreshUntil: Date.now() + 30 * 864e5 };
        Store.persist();
        return SupabaseDataAdapter.hydrateProfile().then(function () { return SupabaseDataAdapter.request('sync.pull', {}); }).then(function () { return { userId: j.user.id }; });
      });
    },
    logout: function () { Store.state.session = { userId: null }; Store.persist(); return Promise.resolve({ ok: true }); },
    touch: function () {
      var s = Store.state.session;
      if (!s || !s.token) return { state: 'anon' };
      var now = Date.now();
      var left = s.expiresAt - now;
      /* tranquilo: ainda há mais de 5 minutos de token */
      if (left > 5 * 60 * 1000) return { state: 'ok' };
      if (!s.refresh || now > s.refreshUntil) {
        if (left <= 0) { Store.state.session = { userId: null }; Store.persist(); return { state: 'expired' }; }
        return { state: 'ok' }; /* sem refresh token: segue com o token atual até expirar */
      }
      /* faltam <5min (ou já expirou): renova em background, com antirrepetição de 10s */
      if (left > 0 && s._refreshingAt && now - s._refreshingAt < 10000) return { state: 'ok' };
      s._refreshingAt = now; Store.persist();
      SessionRefresh.run().catch(function () { /* mantém a sessão atual; nova tentativa no próximo giro */ });
      return { state: left <= 0 ? 'refreshed' : 'ok' };
    },
    /* Renovação EXPLÍCITA (botão "Renovar sessão agora"): troca o refresh token
       por um access token novo e SÓ então resolve — a UI mostra o prazo real. */
    renew: function () {
      var self = this;
      var s = Store.state.session;
      if (!s || !s.token) return Promise.reject(ApiError('UNAUTHORIZED', 'Sessão expirada. Entre novamente.'));
      if (!s.refresh) return Promise.reject(ApiError('SERVICE', 'Esta sessão não pode ser renovada aqui. Saia e entre novamente para gerar uma nova.'));
      return SessionRefresh.run().then(function () {
        return { state: 'renewed', expiresAt: Store.state.session.expiresAt };
      }).catch(function (e) {
        throw e && e.code ? e : ApiError('SERVICE', 'Não foi possível renovar agora. Verifique a conexão e tente de novo.');
      });
    },
    requestPasswordReset: function (d) {
      if (!this._ready()) return Promise.reject(ApiError('NOT_CONFIGURED', 'Autenticação Supabase não configurada (.env).'));
      return fetch(this._base() + '/auth/v1/recover', { method: 'POST', headers: this._h(), body: JSON.stringify({ email: d.email, redirect_to: Config.siteUrl + '/#/redefinir' }) }).then(this._json.bind(this)).then(function () { return { sent: true }; });
    },
    resetPassword: function (d) {
      if (d.password !== d.confirm) return Promise.reject(ApiError('PASSWORD_MISMATCH', 'As senhas não conferem.'));
      var issues = passwordIssuesLocal(d.password);
      if (issues.length) return Promise.reject(ApiError('WEAK_PASSWORD', 'Senha fraca. Falta: ' + issues.join(', ') + '.'));
      /* bearer: token de recuperação (link do e-mail) ou token da sessão */
      var bearer = d.token || (Store.state.session && Store.state.session.token);
      return fetch(this._base() + '/auth/v1/user', { method: 'PUT', headers: this._h(bearer), body: JSON.stringify({ password: d.password }) }).then(this._json.bind(this)).then(function (j) {
        if (j && j.access_token) {
          Store.state.session = { userId: j.user.id, token: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000, refreshUntil: Date.now() + 30 * 864e5 };
          Store.persist();
        }
        return { ok: true };
      });
    },
    /* Troca de e-mail: fluxo nativo do Supabase (envia confirmação ao novo e-mail via SMTP configurado) */
    requestEmailChange: function (d) {
      var newEmail = String(d.newEmail || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(newEmail)) return Promise.reject(ApiError('INVALID_EMAIL', 'E-mail novo inválido.'));
      if (!this.verifyPassword((Store.state.session || {}).userId, d.password)) return Promise.reject(ApiError('BAD_CREDENTIALS', 'Senha atual incorreta.'));
      return fetch(this._base() + '/auth/v1/user', { method: 'PUT', headers: this._h(Store.state.session && Store.state.session.token), body: JSON.stringify({ email: newEmail }) }).then(this._json.bind(this)).then(function () {
        return { sent: true, provider: true };
      });
    },
    confirmEmailChange: function () { return Promise.resolve({ ok: true, provider: true }); },
    confirmWithCode: function (d) {
      return fetch(this._base() + '/auth/v1/verify', { method: 'POST', headers: this._h(), body: JSON.stringify({ type: 'email', email: d.email, token: String(d.code || '') }) }).then(this._json.bind(this)).then(function (j) {
        if (j && j.access_token) {
          Store.state.session = { userId: j.user.id, token: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + (j.expires_in || 3600) * 1000, refreshUntil: Date.now() + 30 * 864e5 };
          Store.persist();
          return SupabaseDataAdapter.hydrateProfile().then(function () { return SupabaseDataAdapter.request('sync.pull', {}); }).then(function () { return { userId: j.user.id }; });
        }
        return { ok: true };
      });
    },
    resendConfirmation: function (email) {
      return fetch(this._base() + '/auth/v1/resend', { method: 'POST', headers: this._h(), body: JSON.stringify({ type: 'signup', email: email }) }).then(this._json.bind(this)).then(function () { return { sent: true, provider: true }; });
    },
    changePassword: function (d) {
      var self = this;
      if (!this._ready()) return Promise.reject(ApiError('NOT_CONFIGURED', 'Autenticação Supabase não configurada (.env).'));
      /* 1) valida a senha atual fazendo um login real (sem isso, qualquer um
            com a sessão aberta trocaria a senha sem provar que é o dono) */
      var me = Auth.me() || {};
      return fetch(this._base() + '/auth/v1/token?grant_type=password', {
        method: 'POST', headers: this._h(), body: JSON.stringify({ email: me.email, password: d.current })
      }).then(function (r) {
        if (!r.ok) throw ApiError('BAD_CREDENTIALS', 'Senha atual incorreta.');
        return r.json();
      }).then(function () {
        /* 2) aplica a nova senha */
        var issues = passwordIssuesLocal(d.next);
        if (issues.length) return Promise.reject(ApiError('WEAK_PASSWORD', 'Senha fraca. Falta: ' + issues.join(', ') + '.'));
        if (d.next !== d.confirm) return Promise.reject(ApiError('PASSWORD_MISMATCH', 'As senhas não conferem.'));
        return fetch(self._base() + '/auth/v1/user', { method: 'PUT', headers: self._h(Store.state.session && Store.state.session.token), body: JSON.stringify({ password: d.next }) }).then(self._json.bind(self));
      }).then(function () { return { ok: true }; });
    },
    /* LGPD: pedido de exclusão da conta — valida a senha com um login real
       (idem changePassword) e registra via Edge Function (service role).
       Sem este override, caía no motor local e sempre falhava com "senha incorreta". */
    requestAccountDeletion: function (password) {
      var self = this;
      if (!this._ready()) return Promise.reject(ApiError('NOT_CONFIGURED', 'Autenticação Supabase não configurada (.env).'));
      var me = Auth.me() || {};
      if (!me.email) return Promise.reject(ApiError('UNAUTHORIZED', 'Sessão expirada.'));
      return fetch(this._base() + '/auth/v1/token?grant_type=password', {
        method: 'POST', headers: this._h(), body: JSON.stringify({ email: me.email, password: String(password == null ? '' : password) })
      }).then(function (r) {
        if (!r.ok) throw ApiError('BAD_CREDENTIALS', 'Senha atual incorreta.');
        return r.json();
      }).then(function () {
        return ApiClient.request('account.request_deletion', {});
      }).then(function (r) {
        Store.update(function (s) { if (s.tenant) s.tenant.deletionRequestedAt = Date.now(); });
        return { ok: true, graceUntil: (r && r.graceUntil) || new Date(Date.now() + 30 * 864e5).toISOString() };
      });
    }
    /* confirmEmail / emailChange: o provider envia o link com token próprio;
       as telas /confirmar-email já tratam o redirect de volta. */
  };
  function passwordIssuesLocal(pw) { return AuthService.passwordIssues(pw); }


  /* ============================================================================
     SupabaseDataAdapter (produção): PostgREST + RPCs atômicas + hidratação local.
     Leituras: cache local hidratado via sync.pull (multi-dispositivo = re-login/refresh).
     Escritas: servidor (RPCs security-definer com regras de negócio) + cache.
     ========================================================================== */
  var FRIENDLY = {
    NO_STOCK: 'Estoque insuficiente para um dos itens.',
    PAY_MISMATCH: 'A soma dos pagamentos não fecha com o total.',
    DISCOUNT_LIMIT: 'Desconto acima do limite do seu papel.',
    BILLING_BLOCKED: 'Assinatura suspensa: PDV bloqueado. Regularize em Assinatura.',
    TRIAL_EXPIRED: 'Seu teste grátis de 14 dias terminou. Ative um plano em Assinatura para voltar a vender.',
    EMPTY_CART: 'Adicione produtos à venda.',
    PROD_OFF: 'Produto indisponível ou inativo.',
    UNAUTHORIZED: 'Sessão inválida ou expirada.',
    STOCK_NEG: 'O ajuste deixaria o estoque negativo.',
    PGRST301: 'Sessão expirada. Entre novamente.',
    PGRST303: 'Sessão expirada. Entre novamente.',
    LAST_ADMIN: 'A loja precisa de pelo menos um administrador ativo — promova outra pessoa a admin antes.',
    VALIDATION: 'Dados inválidos na operação.',
    ALREADY: 'Esta venda já foi cancelada.',
    FORBIDDEN: 'Seu papel não tem permissão para esta ação.',
    NOT_FOUND: 'Registro não encontrado.',
    REOPEN_LIMIT: 'Este chamado já foi reaberto 3 vezes — para continuar, abra um novo chamado de suporte.',
    DEV_PIN_REQUIRED: 'PIN de segurança obrigatório — informe o PIN da equipe JR para operações de cobrança.',
    ACCOUNT_DISABLED: 'Esta conta está desativada. Fale com a equipe JR Sistemas pelo suporte.'
  };
  var SupabaseDataAdapter = {
    id: 'supabase-data',
    base: function () { return String(Config.api.baseUrl || '').replace(/\/+$/, ''); },
    ready: function () { return !!(Config.api.baseUrl && Config.api.anonKey); },
    sid: function () { return (Store.state.session || {}).tenantId || null; },
    /* PIN da equipe JR para escrita de cobrança (v8): guardado por SESSÃO de
       navegador (sessionStorage — some ao fechar) e enviado como header. */
    devPinHeader: function () {
      try {
        var pin = sessionStorage.getItem('lc_dev_pin');
        return pin ? { 'x-dev-pin': pin } : {};
      } catch (e) { return {}; }
    },
    h: function () {
      var s = Store.state.session || {};
      return { 'Content-Type': 'application/json', apikey: Config.api.anonKey, Authorization: 'Bearer ' + (s.token || Config.api.anonKey) };
    },
    j: function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var e = Array.isArray(j) ? j[0] : j;
          var code = e.code || e.error || 'API';
          if (code === '23505') code = 'DUP_CODE';
          var msg = e.message || 'Erro de API';
          var bare = msg.match(/^([A-Z_]{3,})$/);
          if (bare) code = bare[1];
          /* mensagens humanas do backend (Edge Function envia frases pt-BR completas,
             com pontuação) têm prioridade sobre os textos genéricos do FRIENDLY;
             mensagens técnicas do PostgREST (sem pontuação final) caem no FRIENDLY */
          var human = /\s/.test(msg) && msg.trim().length >= 20 && /[.!?…]$/.test(msg.trim());
          throw ApiError(code, human ? msg : (FRIENDLY[code] || msg));
        }
        return j;
      });
    },
    /* v1.9.3 · abrir o app com token vencido: renova ANTES de buscar o perfil */
    hydrateProfile: function () {
      var self = this, s0 = Store.state.session || {};
      var pre = (s0.token && s0.refresh && s0.expiresAt && s0.expiresAt - Date.now() < 60000)
        ? SessionRefresh.run().catch(function (e) { if (e && e.fatal) throw e; }) : Promise.resolve();
      return pre.then(function () { return self._hydrateProfile(); });
    },
    _hydrateProfile: function () {
      var self = this, s = Store.state.session || {};
      if (!s.token) return Promise.reject(ApiError('UNAUTHORIZED', 'Sessão inválida.'));
      /* userId pode não existir ainda (sessão veio de link de convite/recuperação) */
      var lookup = s.userId ? Promise.resolve(s.userId)
        : fetch(this.base() + '/auth/v1/user', { headers: this.h() }).then(function (r) { return r.json(); }).then(function (u) {
            if (!u || !u.id) throw ApiError('UNAUTHORIZED', 'Sessão inválida.');
            s.userId = u.id; Store.persist(); return u.id;
          });
      return lookup.then(function (uid) {
        return fetch(self.base() + '/rest/v1/users?select=*&id=eq.' + uid, { headers: self.h() });
      }).then(this.j).then(function (rows) {
        if (!rows[0]) throw ApiError('UNAUTHORIZED', 'Perfil não encontrado para a sessão.');
        var u = rows[0];
        Store.state.session.tenantId = u.tenant_id;
        Store.state.session.userId = u.id;
        Store.state.session.profile = { id: u.id, nome: u.nome, email: u.email, papel: u.papel };
        Store.persist();
        return u;
      });
    },
    /* v1.9.3 · toda operação passa por aqui: (1) se o token vence em <60s, ESPERA a
       renovação antes de enviar; (2) se o servidor responder "JWT expired"/401,
       renova e repete UMA vez; (3) refresh recusado = volta ao login com aviso.
       Antes: a renovação era só em background e a tela mostrava "JWT expired". */
    request: function (op, p) {
      var self = this, s = Store.state.session || {};
      var isExpired = function (e) {
        var c = String((e && e.code) || ''), m = String((e && e.message) || '');
        return c === 'PGRST301' || c === 'PGRST303' || c === '401' || /jwt expired|invalid jwt|jwt is expired/i.test(m);
      };
      var pre = (s.token && s.refresh && s.expiresAt && s.expiresAt - Date.now() < 60000)
        ? SessionRefresh.run().catch(function (e) { if (e && e.fatal) throw e; })
        : Promise.resolve();
      return pre.then(function () { return self._request(op, p); }).catch(function (e) {
        if (e && e.fatal) return self._sessionLost();
        if (!isExpired(e)) throw e;
        return SessionRefresh.run().then(function () { return self._request(op, p); }, function (e2) {
          if (e2 && e2.fatal) return self._sessionLost();
          throw ApiError('SERVICE', 'Não foi possível renovar a sessão — verifique a internet e tente de novo.');
        });
      });
    },
    _sessionLost: function () {
      Store.state.session = { userId: null }; Store.persist();
      try { UI.toast('Sua sessão expirou. Entre novamente.', { type: 'warn', timeout: 6000 }); Router.go('/entrar'); } catch (e) { }
      return Promise.reject(ApiError('UNAUTHORIZED', 'Sessão expirada. Entre novamente.'));
    },
    _request: function (op, p) {
      if (!this.ready()) return Promise.reject(ApiError('NOT_CONFIGURED', 'Backend não configurado (.env).'));
      p = p || {};
      var self = this, B = this.base(), H = this.h();
      var sid = this.sid();
      if (op !== 'sync.pull' && !sid) return Promise.reject(ApiError('UNAUTHORIZED', 'Sessão sem tenant.'));
      switch (op) {
        case 'sync.pull': {
          var s2 = this.sid();
          var q = function (path) { return fetch(B + '/rest/v1/' + path, { headers: H }).then(self.j); };
          /* v1.9.1 · paginação: o PostgREST corta em 1000 linhas (max-rows) — antes,
             loja com >1000 produtos tinha catálogo truncado em silêncio e vendas
             vinham com limit=300 (dashboard/relatórios de 30 dias errados). */
          var PAGE = 1000, MAX_PAGES = 60;
          var qAll = function (path) {
            var out = [];
            var step = function (page) {
              return q(path + '&limit=' + PAGE + '&offset=' + (page * PAGE)).then(function (rows) {
                rows = rows || []; out = out.concat(rows);
                return (rows.length === PAGE && page + 1 < MAX_PAGES) ? step(page + 1) : out;
              });
            };
            return step(0);
          };
          var since = new Date(Date.now() - 90 * 864e5).toISOString();
          return Promise.all([
            q('categories?select=*&tenant_id=eq.' + s2 + '&order=nome'),
            qAll('products?select=*&tenant_id=eq.' + s2 + '&order=nome,id'),
            q('users?select=*&tenant_id=eq.' + s2 + '&order=nome'),
            qAll('sales?select=*,users(nome),sale_items(*),sale_payments(*)&tenant_id=eq.' + s2 + '&created_at=gte.' + encodeURIComponent(since) + '&order=created_at.desc,id'),
            qAll('stock_movements?select=*,users(nome)&tenant_id=eq.' + s2 + '&created_at=gte.' + encodeURIComponent(since) + '&order=created_at.desc,id'),
            q('tenants?select=*&id=eq.' + s2)
          ]).then(function (d) {
            Store.update(function (s) {
              s.categories = (d[0] || []).map(function (c) { return { id: c.id, nome: c.nome }; });
              s.products = (d[1] || []).map(function (x) { return { id: x.id, codigo: x.codigo, nome: x.nome, catId: x.category_id, un: x.unidade, custo: Number(x.preco_custo), preco: Number(x.preco_venda), estoque: Number(x.estoque_atual), min: Number(x.estoque_minimo), fornecedor: x.fornecedor || '', ativo: x.ativo }; });
              s.users = (d[2] || []).map(function (x) { return { id: x.id, nome: x.nome, email: x.email, papel: x.papel, ativo: x.ativo, createdAt: new Date(x.created_at).getTime() }; });
              /* auto-correção de papel/nome do perfil logado (ex.: conta promovida a dev
                 pela equipe JR — sem isso o navegador continuaria com papel antigo) */
              if (s.session && s.session.profile) {
                var meRow = (d[2] || []).filter(function (x) { return x.id === s.session.userId; })[0];
                if (meRow) {
                  s.session.profile.papel = meRow.papel;
                  s.session.profile.nome = meRow.nome;
                }
              }
              s.sales = (d[3] || []).map(function (v) {
                return { id: v.id, numero: v.numero, at: new Date(v.created_at).getTime(), userId: v.user_id, userName: (v.users && v.users.nome) || '',
                  itens: (v.sale_items || []).map(function (i) { return { productId: i.product_id, nome: i.nome_snapshot, un: i.unidade, qtd: Number(i.qtd), preco: Number(i.preco_unitario), subtotal: Number(i.subtotal) }; }),
                  subtotal: Number(v.subtotal), desconto: Number(v.desconto), descontoTipo: v.desconto_tipo, total: Number(v.total),
                  pagamentos: (v.sale_payments || []).map(function (x) { return { forma: x.forma, valor: Number(x.valor) }; }),
                  status: v.status, motivoCancelamento: v.motivo_cancelamento || '' };
              });
              s.movements = (d[4] || []).map(function (m) { return { id: m.id, at: new Date(m.created_at).getTime(), productId: m.product_id, tipo: m.tipo, qtd: Number(m.qtd), userId: m.user_id, userName: (m.users && m.users.nome) || '', origem: m.origem || '', obs: m.obs || '' }; });
              if (d[5] && d[5][0]) {
                var t = d[5][0];
                Object.assign(s.tenant, { nome: t.nome, segmento: t.segmento, cnpj: t.cnpj || '', endereco: t.endereco || '', telefone: t.telefone || '',
                  status: t.status, planId: t.plan_id, planCycle: t.plan_cycle, scheduledPlan: t.scheduled_plan,
                  planExpiresAt: t.plan_expires_at ? new Date(t.plan_expires_at).getTime() : (s.tenant.planExpiresAt || null),
                  nextChargeAt: t.next_charge_at ? new Date(t.next_charge_at).getTime() : null,
                  trialEndsAt: t.trial_ends_at ? new Date(t.trial_ends_at).getTime() : s.tenant.trialEndsAt,
                  config: t.config || s.tenant.config });
              }
              s.seq.sale = s.sales.reduce(function (a, v) { var n = parseInt(String(v.numero).replace(/\D/g, ''), 10) || 0; return Math.max(a, n); }, 0) + 1;
            });
            /* trial vencido refletido na hora (o servidor confirma via billing.refresh) */
            var tt = Store.state.tenant;
            if (tt && tt.status === 'trialing' && tt.trialEndsAt && tt.trialEndsAt <= Date.now()) {
              Store.update(function (s) { s.tenant.status = 'read_only'; });
              fetch(B + '/rest/v1/rpc/billing_refresh_status', { method: 'POST', headers: H, body: JSON.stringify({}) }).catch(function () { });
            }
            return { ok: true };
          });
        }
        case 'products.create': {
          var codigo = String(p.codigo || '').trim() || ('INT-' + String(Date.now()).slice(-6));
          return fetch(B + '/rest/v1/products', { method: 'POST', headers: Object.assign({ Prefer: 'return=representation' }, H),
            body: JSON.stringify({ tenant_id: sid, codigo: codigo, nome: p.nome, category_id: p.catId || null, unidade: p.un || 'un',
              preco_custo: p.custo || 0, preco_venda: p.preco, estoque_atual: p.estoque || 0, estoque_minimo: p.min || 0, fornecedor: p.fornecedor || '' }) }).then(this.j).then(function (rows) {
            var row = rows[0];
            if ((p.estoque || 0) > 0) fetch(B + '/rest/v1/stock_movements', { method: 'POST', headers: H, body: JSON.stringify({ tenant_id: sid, product_id: row.id, tipo: 'entrada', qtd: p.estoque, user_id: (Store.state.session || {}).userId, origem: 'Cadastro inicial' }) });
            Store.update(function (s) { s.products.push({ id: row.id, codigo: row.codigo, nome: row.nome, catId: row.category_id, un: row.unidade, custo: Number(row.preco_custo), preco: Number(row.preco_venda), estoque: Number(row.estoque_atual), min: Number(row.estoque_minimo), fornecedor: row.fornecedor || '', ativo: row.ativo });
              /* mantém o cache local coerente com o banco: a entrada inicial também aparece na lista de movimentos na MESMA sessão */
              if (!s.movements) s.movements = [];
              if ((p.estoque || 0) > 0) s.movements.unshift({ id: 'mv' + Date.now(), at: Date.now(), productId: row.id, tipo: 'entrada', qtd: Number(p.estoque), userId: (Store.state.session || {}).userId, userName: (((Store.state.session || {}).profile) || {}).nome || '', origem: 'Cadastro inicial', obs: (p.nome || '') }); });
            return { id: row.id };
          });
        }
        case 'products.update': {
          return fetch(B + '/rest/v1/products?id=eq.' + p.id, { method: 'PATCH', headers: Object.assign({ Prefer: 'return=representation' }, H),
            body: JSON.stringify({ nome: p.nome, category_id: p.catId, unidade: p.un, preco_custo: p.custo, preco_venda: p.preco, estoque_atual: p.estoque, estoque_minimo: p.min, fornecedor: p.fornecedor }) }).then(this.j).then(function (rows) {
            var row = rows[0];
            Store.update(function (s) { var x = s.products.filter(function (y) { return y.id === row.id; })[0]; if (x) Object.assign(x, { codigo: row.codigo, nome: row.nome, catId: row.category_id, un: row.unidade, custo: Number(row.preco_custo), preco: Number(row.preco_venda), estoque: Number(row.estoque_atual), min: Number(row.estoque_minimo), fornecedor: row.fornecedor || '' }); });
            return { id: row.id };
          });
        }
        case 'products.toggle': {
          var cur = Store.state.products.filter(function (x) { return x.id === p.id; })[0];
          var novo = cur ? !cur.ativo : true;
          return fetch(B + '/rest/v1/products?id=eq.' + p.id, { method: 'PATCH', headers: Object.assign({ Prefer: 'return=representation' }, H), body: JSON.stringify({ ativo: novo }) }).then(this.j).then(function () {
            Store.update(function (s) { var x = s.products.filter(function (y) { return y.id === p.id; })[0]; if (x) x.ativo = novo; });
            return { ativo: novo };
          });
        }
        case 'inventory.entry': return fetch(B + '/rest/v1/rpc/stock_entry', { method: 'POST', headers: H, body: JSON.stringify({ p: p }) }).then(this.j).then(function (r) {
          Store.update(function (s) { var x = s.products.filter(function (y) { return y.id === p.productId; })[0]; if (x) { x.estoque = Number(r.estoque); if (Number(p.custo) > 0) x.custo = Number(p.custo); } s.movements.unshift({ id: 'mv' + Date.now(), at: Date.now(), productId: p.productId, tipo: 'entrada', qtd: Number(p.qtd), userId: (s.session || {}).userId, userName: ((s.session || {}).profile || {}).nome || '', origem: ['Compra', p.fornecedor, p.nf ? 'NF ' + p.nf : ''].filter(Boolean).join(' · '), obs: p.note || '' }); });
          return r;
        });
        case 'inventory.adjust': return fetch(B + '/rest/v1/rpc/stock_adjust', { method: 'POST', headers: H, body: JSON.stringify({ p: p }) }).then(this.j).then(function (r) {
          Store.update(function (s) { var x = s.products.filter(function (y) { return y.id === p.productId; })[0]; if (x) x.estoque = Number(r.estoque); s.movements.unshift({ id: 'mv' + Date.now(), at: Date.now(), productId: p.productId, tipo: 'ajuste', qtd: Number(p.delta), userId: (s.session || {}).userId, userName: ((s.session || {}).profile || {}).nome || '', origem: p.reason, obs: p.note || '' }); });
          return r;
        });
        case 'sales.commit': return fetch(B + '/rest/v1/rpc/commit_sale', { method: 'POST', headers: H, body: JSON.stringify({ p: { items: p.items, discount: p.discount, payments: p.payments, idempotencyId: p.idempotencyId || null } }) }).then(this.j).then(function (sale) {
          Store.update(function (s) {
            sale.itens.forEach(function (it) { var x = s.products.filter(function (y) { return y.id === it.productId; })[0]; if (x) x.estoque = Math.round((x.estoque - it.qtd) * 1000) / 1000; });
            s.sales.unshift({ id: sale.id, numero: sale.numero, at: new Date(sale.at).getTime(), userId: (s.session || {}).userId, userName: sale.userName || '', itens: sale.itens, subtotal: Number(sale.subtotal), desconto: Number(sale.desconto), descontoTipo: (p.discount || {}).tipo || 'R$', total: Number(sale.total), pagamentos: sale.pagamentos, status: 'concluida' });
            sale.itens.forEach(function (it) { s.movements.unshift({ id: 'mv' + Date.now() + it.productId, at: Date.now(), productId: it.productId, tipo: 'saida', qtd: it.qtd, userId: (s.session || {}).userId, userName: sale.userName || '', origem: sale.numero, obs: '' }); });
          });
          return { sale: sale };
        });
        case 'sales.cancel': return fetch(B + '/rest/v1/rpc/cancel_sale', { method: 'POST', headers: H, body: JSON.stringify({ p: { id: p.id, reason: p.reason } }) }).then(this.j).then(function (r) {
          Store.update(function (s) {
            var v = s.sales.filter(function (x) { return x.id === p.id; })[0];
            if (v) { v.status = 'cancelada'; v.motivoCancelamento = p.reason; v.itens.forEach(function (it) { var x = s.products.filter(function (y) { return y.id === it.productId; })[0]; if (x) x.estoque = Math.round((x.estoque + it.qtd) * 1000) / 1000; }); }
          });
          return r;
        });
        case 'tenant.update': {
          var body = {};
          ['nome', 'cnpj', 'endereco', 'telefone'].forEach(function (k) { if (p[k] !== undefined) body[k] = p[k]; });
          if (p.descontoCaixaPct !== undefined || p.permiteEstoqueNegativo !== undefined || p.reciboMsg !== undefined) {
            var cfg = Object.assign({}, Store.state.tenant.config || {});
            if (p.descontoCaixaPct !== undefined) cfg.descontoCaixaPct = Math.min(100, Math.max(0, Number(p.descontoCaixaPct) || 0));
            if (p.permiteEstoqueNegativo !== undefined) cfg.permiteEstoqueNegativo = !!p.permiteEstoqueNegativo;
            if (p.reciboMsg !== undefined) cfg.reciboMsg = String(p.reciboMsg).slice(0, 120);
            body.config = cfg;
          }
          return fetch(B + '/rest/v1/tenants?id=eq.' + sid, { method: 'PATCH', headers: Object.assign({ Prefer: 'return=representation' }, H), body: JSON.stringify(body) }).then(this.j).then(function (rows) {
            Store.update(function (s) { if (rows[0]) { var t = rows[0]; Object.assign(s.tenant, { nome: t.nome, cnpj: t.cnpj || '', endereco: t.endereco || '', telefone: t.telefone || '', config: t.config || s.tenant.config }); } });
            return { ok: true };
          });
        }
        case 'users.update': return fetch(B + '/rest/v1/users?id=eq.' + p.id, { method: 'PATCH', headers: Object.assign({ Prefer: 'return=representation' }, H), body: JSON.stringify({ papel: p.papel, ativo: p.ativo }) }).then(this.j).then(function (rows) {
          Store.update(function (s) { var x = s.users.filter(function (y) { return y.id === p.id; })[0]; if (x && rows[0]) { x.papel = rows[0].papel; x.ativo = rows[0].ativo; } });
          /* v1.9.2 · RLS sem permissão devolve [] com HTTP 200 — antes virava "salvo" falso */
          if (!rows || !rows[0]) throw ApiError('FORBIDDEN', 'Somente administradores alteram usuários.');
          return { ok: true };
        });
        /* ---- convites: Edge Function com service role (e-mail real) ---- */
        case 'users.invite': return fetch(B + '/functions/v1/api', { method: 'POST', headers: H, body: JSON.stringify({ op: 'users.invite', payload: p }) }).then(this.j);
        case 'users.invites': return fetch(B + '/functions/v1/api', { method: 'POST', headers: H, body: JSON.stringify({ op: 'users.invites', payload: {} }) }).then(this.j);
        case 'users.uninvite': return fetch(B + '/functions/v1/api', { method: 'POST', headers: H, body: JSON.stringify({ op: 'users.uninvite', payload: p }) }).then(this.j);
        /* ---- LGPD: pedido de exclusão (admin; insere com service role) ---- */
        case 'account.request_deletion': return fetch(B + '/functions/v1/api', { method: 'POST', headers: H, body: JSON.stringify({ op: 'account.request_deletion', payload: {} }) }).then(this.j);
        /* ---- suporte: tickets ---- */
        case 'tickets.create':
          return fetch(B + '/rest/v1/rpc/support_create_ticket', { method: 'POST', headers: H,
            body: JSON.stringify({ p: { assunto: p.assunto, categoria: p.categoria, prioridade: p.prioridade, descricao: p.descricao } }) }).then(this.j);
        case 'tickets.list': {
          var papel = ((Store.state.session || {}).profile || {}).papel;
          /* busca server-side + paginação (dev): a fila global continua usável
             com centenas de chamados — q filtra no banco (assunto/descrição/
             solicitante/empresa) e offset pagina os mais recentes primeiro */
          var term = String(p.q || '').trim().replace(/[()*,]/g, ' ');
          var lim = Math.min(parseInt(p.limit, 10) || 200, 500);
          var off = Math.max(parseInt(p.offset, 10) || 0, 0);
          var search = term
            ? '&or=(' + ['assunto', 'descricao', 'requester_name', 'requester_email', 'tenant_name']
                .map(function (c) { return c + '.ilike.*' + encodeURIComponent(term) + '*'; })
                .join(',') + ')'
            : '';
          var qs = papel === 'dev'
            ? 'support_tickets?select=id,tenant_id,tenant_name,user_id,numero,assunto,categoria,prioridade,status,descricao,requester_name,requester_email,assignee_id,assignee_name,created_at,updated_at' + search + '&order=updated_at.desc&limit=' + lim + '&offset=' + off
            : 'support_tickets?select=id,tenant_id,tenant_name,user_id,numero,assunto,categoria,prioridade,status,descricao,requester_name,requester_email,assignee_id,assignee_name,created_at,updated_at&tenant_id=eq.' + sid + '&order=updated_at.desc';
          return fetch(B + '/rest/v1/' + qs, { headers: H }).then(self.j).then(function (rows) {
            return rows.map(function (t) {
              return { id: t.id, tenantId: t.tenant_id, userId: t.user_id, numero: t.numero, assunto: t.assunto, categoria: t.categoria, prioridade: t.prioridade, status: t.status,
                descricao: t.descricao, requesterName: t.requester_name, requesterEmail: t.requester_email, tenantName: t.tenant_name,
                assigneeId: t.assignee_id, assigneeName: t.assignee_name || '',
                createdAt: new Date(t.created_at).getTime(), updatedAt: new Date(t.updated_at).getTime() };
            });
          });
        }
        /* contadores para o badge da sidebar + banner (RPC v8, barato: 1 chamada) */
        case 'tickets.badge':
          return fetch(B + '/rest/v1/rpc/support_badge_counts', { method: 'POST', headers: H, body: JSON.stringify({}) }).then(self.j);
        /* trilha de auditoria do PRÓPRIO tenant (aba Dados & auditoria) */
        case 'audit.list':
          return fetch(B + '/rest/v1/audit_logs?select=id,user_name,acao,entidade,entidade_id,detalhes,created_at&tenant_id=eq.' + sid + '&order=created_at.desc&limit=' + Math.min(parseInt(p.limit, 10) || 60, 200), { headers: H }).then(self.j).then(function (rows) {
            return rows.map(function (a) { return { id: a.id, userName: a.user_name, acao: a.acao, detalhes: a.detalhes, at: new Date(a.created_at).getTime() }; });
          });
        /* trilha GLOBAL (somente dev — o RPC valida o papel no banco) */
        case 'audit.admin':
          return fetch(B + '/rest/v1/rpc/admin_audit_list', { method: 'POST', headers: H, body: JSON.stringify({ p_limit: Math.min(parseInt(p.limit, 10) || 100, 500) }) }).then(self.j).then(function (rows) {
            return (rows || []).map(function (a) { return { id: a.id, tenantName: a.tenantName, userName: a.userName, acao: a.acao, detalhes: a.detalhes, at: new Date(a.at).getTime() }; });
          });
        case 'tickets.messages':
          return fetch(B + '/rest/v1/ticket_messages?select=id,sender_id,sender_name,sender_role,message,tipo,created_at&ticket_id=eq.' + p.ticketId + '&order=created_at.asc', { headers: H }).then(this.j).then(function (rows) {
            return rows.map(function (m) { return { id: m.id, senderId: m.sender_id, senderName: m.sender_name, senderRole: m.sender_role, tipo: m.tipo || 'mensagem', message: m.message, at: new Date(m.created_at).getTime() }; });
          });
        case 'tickets.reply':
          return fetch(B + '/rest/v1/ticket_messages', { method: 'POST', headers: Object.assign({ Prefer: 'return=representation' }, H),
            body: JSON.stringify({ ticket_id: p.ticketId, sender_id: (Store.state.session || {}).userId, message: String(p.message || '').slice(0, 4000) }) }).then(this.j).then(function () { return { ok: true }; });
        case 'tickets.update': {
          var body = {};
          if (p.status) body.status = p.status;
          if (p.prioridade) body.prioridade = p.prioridade;
          if (p.categoria) body.categoria = p.categoria;
          /* assumir/devolver responsável (dev): null limpa — JSON.stringify ignora undefined */
          if (p.assigneeId !== undefined) body.assignee_id = p.assigneeId || null;
          return fetch(B + '/rest/v1/support_tickets?id=eq.' + p.id, { method: 'PATCH', headers: H, body: JSON.stringify(body) }).then(this.j).then(function () { return { ok: true }; });
        }
        /* ---- rascunhos de ticket (v13: banco, por usuário+chave) ---- */
        case 'draft.get':
          return fetch(B + '/rest/v1/rpc/ticket_draft_get', { method: 'POST', headers: H, body: JSON.stringify({ p_key: String(p.key || '') }) }).then(this.j).then(function (c) { return { conteudo: typeof c === 'string' ? c : null }; });
        case 'draft.save':
          return fetch(B + '/rest/v1/rpc/ticket_draft_save', { method: 'POST', headers: H, body: JSON.stringify({ p_key: String(p.key || ''), p_conteudo: String(p.conteudo || '') }) }).then(this.j).then(function () { return { ok: true }; });
        case 'draft.del':
          return fetch(B + '/rest/v1/rpc/ticket_draft_del', { method: 'POST', headers: H, body: JSON.stringify({ p_key: String(p.key || '') }) }).then(this.j).then(function () { return { ok: true }; });
        /* ---- billing: reconciliação, cancelamento e ferramentas dev ---- */
        /* retrato de billing do próprio tenant; vira trial vencido em read_only no servidor */
        case 'billing.refresh': return fetch(B + '/rest/v1/rpc/billing_refresh_status', { method: 'POST', headers: H, body: JSON.stringify({}) }).then(this.j).then(function (r) {
          /* plan_expires_at chega quando a migração v6 for aplicada (RPC atualizado) */
          if (r && r.plan_expires_at && !r.planExpiresAt) r.planExpiresAt = new Date(r.plan_expires_at).getTime();
          return r;
        });
        case 'billing.subscribe': return Promise.reject(ApiError('NOT_IMPLEMENTED', 'Use o checkout seguro (Asaas) para assinar — a ativação acontece assim que o pagamento é confirmado.'));
        /* checkout Asaas: servidor cria cliente+assinatura e devolve a URL da 1ª fatura */
        case 'billing.checkout':
          return fetch(B + '/functions/v1/api', { method: 'POST', headers: H, body: JSON.stringify({ op: 'billing.checkout', payload: { planId: p.planId, cycle: p.cycle, method: p.method } }) }).then(this.j);
        /* cancelamento pelo admin da loja — via Edge (service role), pois o guard do
           banco impede PATCH direto nas colunas de cobrança */
        case 'billing.cancel':
          return fetch(B + '/functions/v1/api', { method: 'POST', headers: H, body: JSON.stringify({ op: 'billing.cancel', payload: { reason: p.reason || '' } }) }).then(this.j).then(function (r) {
            Store.update(function (s) { s.tenant.status = 'read_only'; s.tenant.canceledAt = Date.now(); s.tenant.cancelReason = p.reason || ''; });
            Bus.emit('billing:changed');
            return r;
          });
        /* ferramentas da equipe JR (dev): retrato/ativação/suspensão de uma empresa */
        case 'billing.tenant_info':
          return fetch(B + '/functions/v1/api', { method: 'POST', headers: H, body: JSON.stringify({ op: 'billing.tenant_info', payload: { tenantId: p.tenantId } }) })
            .then(this.j).then(function (r) {
              /* plan_expires_at chega quando a migração v6 for aplicada; antes disso a UI
                 usa o prazo calculado localmente na ativação */
              if (r && r.plan_expires_at && !r.planExpiresAt) r.planExpiresAt = new Date(r.plan_expires_at).getTime();
              return r;
            });
        case 'billing.activate_plan':
          /* payload completo: o backend atual (v5) aplica ciclo 30/365 dias;
             a partir da v6 aceita days/expiresAt/reason e devolve o vencimento real.
             PIN da equipe JR (2º fator leve da v8) vai no header x-dev-pin. */
          return fetch(B + '/functions/v1/api', { method: 'POST', headers: Object.assign({}, H, self.devPinHeader()),
            body: JSON.stringify({ op: 'billing.activate_plan', payload: {
              tenantId: p.tenantId, planId: p.planId, cycle: p.cycle,
              days: p.days || null, expiresAt: p.expiresAt || null,
              reason: p.reason || '', extend: p.extend === true
            } }) }).then(self.j).then(function (r) {
              if (r && r.plan_expires_at && !r.planExpiresAt) r.planExpiresAt = new Date(r.plan_expires_at).getTime();
              return r;
            });
        case 'billing.suspend_tenant':
          return fetch(B + '/functions/v1/api', { method: 'POST', headers: Object.assign({}, H, self.devPinHeader()), body: JSON.stringify({ op: 'billing.suspend_tenant', payload: { tenantId: p.tenantId, reason: p.reason || '' } }) }).then(self.j);
        case 'billing.setPastDue': return Promise.reject(ApiError('NOT_IMPLEMENTED', 'Simulações existem apenas no modo demo.'));
        default: return Promise.reject(ApiError('NOT_IMPLEMENTED', 'Operação "' + op + '" aguardando integração.'));
      }
    }
  };

  /* ---------------- Seleção automática ---------------- */
  function selectAdapter() {
    if (Config.env === 'production') {
      /* Allow mock in production for testing if explicitly enabled via
         localStorage (lc_test_mock=1) or query string (?test=mock) */
      var forceMock = false;
      try {
        if (typeof window !== 'undefined') {
          var search = window.location.search || '';
          var lsVal = typeof localStorage !== 'undefined' ? localStorage.getItem('lc_test_mock') : '';
          forceMock = search.includes('test=mock') || lsVal === '1';
        }
      } catch (e) { }
      if (forceMock) {
        ApiClient.adapter = MockAdapter;
        AuthService.adapter = MockAuthAdapter;
      } else {
        var adapter;
        if (Config.api.baseUrl && Config.api.anonKey) adapter = SupabaseAdapter;
        else adapter = { request: function (op) { return Promise.reject(cfgError('Backend (op: ' + op + ')')); } };
        ApiClient.adapter = adapter;
        AuthService.adapter = (Config.api.baseUrl && Config.api.anonKey) ? Object.assign(Object.create(MockAuthAdapter), SupabaseAuthOverrides) : MockAuthAdapter;
        if (Config.api.baseUrl && Config.api.anonKey) ApiClient.adapter = SupabaseDataAdapter;
      }
    } else {
      ApiClient.adapter = MockAdapter;
      AuthService.adapter = MockAuthAdapter;
    }
    Bus.emit('adapter:changed', ApiClient.adapter);
    return ApiClient.adapter;
  }

  window.SupabaseAdapter = SupabaseAdapter;
  window.HttpAdapter = HttpAdapter;
  window.selectAdapter = selectAdapter;
})();
