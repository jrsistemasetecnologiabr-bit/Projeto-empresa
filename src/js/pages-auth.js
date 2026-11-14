/* ==========================================================================
   LojaCerta · Pages de Autenticação & Conta
   Rotas: /recuperar · /redefinir · /confirmar-email  +  painel Conta/Emails-dev
   Todos os estados: loading, erro (token inválido/expirado/usado, senha fraca,
   senhas diferentes, rate-limit, usuário inexistente), sucesso e navegação.
   ========================================================================== */
;(function () {
  'use strict';
  window.AuthViews = window.AuthViews || {};
  window.AccountViews = window.AccountViews || {};

  function authLogo() {
    return raw('<a class="brand" href="#/" style="pointer-events:auto"><svg class="brand-mark" viewBox="0 0 32 32" width="34" height="34" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0B1220"/><path d="M10 12h12l-1.1 11a2 2 0 0 1-2 1.8h-7.8a2 2 0 0 1-2-1.8L10 12z" fill="#EA580C"/><path d="M13 12v-2a3 3 0 0 1 6 0v2" stroke="#FDBA74" stroke-width="2" fill="none" stroke-linecap="round"/><path d="m12.6 18.4 2.3 2.3 4.5-4.9" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="brand-name">Loja<b>Certa</b></span></a>');
  }
  function shell(title, sub, bodyFrag) {
    return html`<div class="auth-wrap"><div class="auth-card">
      <div class="auth-logo">${authLogo()}</div>
      <h1>${title}</h1><p class="auth-sub">${sub}</p>
      ${bodyFrag}
    </div></div>`;
  }
  function errBox(code, fallback) {
    var M = {
      NOT_FOUND: 'Não encontramos uma conta com este e-mail.',
      INVALID_EMAIL: 'Informe um e-mail válido.',
      RATE_LIMITED: 'Muitas tentativas. Por segurança, aguarde alguns minutos.',
      TOKEN_INVALID: 'Este link é inválido. Verifique se copiou o link completo.',
      TOKEN_EXPIRED: 'Este link expirou por segurança. Solicite um novo abaixo.',
      TOKEN_USED: 'Este link já foi utilizado. Solicite um novo abaixo.',
      WEAK_PASSWORD: 'Senha fraca — veja os requisitos abaixo.',
      PASSWORD_MISMATCH: 'As senhas digitadas não conferem.',
      BAD_CREDENTIALS: 'Senha atual incorreta.',
      EMAIL_EXISTS: 'Este e-mail já está em uso.',
      EMAIL_SEND: 'Não conseguimos enviar o e-mail agora (limite do provedor). Tente novamente em alguns minutos.',
      EMAIL_NOT_CONFIRMED: 'Confirme seu e-mail antes de entrar — use o código de 6 dígitos que enviamos.',
      TRIAL_LIMIT: 'Já existe uma conta usando o teste grátis nesta rede/navegador. Para criar outra conta, contrate o plano pago.',
      SERVICE: 'Serviço temporariamente indisponível. Tente novamente em instantes.'
    };
    return html`<div class="auth-note" style="border-color:var(--danger-line);background:var(--danger-bg);color:var(--danger)">${raw(I('alert', 15))}<span>${M[code] || fallback || M.SERVICE}</span></div>`;
  }
  function strengthUi() {
    return html`<div class="pw-meter" id="pw-meter" data-s="0" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="pw-label" id="pw-label">Mínimo 8 caracteres, com maiúscula, minúscula e número</div>`;
  }
  function bindStrength(input, meterId, labelId) {
    input.addEventListener('input', function () {
      var s = Validate.passwordStrength(input.value);
      var m = document.getElementById(meterId), l = document.getElementById(labelId);
      if (m) m.dataset.s = String(s);
      if (l) l.textContent = input.value ? ('Força: ' + ['muito fraca', 'fraca', 'razoável', 'boa', 'excelente'][s]) : 'Mínimo 8 caracteres, com maiúscula, minúscula e número';
    });
  }

  /* ---------------- ESQUECI MINHA SENHA ---------------- */
  AuthViews.recuperar = {
    render: function () {
      return shell('Esqueci minha senha', 'Informe o e-mail da sua conta. Enviaremos um link de uso único, válido por 1 hora.', html`
        <div id="rec-stage">
          <form id="rec-form" novalidate>
            <div class="field"><label for="rec-email">E-mail <span class="req">*</span></label>
              <input class="input" id="rec-email" name="email" type="email" autocomplete="email" placeholder="voce@sualoja.com.br" data-autofocus></div>
            <div id="rec-err"></div>
            <button class="btn btn-primary btn-block btn-lg" type="submit" id="rec-btn">${raw(I('mail', 16))} Enviar link de recuperação</button>
          </form>
        </div>
        <p class="auth-foot">Lembrou a senha? <a href="#/entrar">Voltar para o login</a></p>`);
    },
    mounted: function (root) {
      var form = root.querySelector('#rec-form');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var email = form.elements.email.value.trim();
        var errEl = root.querySelector('#rec-err'), btn = root.querySelector('#rec-btn');
        errEl.innerHTML = '';
        if (!email) { mount(errEl, errBox('INVALID_EMAIL')); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { mount(errEl, errBox('INVALID_EMAIL')); return; }
        UI.busy(btn, true);
        AuthService.requestPasswordReset(email).then(function (r) {
          UI.busy(btn, false);
          mount(root.querySelector('#rec-stage'), html`
            <div class="auth-note" style="border-color:var(--ok-line);background:var(--ok-bg);color:var(--ok)">${raw(I('check-circle', 15))}
              <span><b>Solicitação enviada!</b> Se existir uma conta para <b>${email}</b>, o link de redefinição chega em instantes no seu e-mail.</span></div>
            ${r.devToken ? html`<div class="auth-note mt-3">${raw(I('info', 15))}<span>${Config.env === 'demo' ? '<b>Caixa de saída local (dev):</b> nenhum provedor de e-mail está conectado, então o link aparece aqui — em produção ele chega por e-mail.' : '<b>Provedor de e-mail ainda não conectado:</b> o link de redefinição fica disponível aqui e na aba Configurações → Fila de e-mails.'}<br><a href="#/redefinir?token=${r.devToken}">Abrir link de redefinição</a></span></div>` : ''}
            <p class="auth-foot mt-3"><a href="#/entrar">Voltar para o login</a> · <a href="#/recuperar">Reenviar</a></p>`);
        }).catch(function (err) {
          UI.busy(btn, false);
          mount(errEl, errBox(err && err.code ? err.code : 'SERVICE'));
          if (err && err.code && err.code !== 'NOT_FOUND' && err.code !== 'RATE_LIMITED' && err.code !== 'EMAIL_SEND') UI.toast(err.message, { type: 'err' });
        });
      });
    }
  };

  /* ---------------- REDEFINIR SENHA ---------------- */
  AuthViews.redefinir = {
    render: function (params, query) {
      var token = (query && query.token) || '';
      var status = Config.env === 'production' ? 'valid' : (token ? AuthCore.tokenStatus('reset', token) : 'invalid');
      if (status !== 'valid') {
        return shell('Redefinir senha', 'O link não pode ser usado.', html`
          ${errBox(status === 'expired' ? 'TOKEN_EXPIRED' : status === 'used' ? 'TOKEN_USED' : 'TOKEN_INVALID')}
          <p class="auth-foot"><a href="#/recuperar">Solicitar um novo link</a> · <a href="#/entrar">Voltar ao login</a></p>`);
      }
      return shell('Redefinir senha', 'Crie uma nova senha forte para a sua conta.', html`
        <form id="rdf-form" novalidate>
          <div class="field"><label for="rdf-pw">Nova senha <span class="req">*</span></label>
            <input class="input" id="rdf-pw" name="pw" type="password" autocomplete="new-password" data-autofocus>${strengthUi()}</div>
          <div class="field"><label for="rdf-pw2">Confirmar nova senha <span class="req">*</span></label>
            <input class="input" id="rdf-pw2" name="pw2" type="password" autocomplete="new-password"></div>
          <div id="rdf-err"></div>
          <button class="btn btn-primary btn-block btn-lg" type="submit" id="rdf-btn">${raw(I('lock', 16))} Redefinir senha</button>
        </form>
        <p class="auth-foot">Depois disso você volta ao login com a senha nova.</p>`);
    },
    mounted: function (root, params, query) {
      var form = root.querySelector('#rdf-form');
      if (!form) return;
      /* Produção: o link de recuperação do Supabase chega com os tokens na HASH
         (#access_token=...&token_type=bearer&type=recovery). Capturamos e limpamos a URL.
         NOTA: o regex de type exige fronteira (&|#) para não casar "token_type=". */
      var h = location.hash || '';
      var at = h.match(/access_token=([^&]+)/), rt = h.match(/refresh_token=([^&]+)/), ty = h.match(/(?:^|[?&#])type=([^&]+)/);
      if (at && ty && ty[1] === 'recovery') {
        window.__recoveryToken = decodeURIComponent(at[1]);
        window.__recoveryRefresh = rt ? decodeURIComponent(rt[1]) : null;
        history.replaceState(null, '', location.pathname + location.search + '#/redefinir');
      }
      bindStrength(form.elements.pw, 'pw-meter', 'pw-label');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var errEl = root.querySelector('#rdf-err'), btn = root.querySelector('#rdf-btn');
        errEl.innerHTML = '';
        var pw = form.elements.pw.value, pw2 = form.elements.pw2.value;
        var issues = AuthService.passwordIssues(pw);
        if (issues.length) { mount(errEl, errBox('WEAK_PASSWORD')); return; }
        if (pw !== pw2) { mount(errEl, errBox('PASSWORD_MISMATCH')); return; }
        UI.busy(btn, true);
        AuthService.resetPassword({ token: window.__recoveryToken || ((query && query.token) || ''), password: pw, confirm: pw2 }).then(function () {
          UI.busy(btn, false);
          UI.toast('Senha redefinida com sucesso! Entre com a nova senha.', { type: 'ok', timeout: 5200 });
          Router.go('/entrar');
        }).catch(function (err) {
          UI.busy(btn, false);
          if (err.code === 'TOKEN_INVALID' || err.code === 'TOKEN_EXPIRED' || err.code === 'TOKEN_USED') {
            mount(root.querySelector('.auth-card'), html`<div class="auth-logo">${authLogo()}</div><h1>Redefinir senha</h1><p class="auth-sub">O link não pode ser usado.</p>
              ${errBox(err.code)}<p class="auth-foot"><a href="#/recuperar">Solicitar um novo link</a></p>`);
          } else mount(errEl, errBox(err.code));
        });
      });
    }
  };

  /* ---------------- CONFIRMAR E-MAIL / TROCA DE E-MAIL ---------------- */
  AuthViews.confirmarEmail = {
    render: function (params, query) {
      var tipo = (query && query.tipo) === 'mudanca' ? 'emailchange' : 'confirm';
      var token = (query && query.token) || '';
      return shell(tipo === 'mudanca' ? 'Confirmar novo e-mail' : 'Confirmar e-mail', 'Verificando seu link com segurança…', html`
        <div id="cf-stage" class="center" style="padding:18px 0"><span class="spinner spinner-dark" style="width:26px;height:26px;margin:0 auto"></span><p class="muted small mt-3">Validando token…</p></div>`);
    },
    mounted: function (root, params, query) {
      var tipo = (query && query.tipo) === 'mudanca' ? 'emailchange' : 'confirm';
      var token = (query && query.token) || ((location.hash || '').match(/[?&]token=([^&]+)/) || [])[1] || '';
      var stage = root.querySelector('#cf-stage');
      if (Config.env === 'production' && tipo === 'confirm') {
        if (!token) {
          mount(stage, html`<div class="auth-note" style="border-color:var(--info-line);background:var(--info-bg);color:var(--info)">${raw(I('mail', 15))}<span>Abra o link de confirmação que enviamos para o seu e-mail. Ao confirmar, você volta aqui automaticamente.</span></div>
            <p class="auth-foot mt-3"><a href="#/entrar">Ir para o login</a></p>`);
          return;
        }
        fetch(Config.api.baseUrl + '/auth/v1/verify', { method: 'POST',
          headers: { apikey: Config.api.anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'signup', token: token }) })
          .then(function (r) { return r.json().then(function (jj) { return { ok: r.ok, jj: jj }; }); })
          .then(function (res) {
            mount(stage, (res.ok || (res.jj && (res.jj.access_token || res.jj.user)))
              ? html`<div class="auth-note" style="border-color:var(--ok-line);background:var(--ok-bg);color:var(--ok)">${raw(I('check-circle', 15))}<span><b>E-mail confirmado!</b> Você já pode entrar com sua senha.</span></div><p class="auth-foot mt-3"><a href="#/entrar">Ir para o login</a></p>`
              : html`${errBox('TOKEN_INVALID')}<p class="auth-foot mt-3"><a href="#/entrar">Voltar ao login</a></p>`);
          })
          .catch(function () { mount(stage, errBox('SERVICE')); });
        return;
      }
      var call = tipo === 'mudanca' ? AuthService.confirmEmailChange(token) : AuthService.confirmEmail(token);
      call.then(function () {
        mount(stage, html`<div class="auth-note" style="border-color:var(--ok-line);background:var(--ok-bg);color:var(--ok)">${raw(I('check-circle', 15))}
          <span><b>E-mail confirmado com sucesso!</b>${tipo === 'mudanca' ? ' Sua conta agora acessa com o novo e-mail.' : ' Sua conta está ativa.'}</span></div>
          <p class="auth-foot mt-3"><a href="#/entrar">Ir para o login</a></p>`);
      }).catch(function (err) {
        mount(stage, html`${errBox(err.code === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : err.code === 'TOKEN_USED' ? 'TOKEN_USED' : 'TOKEN_INVALID')}
          <p class="auth-foot mt-3"><a href="#/recuperar">Preciso de um novo link</a> · <a href="#/entrar">Voltar ao login</a></p>`);
      });
    }
  };

  AuthViews.confirmarCodigo = {
    title: 'Confirmar e-mail',
    render: function (params, query) {
      return shell('Confirme seu e-mail', 'Abra o e-mail que enviamos e clique no link de confirmação. Se o e-mail trouxer um código de 6 dígitos, você também pode digitá-lo abaixo.', html`
        <form id="cc-form" novalidate>
          <div class="field"><label for="cc-email">E-mail</label><input class="input" id="cc-email" name="email" type="email" value="${(query && query.email) || ''}"></div>
          <div class="field"><label for="cc-code">Código de 6 dígitos <span class="req">*</span></label>
            <input class="input mono" id="cc-code" name="code" inputmode="numeric" maxlength="6" placeholder="000000" style="text-align:center;font-size:22px;letter-spacing:8px" data-autofocus></div>
          <div id="cc-err"></div>
          <button class="btn btn-primary btn-block btn-lg" type="submit" id="cc-btn">Confirmar e entrar</button>
          <p class="auth-foot mt-3"><a href="#" id="cc-resend">Reenviar e-mail de confirmação</a> · <a href="#/entrar">Voltar ao login</a></p>
          ${Config.env === 'demo' ? html`<div class="auth-note mt-3">${raw(I('info', 15))}<span>Dev: o código fica em Configurações → Fila de e-mails (e aparece num toast ao reenviar).</span></div>` : ''}
        </form>`);
    },
    mounted: function (root, params, query) {
      var form = root.querySelector('#cc-form');
      if (!form) return;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var err = root.querySelector('#cc-err'); err.innerHTML = '';
        var email = form.elements.email.value, code = form.elements.code.value.trim();
        if (!/^\d{6}$/.test(code)) { mount(err, errBox('TOKEN_INVALID')); return; }
        var btn = root.querySelector('#cc-btn'); UI.busy(btn, true);
        AuthService.confirmWithCode(email, code).then(function () {
          UI.busy(btn, false);
          UI.toast('E-mail confirmado! Bem-vindo(a).', { type: 'ok', timeout: 5000 });
          Router.go('/app');
        }).catch(function (e2) {
          UI.busy(btn, false);
          /* mensagem específica do domínio (tentativas restantes, código expirado…) —
             melhor que o texto genérico de "link" do errBox */
          var msg = (e2 && e2.message) || '';
          mount(err, msg
            ? html`<div class="auth-note" style="border-color:var(--danger-line);background:var(--danger-bg);color:var(--danger)">${raw(I('alert', 15))}<span>${msg}</span></div>`
            : errBox(e2 && e2.code === 'TOKEN_EXPIRED' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID'));
        });
      });
      root.querySelector('#cc-resend').addEventListener('click', function (e) {
        e.preventDefault();
        var email = form.elements.email.value;
        if (!email) { mount(root.querySelector('#cc-err'), errBox('INVALID_EMAIL')); return; }
        AuthService.resendCode(email).then(function (r) {
          UI.toast('Código reenviado para ' + email + '.', { type: 'info' });
          if (Config.env === 'demo' && r.devCode) UI.toast('Dev: código = ' + r.devCode, { type: 'info', timeout: 8000 });
        }).catch(function (e2) { UI.toast(e2.message, { type: 'err' }); });
      });
    }
  };

  /* ---------------- DEFINIR SENHA (aceite de convite, produção) ---------------- */
  AuthViews.definirSenha = {
    title: 'Definir senha',
    render: function () {
      var me = Auth.me() || {};
      return shell('Defina sua senha', 'Bem-vindo(a) à equipe! Crie uma senha para acessar o sistema nas próximas vezes.', html`
        <div class="auth-note" style="border-color:var(--ok-line);background:var(--ok-bg);color:var(--ok)">${raw(I('check-circle', 15))}
          <span>Convite aceito — você está logado(a) como <b>${me.email}</b>. Falta só definir sua senha.</span></div>
        <form id="ds-form" novalidate>
          <div class="field"><label for="ds-pw">Nova senha <span class="req">*</span></label>
            <input class="input" id="ds-pw" name="pw" type="password" autocomplete="new-password" data-autofocus>${strengthUi()}</div>
          <div class="field"><label for="ds-pw2">Confirmar senha <span class="req">*</span></label>
            <input class="input" id="ds-pw2" name="pw2" type="password" autocomplete="new-password"></div>
          <div id="ds-err"></div>
          <button class="btn btn-primary btn-block btn-lg" type="submit" id="ds-btn">${raw(I('lock', 16))} Salvar senha e entrar</button>
        </form>
        <p class="auth-foot">Mínimo de 8 caracteres, com maiúscula, minúscula e número.</p>`);
    },
    mounted: function (root) {
      var form = root.querySelector('#ds-form');
      if (!form) return;
      bindStrength(form.elements.pw, 'pw-meter', 'pw-label');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var errEl = root.querySelector('#ds-err'), btn = root.querySelector('#ds-btn');
        errEl.innerHTML = '';
        var pw = form.elements.pw.value, pw2 = form.elements.pw2.value;
        var issues = AuthService.passwordIssues(pw);
        if (issues.length) { mount(errEl, errBox('WEAK_PASSWORD')); return; }
        if (pw !== pw2) { mount(errEl, errBox('PASSWORD_MISMATCH')); return; }
        UI.busy(btn, true);
        /* mesma chamada do Supabase de redefinição — aqui com a sessão do convite */
        AuthService.resetPassword({ token: (Store.state.session || {}).token, password: pw, confirm: pw2 })
          .then(function () {
            UI.busy(btn, false);
            UI.toast('Senha definida! Bem-vindo(a) ao LojaCerta 🎉', { type: 'ok', timeout: 5000 });
            Router.go('/app');
          })
          .catch(function (err) { UI.busy(btn, false); mount(errEl, errBox(err.code === 'BAD_CREDENTIALS' ? 'SERVICE' : err.code)); });
      });
    }
  };

  /* ---------------- PAINEL CONTA (aba de Configurações) ---------------- */
  AccountViews.panel = function () {
    var user = Auth.me();
    var acc = (Store.state.auth && Store.state.auth.accounts || []).filter(function (a) { return a.userId === user.id; })[0];
    var sess = AuthService.sessionInfo();
    return html`
    <div class="grid-2e">
      <form class="panel" id="f-troca-senha" novalidate>
        <div class="panel-head"><h3>Alterar senha</h3></div>
        <div class="field"><label for="cs-atual">Senha atual <span class="req">*</span></label><input class="input" id="cs-atual" name="current" type="password" autocomplete="current-password"></div>
        <div class="field"><label for="cs-nova">Nova senha <span class="req">*</span></label><input class="input" id="cs-nova" name="next" type="password" autocomplete="new-password">${strengthUi()}</div>
        <div class="field"><label for="cs-conf">Confirmar nova senha <span class="req">*</span></label><input class="input" id="cs-conf" name="confirm" type="password" autocomplete="new-password"></div>
        <div id="cs-err"></div>
        <button class="btn btn-primary" type="submit">${raw(I('key', 15))} Alterar senha</button>
      </form>
      <div>
        <form class="panel mb-4" id="f-troca-email" novalidate>
          <div class="panel-head"><h3>E-mail da conta</h3>
            ${acc && acc.confirmed ? raw('<span class="badge badge-ok">confirmado</span>') : raw('<span class="badge badge-warn">não confirmado</span>')}</div>
          <p class="small muted mb-3">Atual: <b>${user.email}</b>${acc && !acc.confirmed ? ' · <a href="#" data-resend-conf>reenviar confirmação</a>' : ''}</p>
          <div class="field"><label for="ce-novo">Novo e-mail <span class="req">*</span></label><input class="input" id="ce-novo" name="newEmail" type="email"></div>
          <div class="field"><label for="ce-senha">Senha atual (confirmação) <span class="req">*</span></label><input class="input" id="ce-senha" name="password" type="password"></div>
          <div id="ce-err"></div>
          <button class="btn btn-primary" type="submit">${raw(I('mail', 15))} Solicitar troca</button>
        </form>
        <div class="panel">
          <div class="panel-head"><h3>Sessão de login (segurança)</h3></div>
          <p class="small muted mb-2" style="line-height:1.6">Este prazo é da <b>sessão de login</b>, não do seu plano. É uma proteção para o caso de você esquecer o app aberto — ao usar o sistema, ela se estende sozinha.</p>
          <ul class="mini-list">
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Expira em</span><span class="mr-sub">estendida automaticamente enquanto você navega</span></span><b>${sess ? Math.max(0, Math.round((sess.expiresAt - Date.now()) / 60000)) + ' min' : '—'}</b></li>
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Renova sem novo login por</span><span class="mr-sub">após este prazo, dá para renovar sem refazer login</span></span><b>30 dias</b></li>
          </ul>
          <button class="btn btn-sm mt-3" data-sess-refresh>${raw(I('refresh', 14))} Renovar sessão agora</button>
        </div>
      </div>
    </div>
    <div class="danger-zone mt-4">
      <h3>Exclusão da conta (LGPD)</h3>
      <p>Solicita a exclusão da conta e dos dados da loja, com carência de 30 dias (reversível pelo suporte). Confirmação por senha + e-mail de segurança.</p>
      <div class="flex gap-2 items-center" style="flex-wrap:wrap">
        <input class="input" id="del-pw" type="password" placeholder="Senha para confirmar" style="max-width:240px">
        <button class="btn btn-danger" id="del-btn">${raw(I('trash', 14))} Solicitar exclusão</button>
      </div>
      <div id="del-err" class="mt-2"></div>
    </div>`;
  };
  AccountViews.bindPanel = function (root) {
    var fs = root.querySelector('#f-troca-senha');
    bindStrength(fs.elements.next, 'pw-meter', 'pw-label');
    fs.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = root.querySelector('#cs-err'); err.innerHTML = '';
      UI.busy(fs.querySelector('button[type=submit]'), true);
      AuthService.changePassword({ current: fs.elements.current.value, next: fs.elements.next.value, confirm: fs.elements.confirm.value })
        .then(function () { UI.busy(fs.querySelector('button[type=submit]'), false); UI.toast('Senha alterada! Use a nova senha no próximo login.', { type: 'ok' }); fs.reset(); })
        .catch(function (e2) { UI.busy(fs.querySelector('button[type=submit]'), false); mount(err, errBox(e2.code)); });
    });
    var fe = root.querySelector('#f-troca-email');
    fe.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = root.querySelector('#ce-err'); err.innerHTML = '';
      UI.busy(fe.querySelector('button[type=submit]'), true);
      AuthService.requestEmailChange({ newEmail: fe.elements.newEmail.value, password: fe.elements.password.value })
        .then(function (r) {
          UI.busy(fe.querySelector('button[type=submit]'), false);
          UI.toast('Enviamos um link de confirmação para o novo e-mail.', { type: 'ok' });
          if (Config.env === 'demo' && r.devToken) UI.toast('Dev: link em Configurações → Emails (dev).', { type: 'info', timeout: 6000 });
          fe.reset();
        })
        .catch(function (e2) { UI.busy(fe.querySelector('button[type=submit]'), false); mount(err, errBox(e2.code)); });
    });
    var rs = root.querySelector('[data-resend-conf]');
    if (rs) rs.addEventListener('click', function (e) {
      e.preventDefault();
      AuthService.resendConfirmation(Auth.me().email).then(function (r) {
        UI.toast('Confirmação reenviada!', { type: 'ok' });
        if (Config.env === 'demo' && r.devToken) Router.go('/confirmar-email?token=' + r.devToken);
      }).catch(function (e2) { UI.toast(e2.message, { type: 'err' }); });
    });
    var sr = root.querySelector('[data-sess-refresh]');
    if (sr) sr.addEventListener('click', function () {
      UI.busy(sr, true);
      AuthService.renew().then(function (r) {
        UI.busy(sr, false);
        var min = r && r.expiresAt ? Math.max(1, Math.round((r.expiresAt - Date.now()) / 60000)) : 60;
        UI.toast('Sessão renovada — expira em ' + min + ' min.', { type: 'ok' });
        AccountViews.rerender && AccountViews.rerender();
      }).catch(function (e2) {
        UI.busy(sr, false);
        UI.toast(e2 && e2.message ? e2.message : 'Não foi possível renovar. Entre novamente.', { type: 'err' });
      });
    });
    var db = root.querySelector('#del-btn');
    db.addEventListener('click', function () {
      var err = root.querySelector('#del-err'); err.innerHTML = '';
      UI.confirm({ title: 'Solicitar exclusão da conta?', text: 'Carência de 30 dias (LGPD). Durante ela, o suporte pode reverter. Após, todos os dados são apagados.', danger: true, okText: 'Solicitar exclusão' })
        .then(function (okk) {
          if (!okk) return;
          AuthService.requestAccountDeletion(root.querySelector('#del-pw').value)
            .then(function () { UI.toast('Exclusão solicitada. Carência de 30 dias iniciada.', { type: 'warn', timeout: 6000 }); })
            .catch(function (e2) { mount(err, errBox(e2.code, e2.message)); });
        });
    });
  };

  /* ---------------- CAIXA DE SAÍDA LOCAL (somente demo/dev) ---------------- */
  AccountViews.outbox = function () {
    var msgs = EmailService.outbox();
    return html`<div class="panel">
      <div class="panel-head"><h3>Caixa de saída local (desenvolvimento)</h3><span class="panel-sub">substituída pelo provedor real em produção</span></div>
      <p class="small muted mb-3">Nenhum provedor de e-mail está conectado. Os e-mails que o sistema “envia” ficam registrados aqui, com links de token clicáveis para testar os fluxos de ponta a ponta.</p>
      ${msgs.length ? html`<div class="table-wrap" style="border:none;max-height:380px;overflow-y:auto"><table class="table">
        <thead><tr><th>Quando</th><th>Para</th><th>Assunto</th><th>Status</th><th></th></tr></thead>
        <tbody>${msgs.map(function (m) {
          return html`<tr><td class="muted small nowrap">${U.dt(m.at)}</td><td class="small">${m.to}</td><td class="strong small">${m.subject}</td>
            <td><span class="badge ${m.status === 'sent' ? 'badge-ok' : m.status === 'failed' ? 'badge-danger' : 'badge-warn'}">${m.status}</span></td>
            <td class="right nowrap">${m.ctx && m.ctx.token ? html`<a class="btn btn-sm" href="#/${m.kind === 'password_reset' ? 'redefinir' : 'confirmar-email'}${m.kind === 'email_change_confirm' ? '?tipo=mudanca' : '?'}&token=${m.ctx.token}">abrir link</a>` : html`<button class="btn btn-sm" data-mail="${m.id}">ver</button>`}</td></tr>`;
        })}</tbody></table></div>` : C.empty('mail', 'Nenhum e-mail enviado ainda', 'Cadastre uma conta ou solicite recuperação de senha para ver os modelos aqui.')}
    </div>`;
  };
  AccountViews.bindOutbox = function (root) {
    root.querySelectorAll('[data-mail]').forEach(function (b) {
      b.addEventListener('click', function () {
        var m = EmailService.outbox().filter(function (x) { return x.id === b.dataset.mail; })[0];
        if (!m) return;
        UI.modal({ title: m.subject, sub: 'para ' + m.to + ' · ' + U.dt(m.at), size: 'lg',
          body: raw('<div style="border:1px solid var(--line);border-radius:10px;overflow:hidden">' + m.html + '</div>'),
          foot: raw('<button class="btn btn-ghost" data-modal-close>Fechar</button>') });
      });
    });
  };
})();
