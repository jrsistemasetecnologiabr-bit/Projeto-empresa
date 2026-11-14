/* ==========================================================================
   LojaCerta · AuthCore — autenticação completa, independente de fornecedor
   --------------------------------------------------------------------------
   Arquitetura: AuthService (fachada) → AuthAdapter.
     · MockAuthAdapter  (hoje): implementa TODA a mecânica real localmente —
       hash de senha (SHA-256 salgado + iterações, NUNCA texto puro), tokens de
       uso único com expiração (reset/confirmacao/troca de e-mail), rate-limit,
       sessões com expiração + renovação deslizante, política de senha.
     · SupabaseAuthAdapter / ClerkAuthAdapter (produção): mapeiam as MESMAS
       chamadas para o provider escolhido — nada desta lógica precisa ser
       reescrita, só trocado o adapter (ver INTEGRATIONS.md).
   Em produção o provider faz o hash real (bcrypt/argon2) e emite os tokens;
   o MockAuth existe para que NENHUMA senha em texto puro exista nem na demo.
   ========================================================================== */
;(function () {
  'use strict';

  /* ---------------- SHA-256 puro (sync, sem dependências) ---------------- */
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256Bytes(bytes) {
    var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var bitLen = bytes.length * 8;
    var padded = new Uint8Array(Math.max(64, Math.ceil((bytes.length + 9) / 64) * 64));
    padded.set(bytes); padded[bytes.length] = 0x80;
    var dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296));
    dv.setUint32(padded.length - 4, bitLen >>> 0);
    var w = new Uint32Array(64);
    for (var i = 0; i < padded.length; i += 64) {
      for (var j = 0; j < 16; j++) w[j] = (padded[i + j * 4] << 24) | (padded[i + j * 4 + 1] << 16) | (padded[i + j * 4 + 2] << 8) | padded[i + j * 4 + 3];
      for (j = 16; j < 64; j++) {
        var s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
        var s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (j = 0; j < 64; j++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H = [(H[0]+a)>>>0,(H[1]+b)>>>0,(H[2]+c)>>>0,(H[3]+d)>>>0,(H[4]+e)>>>0,(H[5]+f)>>>0,(H[6]+g)>>>0,(H[7]+h)>>>0];
    }
    return H.map(function (x) { return x.toString(16).padStart(8, '0'); }).join('');
  }
  function utf8(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    var out = [], esc = unescape(encodeURIComponent(s));
    for (var i = 0; i < esc.length; i++) out.push(esc.charCodeAt(i));
    return new Uint8Array(out);
  }
  function sha256(s) { return sha256Bytes(utf8(s)); }
  /* KDF demonstrativa: salt + 2500 iterações. Produção: bcrypt/argon2 do provider. */
  function hashPassword(password, salt) {
    var h = sha256(salt + '::' + password);
    for (var i = 0; i < 2500; i++) h = sha256(h + salt);
    return h;
  }
  function randomToken(bytes) {
    var arr = new Uint8Array(bytes || 24);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(arr);
    else for (var i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(arr, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /* ---------------- Política de senha ---------------- */
  var PASSWORD_RULES = { min: 8, upper: true, lower: true, digit: true };
  function passwordIssues(pw) {
    var issues = [];
    if (!pw || pw.length < PASSWORD_RULES.min) issues.push('mínimo de ' + PASSWORD_RULES.min + ' caracteres');
    if (PASSWORD_RULES.upper && !/[A-Z]/.test(pw)) issues.push('uma letra maiúscula');
    if (PASSWORD_RULES.lower && !/[a-z]/.test(pw)) issues.push('uma letra minúscula');
    if (PASSWORD_RULES.digit && !/\d/.test(pw)) issues.push('um número');
    return issues;
  }

  /* ---------------- Constantes de sessão/tokens ---------------- */
  var SESSION_MS = 60 * 60 * 1000;            // 1h de acesso
  var REFRESH_WINDOW_MS = 30 * 24 * 3600 * 1000; // 30d p/ renovar sem novo login
  var TOKEN_TTL_MS = 60 * 60 * 1000;          // tokens de reset/confirmação: 1h
  var CONFIRM_TTL_MS = 10 * 60 * 1000;        // código de confirmação de e-mail: 10 min (idem produção)
  var CONFIRM_MAX_TRIES = 5;                  // erros de código antes de invalidar
  var RATE = { maxFails: 5, windowMs: 15 * 60 * 1000, resetsPerHour: 3 };

  function authState() {
    var s = Store.state;
    if (!s.auth) s.auth = { accounts: [], tokens: [], throttle: {}, webhookEvents: [], subEvents: [], signups: [] };
    if (!s.auth.signups) s.auth.signups = [];
    return s.auth;
  }
  function accountByEmail(email) {
    return authState().accounts.filter(function (a) { return a.email === String(email || '').trim().toLowerCase(); })[0] || null;
  }
  function accountByUserId(id) {
    return authState().accounts.filter(function (a) { return a.userId === id; })[0] || null;
  }
  function rateCheck(key, bucket, max) {
    var th = authState().throttle;
    var now = Date.now();
    th[key] = (th[key] || []).filter(function (t) { return now - t < bucket; });
    if (th[key].length >= max) return false;
    th[key].push(now);
    return true;
  }
  /* consulta sem incrementar (para bloquear antes de tentar) */
  function rateBlocked(key, bucket, max) {
    var th = authState().throttle;
    var now = Date.now();
    th[key] = (th[key] || []).filter(function (t) { return now - t < bucket; });
    return th[key].length >= max;
  }
  /* registra uma falha (login com senha errada) */
  function rateFail(key) {
    var th = authState().throttle;
    (th[key] = th[key] || []).push(Date.now());
  }
  function createToken(kind, email, payload, ttlMs) {
    var t = { id: randomToken(16), kind: kind, email: email, payload: payload || null, code: String(Math.floor(100000 + Math.random() * 900000)), tries: 0, createdAt: Date.now(), expiresAt: Date.now() + (ttlMs || TOKEN_TTL_MS), usedAt: null };
    authState().tokens.push(t);
    return t;
  }
  function consumeToken(kind, tokenStr) {
    var t = authState().tokens.filter(function (x) { return x.id === tokenStr && x.kind === kind; })[0];
    if (!t) throw ApiError('TOKEN_INVALID', 'Link inválido. Verifique se copiou o link completo ou solicite um novo.');
    if (t.usedAt) throw ApiError('TOKEN_USED', 'Este link já foi utilizado. Solicite um novo se precisar.');
    if (Date.now() > t.expiresAt) throw ApiError('TOKEN_EXPIRED', 'Este link expirou por segurança. Solicite um novo.');
    t.usedAt = Date.now();
    return t;
  }

  /* ---------------- MockAuthAdapter (mecânica real, local) ---------------- */
  var MockAuthAdapter = {
    id: 'mock',
    signup: function (d) {
      if (accountByEmail(d.email)) throw ApiError('EMAIL_EXISTS', 'Já existe uma conta com este e-mail. Tente entrar ou recuperar a senha.');
      /* Anti-abuso do teste grátis (espelho da regra de produção — Edge Function +
         RPC signup_begin): o "IP" do modo local é este navegador; o identificador
         de dispositivo é o cookie lc_did. Contas demo pré-semeadas não contam. */
      var trial = Config.trial || { ipLimit: 1, deviceLimit: 1 };
      var used = authState().signups.filter(function (x) { return x.trial; });
      var devId = U.deviceId();
      var usedDev = used.filter(function (x) { return x.deviceId === devId; });
      if (used.length >= trial.ipLimit || (devId && usedDev.length >= trial.deviceLimit)) {
        throw ApiError('TRIAL_LIMIT',
          'Já existe uma conta usando o teste grátis neste navegador. ' +
          'Para criar outra conta, é necessário contratar o plano pago. ' +
          'Se for um caso legítimo (ex.: outra loja), fale com o suporte.');
      }
      var seg = Seed.freshTenant(d.storeName, d.name, d.email, null, d.segment);
      Store.reset(seg);
      Store.state.session = { userId: null };
      var salt = randomToken(8);
      var acc = { id: 'acc_' + randomToken(6), userId: seg.session.userId || seg.users[0] && null, email: String(d.email).toLowerCase(), passHash: hashPassword(d.password, salt), salt: salt, confirmed: false, createdAt: Date.now() };
      // o tenant foi criado sem sessão: vincula ao primeiro usuário (admin criado pelo seed)
      acc.userId = Store.state.users[0] ? Store.state.users[0].id : null;
      authState().accounts.push(acc);
      authState().signups.push({ email: String(d.email).toLowerCase(), ip: 'local', deviceId: devId, trial: true, at: Date.now() });
      var t = createToken('confirm', acc.email, null, CONFIRM_TTL_MS);
      EmailService.send('confirm_email', acc.email, { nome: d.name, token: t.id, code: t.code });
      Store.state.audit.unshift({ id: 'a' + Store.state.seq.aud++, at: Date.now(), userId: acc.userId, userName: d.name, acao: 'conta.criada', entidade: 'tenant', entidadeId: Store.state.tenant.id, detalhes: 'aguardando confirmação de e-mail (trial pendente)' });
      Store.persist();
      if (Config.requireEmailConfirm) return { needsConfirmation: true };
      /* sem confirmação obrigatória (autoconfirm): trial vale desde já */
      Store.state.tenant.trialEndsAt = U.addDays(Date.now(), 14).toISOString();
      return this.login({ email: acc.email, password: d.password });
    },
    login: function (d) {
      var email = String(d.email || '').trim().toLowerCase();
      /* rate-limit conta apenas FALHAS (login certo nunca bloqueia a conta) */
      if (rateBlocked('login:' + email, RATE.windowMs, RATE.maxFails)) throw ApiError('RATE_LIMITED', 'Muitas tentativas. Aguarde 15 minutos e tente novamente.');
      var acc = accountByEmail(email);
      if (!acc || hashPassword(d.password, acc.salt) !== acc.passHash) {
        rateFail('login:' + email);
        throw ApiError('BAD_CREDENTIALS', 'E-mail ou senha incorretos.');
      }
      var user = Store.state.users.filter(function (u) { return u.id === acc.userId; })[0];
      if (!user || !user.ativo) throw ApiError('UNAUTHORIZED', 'Usuário inativo. Fale com o administrador da loja.');
      /* espelho do GoTrue com "Confirm email" ligado: sem confirmar, não entra */
      if (Config.requireEmailConfirm && !acc.confirmed)
        throw ApiError('EMAIL_NOT_CONFIRMED', 'Confirme seu e-mail antes de entrar — enviamos um código de 6 dígitos (válido por 10 minutos).');
      var now = Date.now();
      Store.state.session = { userId: user.id, token: randomToken(24), issuedAt: now, expiresAt: now + SESSION_MS, refreshUntil: now + REFRESH_WINDOW_MS };
      Store.persist();
      EmailService.send('security_login', acc.email, { nome: user.nome, quando: U.dt(now) });
      return { userId: user.id };
    },
    logout: function () { Store.state.session = { userId: null }; Store.persist(); return { ok: true }; },
    /* renovação deslizante: chama a cada navegação/operação */
    touch: function () {
      var s = Store.state.session;
      if (!s || !s.token) return { state: 'anon' };
      var now = Date.now();
      if (now <= s.expiresAt) return { state: 'ok' };
      if (now <= s.refreshUntil) {
        s.expiresAt = now + SESSION_MS; s.refreshUntil = now + REFRESH_WINDOW_MS; Store.persist();
        return { state: 'refreshed' };
      }
      Store.state.session = { userId: null }; Store.persist();
      return { state: 'expired' };
    },
    /* renovação EXPLÍCITA (botão "Renovar sessão"): estende já, sem esperar expirar */
    renew: function () {
      var s = Store.state.session;
      if (!s || !s.token) throw ApiError('UNAUTHORIZED', 'Sessão expirada. Entre novamente.');
      var now = Date.now();
      s.expiresAt = now + SESSION_MS;
      s.refreshUntil = now + REFRESH_WINDOW_MS;
      Store.persist();
      return { state: 'renewed', expiresAt: s.expiresAt, refreshUntil: s.refreshUntil };
    },
    verifyPassword: function (userId, password) {
      var acc = accountByUserId(userId);
      return !!acc && hashPassword(password, acc.salt) === acc.passHash;
    },
    requestPasswordReset: function (email) {
      var em = String(email || '').trim().toLowerCase();
      if (!rateCheck('reset:' + em, 3600 * 1000, RATE.resetsPerHour)) throw ApiError('RATE_LIMITED', 'Muitas solicitações de recuperação. Aguarde 1 hora.');
      var acc = accountByEmail(em);
      if (!acc) throw ApiError('NOT_FOUND', 'Não encontramos uma conta com este e-mail.');
      var t = createToken('reset', em);
      EmailService.send('password_reset', em, { token: t.id });
      return { sent: true, devToken: Config.env !== 'production' ? t.id : null };
    },
    resetPassword: function (d) {
      var issues = passwordIssues(d.password);
      if (issues.length) throw ApiError('WEAK_PASSWORD', 'Senha fraca. Falta: ' + issues.join(', ') + '.');
      if (d.password !== d.confirm) throw ApiError('PASSWORD_MISMATCH', 'As senhas não conferem.');
      var t = consumeToken('reset', d.token);
      var acc = accountByEmail(t.email);
      acc.salt = randomToken(8);
      acc.passHash = hashPassword(d.password, acc.salt);
      acc.confirmed = true; // quem resetou provou posse do e-mail
      Store.state.session = { userId: null }; // derruba outras sessões
      Store.persist();
      EmailService.send('password_changed', t.email, {});
      return { ok: true };
    },
    resendConfirmation: function (email) {
      var acc = accountByEmail(email);
      if (!acc) throw ApiError('NOT_FOUND', 'Conta não encontrada.');
      if (acc.confirmed) throw ApiError('ALREADY', 'Este e-mail já está confirmado.');
      if (!rateCheck('resend:' + String(email).toLowerCase(), 10 * 60 * 1000, 3)) throw ApiError('RATE_LIMITED', 'Muitos reenvios. Aguarde alguns minutos.');
      var t = createToken('confirm', acc.email, null, CONFIRM_TTL_MS);
      EmailService.send('confirm_email', acc.email, { nome: '', token: t.id, code: t.code });
      return { sent: true, devToken: Config.env !== 'production' ? t.id : null, devCode: Config.env !== 'production' ? t.code : null };
    },
    confirmEmail: function (tokenStr) {
      var t = consumeToken('confirm', tokenStr);
      var acc = accountByEmail(t.email);
      acc.confirmed = true;
      /* mesmo no caminho por link: o teste grátis começa na confirmação */
      if (Store.state.tenant && Store.state.tenant.trialEndsAt) {
        Store.state.tenant.trialEndsAt = U.addDays(Date.now(), 14).toISOString();
      }
      Store.persist();
      EmailService.send('welcome', t.email, { nome: '' });
      return { ok: true, email: t.email };
    },
    requestEmailChange: function (d) {
      var user = Auth.me();
      if (!user) throw ApiError('UNAUTHORIZED', 'Sessão expirada.');
      if (!this.verifyPassword(user.id, d.password)) throw ApiError('BAD_CREDENTIALS', 'Senha atual incorreta.');
      var newEmail = String(d.newEmail || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(newEmail)) throw ApiError('INVALID_EMAIL', 'E-mail novo inválido.');
      if (accountByEmail(newEmail)) throw ApiError('EMAIL_EXISTS', 'Este e-mail já está em uso por outra conta.');
      var acc = accountByUserId(user.id);
      var t = createToken('emailchange', newEmail, { userId: user.id, oldEmail: acc.email });
      EmailService.send('email_change_confirm', newEmail, { token: t.id });
      EmailService.send('security_alert', acc.email, { motivo: 'alteração de e-mail solicitada' });
      return { sent: true, devToken: Config.env !== 'production' ? t.id : null };
    },
    confirmEmailChange: function (tokenStr) {
      var t = consumeToken('emailchange', tokenStr);
      var acc = accountByUserId(t.payload.userId);
      var user = Store.state.users.filter(function (u) { return u.id === t.payload.userId; })[0];
      acc.email = t.email;
      if (user) user.email = t.email;
      Store.persist();
      EmailService.send('security_alert', t.email, { motivo: 'e-mail da conta alterado com sucesso' });
      return { ok: true };
    },
    changePassword: function (d) {
      var user = Auth.me();
      if (!user) throw ApiError('UNAUTHORIZED', 'Sessão expirada.');
      if (!this.verifyPassword(user.id, d.current)) throw ApiError('BAD_CREDENTIALS', 'Senha atual incorreta.');
      var issues = passwordIssues(d.next);
      if (issues.length) throw ApiError('WEAK_PASSWORD', 'Senha fraca. Falta: ' + issues.join(', ') + '.');
      if (d.next !== d.confirm) throw ApiError('PASSWORD_MISMATCH', 'As senhas não conferem.');
      var acc = accountByUserId(user.id);
      acc.salt = randomToken(8);
      acc.passHash = hashPassword(d.next, acc.salt);
      Store.persist();
      EmailService.send('password_changed', acc.email, {});
      return { ok: true };
    },
    requestAccountDeletion: function (password) {
      var user = Auth.me();
      if (!user) throw ApiError('UNAUTHORIZED', 'Sessão expirada.');
      if (!this.verifyPassword(user.id, password)) throw ApiError('BAD_CREDENTIALS', 'Senha incorreta.');
      Store.state.tenant.deletionRequestedAt = Date.now();
      Store.persist();
      var acc = accountByUserId(user.id);
      EmailService.send('security_alert', acc.email, { motivo: 'exclusão de conta solicitada (carência de 30 dias)' });
      return { ok: true, graceUntil: Date.now() + 30 * 864e5 };
    },
    confirmWithCode: function (d) {
      var em = String(d.email || '').trim().toLowerCase();
      var code = String(d.code || '').trim();
      /* pode haver mais de um código ativo (reenvio): prefere o que casa com o
         código digitado; senão valida contra o mais recente */
      var live = authState().tokens.filter(function (x) { return x.kind === 'confirm' && x.email === em && !x.usedAt && Date.now() <= x.expiresAt; });
      var t = live.filter(function (x) { return x.code === code; })[0] || live[live.length - 1];
      if (!t) throw ApiError('TOKEN_EXPIRED', 'Código expirado ou inválido. Solicite um novo abaixo.');
      if (code !== t.code) {
        t.tries = (t.tries || 0) + 1;
        /* limite de tentativas: esgotam as chances → invalida o código atual */
        if (t.tries >= CONFIRM_MAX_TRIES) {
          t.usedAt = Date.now();
          Store.persist();
          throw ApiError('TOKEN_INVALID', 'Muitas tentativas com código errado. Solicite um novo abaixo.');
        }
        Store.persist();
        throw ApiError('TOKEN_INVALID', 'Código inválido — restam ' + (CONFIRM_MAX_TRIES - t.tries) + ' tentativa(s). Confira o e-mail ou reenvie.');
      }
      if (t.usedAt) throw ApiError('TOKEN_USED', 'Este código já foi utilizado.');
      t.usedAt = Date.now();
      var acc = accountByEmail(em);
      acc.confirmed = true;
      var now = Date.now();
      /* o teste grátis começa AGORA (na confirmação), não no cadastro */
      Store.state.tenant.trialEndsAt = U.addDays(now, 14).toISOString();
      Store.state.session = { userId: acc.userId, token: randomToken(24), issuedAt: now, expiresAt: now + SESSION_MS, refreshUntil: now + REFRESH_WINDOW_MS };
      Store.state.audit.unshift({ id: 'a' + Store.state.seq.aud++, at: now, userId: acc.userId, userName: (Auth.me() || {}).nome || '', acao: 'email.confirmado', entidade: 'user', entidadeId: acc.userId, detalhes: 'teste grátis de 14 dias iniciado' });
      Store.persist();
      EmailService.send('welcome', em, { nome: '' });
      return { userId: acc.userId };
    },
    sessionInfo: function () {
      var s = Store.state.session;
      if (!s || !s.token) return null;
      return { expiresAt: s.expiresAt, refreshUntil: s.refreshUntil };
    }
  };

  /* ---------------- AuthService (fachada estável p/ UI e testes) ---------------- */
  var AuthService = {
    adapter: MockAuthAdapter,
    call: function (fn, arg) {
      try { return Promise.resolve(this.adapter[fn](arg || {})); }
      catch (e) { return Promise.reject(e); }
    },
    signup: function (d) { return this.call('signup', d); },
    login: function (email, password) { return this.call('login', { email: email, password: password }); },
    logout: function () { return this.call('logout'); },
    touch: function () { try { return this.adapter.touch(); } catch (e) { return { state: 'ok' }; } },
    /* Renovação explícita da sessão (botão da tela Conta & senha).
       Retorna Promise com o novo prazo real — a UI mostra o valor verdadeiro. */
    renew: function () {
      try { return Promise.resolve(this.adapter.renew()); }
      catch (e) { return Promise.reject(e); }
    },
    verifyPassword: function (userId, pw) { return this.adapter.verifyPassword(userId, pw); },
    requestPasswordReset: function (email) { return this.call('requestPasswordReset', email); },
    resetPassword: function (d) { return this.call('resetPassword', d); },
    resendConfirmation: function (email) { return this.call('resendConfirmation', email); },
    confirmEmail: function (token) { return this.call('confirmEmail', token); },
    confirmWithCode: function (email, code) { return this.call('confirmWithCode', { email: email, code: code }); },
    resendCode: function (email) { return this.call('resendConfirmation', email); },
    requestEmailChange: function (d) { return this.call('requestEmailChange', d); },
    confirmEmailChange: function (token) { return this.call('confirmEmailChange', token); },
    changePassword: function (d) { return this.call('changePassword', d); },
    requestAccountDeletion: function (pw) { return this.call('requestAccountDeletion', pw); },
    sessionInfo: function () { return this.adapter.sessionInfo(); },
    passwordIssues: passwordIssues,
    isConfirmed: function (email) { var a = accountByEmail(email); return !!(a && a.confirmed); }
  };

  window.MockAuthAdapter = MockAuthAdapter;
  window.SHA256 = sha256; // exposto p/ teste de vetor conhecido
  window.hashPassword = hashPassword;
  window.AuthCore = {
    MockAuthAdapter: MockAuthAdapter, PASSWORD_RULES: PASSWORD_RULES, SESSION_MS: SESSION_MS, TOKEN_TTL_MS: TOKEN_TTL_MS,
    CONFIRM_TTL_MS: CONFIRM_TTL_MS, CONFIRM_MAX_TRIES: CONFIRM_MAX_TRIES,
    /* leitura SEM consumo — para a UI validar o link antes de renderizar o form */
    tokenStatus: function (kind, tokenStr) {
      var t = authState().tokens.filter(function (x) { return x.id === tokenStr && x.kind === kind; })[0];
      if (!t) return 'invalid';
      if (t.usedAt) return 'used';
      if (Date.now() > t.expiresAt) return 'expired';
      return 'valid';
    }
  };
  window.AuthService = AuthService;
})();
