/* ==========================================================================
   LojaCerta · Main (bootstrap)
   Shell do app (sidebar/topbar/drawer), rotas com guardas de sessão e papel,
   atalhos globais, dispatcher de ações e inicialização.
   ========================================================================== */
;(function () {
  'use strict';

  var NAV = [
    { page: 'dashboard', label: 'Dashboard', icon: 'dashboard', sect: 'op' },
    { page: 'pdv', label: 'PDV — Vender', icon: 'cart', sect: 'op' },
    { page: 'produtos', label: 'Produtos', icon: 'package', sect: 'op' },
    { page: 'estoque', label: 'Estoque', icon: 'layers', sect: 'op' },
    { page: 'vendas', label: 'Vendas', icon: 'receipt', sect: 'op' },
    { page: 'relatorios', label: 'Relatórios', icon: 'reports', sect: 'op' },
    { page: 'suporte', label: 'Suporte', icon: 'headset', sect: 'conta' },
    { page: 'assinatura', label: 'Assinatura', icon: 'billing', sect: 'conta' },
    { page: 'config', label: 'Configurações', icon: 'settings', sect: 'conta' }
  ];
  var HOME_TITLE = 'LojaCerta — Sistema de gestão de estoque e vendas para o seu negócio';
  var currentCtrl = null;

  /* Primeira página liberada para o papel atual (dev cai no Suporte) */
  function homePage() {
    var all = NAV.filter(function (n) { return Perms.pageAllowed(n.page); });
    var u = Auth.me();
    if (u && u.papel === 'dev') {
      var sup = all.filter(function (n) { return n.page === 'suporte'; })[0];
      if (sup) return 'suporte';
    }
    return all.length ? all[0].page : null;
  }

  /* ---------- modos de exibição ---------- */
  function landingMode() {
    document.body.classList.remove('is-app', 'drawer-open');
    currentCtrl = null;
    Landing.show();
    document.title = HOME_TITLE;
  }
  function fullMode() {
    document.body.classList.add('is-app');
    document.body.classList.remove('drawer-open');
    var land = document.getElementById('landing');
    var foot = document.getElementById('site-footer');
    if (land) land.classList.add('hidden');
    if (foot) foot.classList.add('hidden');
    var r = document.getElementById('view-root');
    r.classList.remove('hidden');
    return r;
  }
  function announce(title) {
    var a = document.getElementById('route-announce');
    if (a) a.textContent = title;
    document.title = title + ' · LojaCerta';
  }

  /* ---------- shell ---------- */
  function sideLink(n, hintIdx, page) {
    /* badge do Suporte (v8): bola com o usuário (cliente) ou fila (dev) —
       aparece em QUALQUER tela, não só dentro do Suporte */
    var badge = '';
    if (n.page === 'suporte' && Auth.me() && typeof Support !== 'undefined' && Support.badgeCount() > 0) {
      badge = '<span class="nav-badge" data-nav-badge="suporte">' + Support.badgeCount() + '</span>';
    } else if (n.page === 'suporte') {
      badge = '<span class="nav-badge" data-nav-badge="suporte" hidden></span>';
    }
    return html`<a class="side-link ${n.page === page ? 'active' : ''}" href="#/app/${n.page}" ${n.page === page ? raw('aria-current="page"') : ''}>
      ${raw(I(n.icon, 17))} ${n.label}${raw(badge)}<span class="kbd-hint">Alt+${hintIdx + 1}</span></a>`;
  }
  function sidePlan(info) {
    var user = Auth.me();
    if (user && user.papel === 'dev') {
      return html`<div class="side-plan"><b>${raw(I('headset', 12))} Dev · acesso ilimitado</b>
        Conta interna JR Sistemas — recebe os tickets<br>de todas as empresas cliente<br><a href="#/app/suporte">Abrir atendimento →</a></div>`;
    }
    if (info.plan && info.plan.id === 'dev') {
      return html`<div class="side-plan"><b>${raw(I('check-circle', 12))} Dev · ilimitado</b>
        Todos os recursos, sem prazo</div>`;
    }
    if (info.status === 'trialing') {
      return html`<div class="side-plan"><b>${raw(I('clock', 12))} Teste grátis</b>
        <span class="sp-track"><span class="sp-fill" style="width:${info.usedPct}%"></span></span>
        Restam <b style="display:inline">${info.daysLeft}</b> de 14 dias<br><a href="#/app/assinatura">Escolher plano →</a></div>`;
    }
    if (info.status === 'active') {
      /* plano pago com prazo: sidebar mostra o vencimento (com alerta nos últimos 5 dias) */
      if (info.planExpiresAt) {
        return html`<div class="side-plan" style="${info.expiring ? 'border-color:rgba(245,158,11,.4)' : ''}"><b>${raw(I(info.expiring ? 'alert' : 'check-circle', 12))} Plano ${info.plan ? info.plan.name : ''}</b>
          Válido até ${U.date(info.planExpiresAt)} · ${info.daysLeft}${info.daysLeft === 1 ? ' dia' : ' dias'}<br><a href="#/app/assinatura">${info.expiring ? 'Renovar agora →' : 'Gerenciar →'}</a></div>`;
      }
      return html`<div class="side-plan"><b>${raw(I('check-circle', 12))} Plano ${info.plan ? info.plan.name : ''}</b>
        Próxima cobrança: ${U.date(info.nextCharge)}<br><a href="#/app/assinatura">Gerenciar →</a></div>`;
    }
    if (info.status === 'past_due') {
      return html`<div class="side-plan" style="border-color:rgba(245,158,11,.4)"><b>${raw(I('alert', 12))} Pagamento pendente</b>
        Regularize para não bloquear o PDV<br><a href="#/app/assinatura">Regularizar →</a></div>`;
    }
    return html`<div class="side-plan" style="border-color:rgba(239,68,68,.4)"><b>${raw(I('lock', 12))} Assinatura suspensa</b>
      PDV em modo bloqueado<br><a href="#/app/assinatura">Reativar →</a></div>`;
  }
  /* banner persistente (v8): cliente com chamado aguardando resposta dele vê
     em qualquer tela — o “como eu sei que fui respondido?” fora da página de
     Suporte. Sem e-mail (limite do plano Free), o app é o canal. */
  function waitingBanner(user) {
    if (!user || user.papel === 'dev') return '';
    /* dispensado nas últimas 4h? respeita — o badge continua no menu */
    try {
      var dis = parseInt(localStorage.getItem('lc_wb_dismiss') || '0', 10);
      if (dis && Date.now() - dis < 4 * 3600 * 1000) return '';
    } catch (e) { }
    var n = (typeof Support !== 'undefined' && Support.badgeData) ? (Support.badgeData.aguardandoCliente || 0) : 0;
    if (!n) return '';
    return html`<div class="wait-banner" id="wait-banner" role="status">
      <span class="wb-msg">${raw(I('clock', 16))}<span><b>Você tem ${n} ${n === 1 ? 'chamado aguardando sua resposta' : 'chamados aguardando sua resposta'}</b> — a equipe JR Sistemas respondeu pelo Suporte.</span></span>
      <a href="#/app/suporte" class="btn btn-sm btn-primary">Responder agora</a>
      <button type="button" class="btn-icon" data-wb-dismiss aria-label="Dispensar aviso">${raw(I('x', 14))}</button>
    </div>`;
  }
  function renderShell(page) {
    var root = fullMode();
    var user = Auth.me(), info = Billing.statusInfo(), t = Store.state.tenant;
    lastPapel = user ? user.papel : null;   /* base de comparação p/ store:changed */
    var all = NAV.filter(function (n) { return Perms.pageAllowed(n.page); });
    var op = all.filter(function (n) { return n.sect === 'op'; });
    var ct = all.filter(function (n) { return n.sect === 'conta'; });

    root.innerHTML = frag(html`
    <div class="app-shell">
      <aside class="app-side" id="app-side" aria-label="Navegação do sistema">
        <a class="side-brand" href="#/app/dashboard">${raw('<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#1E293B"/><rect x="6" y="17" width="9" height="5" rx="1.2" fill="#EA580C"/><rect x="17" y="17" width="9" height="5" rx="1.2" fill="#F97316"/><rect x="11.5" y="10" width="9" height="5" rx="1.2" fill="#FDBA74"/><path d="M9 25.5l4.5-3 3 2 6.5-5" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>')} <span>Loja<b>Certa</b></span></a>
        <nav class="side-nav" aria-label="Páginas">
          <span class="side-sect">Operação</span>
          ${op.map(function (n) { return sideLink(n, all.indexOf(n), page); })}
          <span class="side-sect">Conta</span>
          ${ct.map(function (n) { return sideLink(n, all.indexOf(n), page); })}
        </nav>
        ${sidePlan(info)}
        <div class="side-foot">
          <div class="side-user"><span class="avatar">${U.initials(user.nome)}</span>
            <span style="min-width:0"><span class="su-name">${user.nome}</span><br><span class="su-role">${user.papel === 'dev' ? 'Dev · JR Sistemas' : user.papel}</span></span></div>
          <div class="side-foot-btns">
            <button type="button" class="btn btn-sm side-exit" data-act="goto-conta" title="Alterar senha e e-mail da conta">${raw(I('key', 14))} Conta e senha</button>
            <button type="button" class="btn btn-sm side-exit" data-act="logout">${raw(I('logout', 14))} Sair</button>
          </div>
        </div>
      </aside>
      <div class="drawer-backdrop-app" data-act="drawer-close" aria-hidden="true"></div>
      <div class="app-main">
        <header class="app-top">
          <button type="button" class="btn-icon menu-btn" data-act="drawer-open" aria-label="Abrir menu de navegação">${raw(I('menu', 20))}</button>
          <div class="top-title">${Pages[page] ? Pages[page].title : page}</div>
          <div class="top-right">
            <span class="small muted store-el" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.nome}</span>
            ${C.subBadge(info)}
          </div>
        </header>
        ${raw(waitingBanner(user))}
        <div class="app-content"><div id="page-root"></div></div>
      </div>
    </div>`);
  }
  function mountPage(page, params, query) {
    var ctrl = Pages[page];
    if (!ctrl) { Router.go('/app/dashboard', { replace: true }); return; }
    if (currentCtrl && currentCtrl.unmount) { try { currentCtrl.unmount(); } catch (e) { console.warn(e); } }
    currentCtrl = ctrl;
    var pr = document.getElementById('page-root');
    if (!pr) return;
    try {
      pr.innerHTML = frag(ctrl.render(params, query));
      if (ctrl.mounted) ctrl.mounted(pr, params, query);
    } catch (e) {
      console.error('[page]', e);
      mount(pr, C.errorPanel(e));
    }
    /* v1.8.1 · affordance de arraste horizontal: tabelas largas (min-width
       760-980px) rolam dentro do .table-wrap, mas nada sinalizava isso no
       celular. Sentinel sticky na borda direita, some ao chegar ao fim.
       Nas páginas com fill() assíncrono o .table-wrap só existe DEPOIS do
       mount (template vazio → C.empty()) → observer no page-root inteiro
       re-avalia a cada mudança de DOM; desconecta após 30s. */
    var ensureCues = function () {
      Array.prototype.forEach.call(pr.querySelectorAll('.table-wrap,.cart-wrap'), function (w) {
        if (w.scrollWidth <= w.clientWidth + 8) return;
        if (w.querySelector('.scroll-cue')) return;
        var c = document.createElement('span');
        c.className = 'scroll-cue';
        c.setAttribute('aria-hidden', 'true');
        w.appendChild(c);
        var upd = function () { c.style.opacity = (w.scrollWidth - w.clientWidth - w.scrollLeft > 24) ? '' : '0'; };
        w.addEventListener('scroll', upd, { passive: true });
        upd();
      });
    };
    requestAnimationFrame(ensureCues);
    try {
      var mo = new MutationObserver(function () { requestAnimationFrame(ensureCues); });
      mo.observe(pr, { childList: true, subtree: true });
      setTimeout(function () { mo.disconnect(); }, 30000);
    } catch (e) { /* MSRV: sem observer, fica só o rAF inicial */ }
    announce(ctrl.title);
    window.scrollTo(0, 0);
  }

  /* ---------- rotas ---------- */
  Router.add('/', function () {
    landingMode();
    window.scrollTo(0, 0);
  });

  Router.add('/cadastro', function (params, query) {
    if (Auth.me()) { Router.go('/app', { replace: true }); return; }
    var root = fullMode();
    currentCtrl = null;
    mount(root, AuthViews.signup.render(query));
    AuthViews.signup.mounted(root, params, query || {});
    announce('Criar conta grátis');
    window.scrollTo(0, 0);
  });

  Router.add('/entrar', function (params, query) {
    if (Auth.me()) { Router.go((query && query.next) || '/app', { replace: true }); return; }
    var root = fullMode();
    currentCtrl = null;
    mount(root, AuthViews.login.render(query));
    AuthViews.login.mounted(root, params, query || {});
    announce('Entrar');
    window.scrollTo(0, 0);
  });

  /* Telas de autenticação (recuperação/redefinição/confirmação) */
  function authScreen(name, params, query) {
    var root = fullMode();
    currentCtrl = null;
    var V = AuthViews[name];
    mount(root, V.render(params, query));
    if (V.mounted) V.mounted(root, params, query || {});
    announce(V.title || 'Conta');
    window.scrollTo(0, 0);
  }
  Router.add('/recuperar', function (p, q) { authScreen('recuperar', p, q); });
  Router.add('/redefinir', function (p, q) { authScreen('redefinir', p, q); });
  Router.add('/confirmar-email', function (p, q) { authScreen('confirmarEmail', p, q); });
  Router.add('/confirmar-codigo', function (p, q) { authScreen('confirmarCodigo', p, q); });
  /* Convite aceito pelo e-mail: usuário logado define a senha (produção) */
  Router.add('/definir-senha', function (p, q) {
    if (!Auth.me()) { Router.go('/entrar', { replace: true }); return; }
    authScreen('definirSenha', p, q);
  });

  Router.add('/app', function () { Router.go('/app/' + (homePage() || 'dashboard'), { replace: true }); });

  Router.add('/app/:page', function (params, query) {
    var sess = AuthService.touch();
    if (sess.state === 'expired') {
      UI.toast('Sessão expirada por segurança. Entre novamente.', { type: 'warn' });
      Router.go('/entrar?expired=1', { replace: true });
      return;
    }
    if (!Auth.me()) {
      Router.go('/entrar?next=' + encodeURIComponent('/app/' + params.page), { replace: true });
      return;
    }
    if (!Pages[params.page]) { Router.go('/app/' + (homePage() || 'dashboard'), { replace: true }); return; }
    if (!Perms.pageAllowed(params.page)) {
      var u = Auth.me();
      var home = homePage() || 'dashboard';
      if (params.page === home) { Router.go('/', { replace: true }); return; } /* evita loop */
      UI.toast('A página "' + params.page + '" não está liberada para o papel ' + u.papel + '.', { type: 'warn' });
      Router.go('/app/' + home, { replace: true });
      return;
    }
    /* billing em dia a cada navegação: vira trial vencido em suspenso e
       pega ativações feitas pela equipe JR sem precisar re-login */
    try { Billing.checkTrial(); Billing.syncRemote(); } catch (e) { /* não bloqueia a rota */ }
    renderShell(params.page);
    mountPage(params.page, params, query || {});
  });

  /* ---------- dispatcher global de ações ---------- */
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (t) {
      var act = t.dataset.act;
      if (act === 'drawer-open') { document.body.classList.add('drawer-open'); return; }
      if (act === 'drawer-close') { document.body.classList.remove('drawer-open'); return; }
      if (act === 'retry-page') { Router.resolve(); return; }
      if (act === 'theme-toggle') { if (window.Theme) Theme.toggle(); return; }
      if (act === 'logout') {
        UI.confirm({ title: 'Sair da conta?', text: 'Você voltará para a página inicial.', okText: 'Sair' })
          .then(function (r) {
            if (!r) return;
            Auth.logout().then(function () {
              /* zera o "ticket aberto" do suporte — sem isto, o próximo login
                 na MESMA aba caía no detalhe do ticket do usuário anterior
                 (navegação hash não recarrega o bundle) */
              if (window.Pages && Pages.suporte) { Pages.suporte.sel = null; Pages.suporte.filter = { status: '', prio: '', cat: '', tenant: '', q: '', sort: 'recent', mine: false }; }
              try { if (window.Support) Support.stopBadgePolling(); } catch (err) { }
              try { sessionStorage.removeItem('lc_dev_pin'); } catch (err) { } /* PIN não sobrevive ao logout */
              Router.go('/'); UI.toast('Sessão encerrada. Até logo! 👋', { type: 'ok' });
            });
          });
        return;
      }
      if (act === 'goto-conta') { Router.go('/app/config?tab=conta'); return; }
    }
    /* banner aguardando você: dispensa por algumas horas (não a cada navegação) */
    var wb = e.target.closest ? e.target.closest('[data-wb-dismiss]') : null;
    if (wb) {
      var bEl = document.getElementById('wait-banner');
      if (bEl) bEl.remove();
      try { localStorage.setItem('lc_wb_dismiss', String(Date.now())); } catch (err) { }
      return;
    }
    if (e.target.closest && e.target.closest('.side-link')) document.body.classList.remove('drawer-open');
  });

  /* ---------- atalhos globais ---------- */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      document.body.classList.remove('drawer-open', 'nav-open');
    }
    if (e.altKey && /^[1-8]$/.test(e.key) && document.body.classList.contains('is-app') && Auth.me()) {
      var all = NAV.filter(function (n) { return Perms.pageAllowed(n.page); });
      var n = all[Number(e.key) - 1];
      if (n) { e.preventDefault(); Router.go('/app/' + n.page); }
    }
    if ((e.key === 'F2' || e.key === 'F4') && currentCtrl && currentCtrl.hotkey) {
      var inModal = document.querySelector('#modal-root .modal-overlay');
      if (!inModal) currentCtrl.hotkey(e);
    }
  });

  /* ---------- refresh de shell/badges ---------- */
  var refreshShell = U.debounce(function () {
    if (Router.current && Router.current.path && Router.current.path.indexOf('/app/') === 0 && Auth.me()) Router.resolve();
  }, 90);
  Bus.on('billing:changed', refreshShell);
  Bus.on('shell:refresh', refreshShell);

  /* ---------- v8 · badge ao vivo (sem repintar o shell inteiro) ----------
     O polling (60s) e o visibilitychange atualizam o número direto no DOM:
     badge do menu + banner "aguardando sua resposta". O banner entra/sai do
     DOM no lugar — NUNCA re-renderiza a página (não interrompe o PDV). */
  function ensureBanner(clientN) {
    var existing = document.getElementById('wait-banner');
    try {
      var dis = parseInt(localStorage.getItem('lc_wb_dismiss') || '0', 10);
      if (dis && Date.now() - dis < 4 * 3600 * 1000 && existing) { existing.remove(); return; }
    } catch (e) { }
    if (clientN > 0 && !existing) {
      var hdr = document.querySelector('.app-main .app-top');
      if (!hdr) return;
      var div = document.createElement('div');
      div.className = 'wait-banner';
      div.id = 'wait-banner';
      div.setAttribute('role', 'status');
      div.innerHTML = '<span class="wb-msg">' + I('clock', 16) + '<span><b>Você tem ' + clientN + ' ' + (clientN === 1 ? 'chamado aguardando sua resposta' : 'chamados aguardando sua resposta') + '</b> — a equipe JR Sistemas respondeu pelo Suporte.</span></span>' +
        '<a href="#/app/suporte" class="btn btn-sm btn-primary">Responder agora</a>' +
        '<button type="button" class="btn-icon" data-wb-dismiss aria-label="Dispensar aviso">' + I('x', 14) + '</button>';
      hdr.insertAdjacentElement('afterend', div);
    } else if (clientN === 0 && existing) {
      existing.remove();
    } else if (clientN > 0 && existing) {
      var txt = existing.querySelector('b');
      if (txt) txt.textContent = 'Você tem ' + clientN + ' ' + (clientN === 1 ? 'chamado aguardando sua resposta' : 'chamados aguardando sua resposta');
    }
  }
  function paintBadge() {
    if (!Auth.me() || typeof Support === 'undefined') return;
    var n = Support.badgeCount();
    document.querySelectorAll('[data-nav-badge="suporte"]').forEach(function (el) {
      if (n > 0) { el.textContent = String(n); el.hidden = false; }
      else el.hidden = true;
    });
    var me = Auth.me() || {};
    ensureBanner(me.papel === 'dev' ? 0 : ((Support.badgeData || {}).aguardandoCliente || 0));
  }
  Bus.on('badge:changed', U.debounce(paintBadge, 120));
  var lastPapel = null;
  Bus.on('store:changed', U.debounce(function () {
    var me = Auth.me();
    var papel = me ? me.papel : null;
    /* papel mudou no servidor (ex.: promoted/demoted pela equipe JR e puxado
       pelo sync.pull)? repinta o shell inteiro — sem isto a sidebar continuava
       mostrando o papel antigo até a próxima navegação */
    if (lastPapel !== null && lastPapel !== papel) refreshShell();
    lastPapel = papel;
    if (currentCtrl && currentCtrl.onStoreChanged) {
      try { currentCtrl.onStoreChanged(); } catch (err) { console.error(err); }
    }
  }, 60));

  /* ---------- boot ---------- */
  /* Tokens de auth do Supabase chegam na FRAGMENTO da URL (#access_token=...&type=recovery).
     O redirect do provedor substitui a rota — capturamos ANTES do Router e normalizamos. */
  function consumeAuthRedirect() {
    if (Config.env !== 'production') return null;
    var h = location.hash || '';
    if (h.indexOf('access_token=') === -1) return null;
    var at = h.match(/access_token=([^&]+)/), rt = h.match(/refresh_token=([^&]+)/), ty = h.match(/(?:^|[?&#])type=([^&]+)/), er = h.match(/error_description=([^&]*)/);
    if (er) { history.replaceState(null, '', location.pathname + '#/entrar'); return { error: decodeURIComponent(er[1]) }; }
    if (!at) return null;
    var type = ty ? decodeURIComponent(ty[1]) : '';
    var token = decodeURIComponent(at[1]);
    var refresh = rt ? decodeURIComponent(rt[1]) : null;
    var target = type === 'recovery' ? '#/redefinir' : (type === 'invite' ? '#/definir-senha' : '#/app');
    if (type === 'recovery') {
      window.__recoveryToken = token;
      window.__recoveryRefresh = refresh;
    } else {
      /* signup/magiclink/invite: entra com a sessão que veio no link */
      Store.state.session = { userId: null, token: token, refresh: refresh, expiresAt: Date.now() + 3600 * 1000, refreshUntil: Date.now() + 30 * 864e5 };
      Store.persist();
    }
    history.replaceState(null, '', location.pathname + location.search + target);
    return { type: type };
  }

  /* ---------- v1.7.3 · probe de versão nova (cache do GH Pages ≈ 10 min) ----------
     O HTML publicado pode ficar retido no edge mesmo depois de um deploy. O probe
     busca version.json com query única (não cacheia) e compara com a versão em
     execução. Se diferente, avisa — recarregar é SEMPRE ação do usuário (nunca
     automático: um reload surpresa no meio de uma venda no PDV é pior do que
     alguns minutos de versão antiga). Poda: no máx. 1 probe / 5 min, 1 aviso / sessão. */
  function probeVersion(force) {
    if (Config.env !== 'production') return;
    var now = Date.now();
    if (!force && now - (probeVersion._t || 0) < 5 * 60 * 1000) return;
    probeVersion._t = now;
    fetch('version.json?ts=' + now).then(function (r) { return r.json(); }).then(function (v) {
      if (v && v.version && v.version !== Config.version && !probeVersion._shown) {
        probeVersion._shown = true;
        UI.toast('Recarregue a página (F5) para usar a versão ' + v.version + '.',
          { type: 'info', title: 'Nova versão disponível', timeout: 'persist' });
      }
    }).catch(function () { /* probe silencioso: sem rede não há o que avisar */ });
  }

  ready(function () {
    selectAdapter();
    if (window.Theme) Theme.init();
    Landing.wire();
    if (Config.env !== 'demo') { var chip = document.getElementById('demo-chip'); if (chip) chip.remove(); }
    if (!Store.state) Store.init(Config.env === 'demo' ? Seed.demo() : Seed.emptyTenant());
    /* v1.7.3 · detecção de versão nova: no boot (+4s, deixa o app subir primeiro)
       e ao voltar para a aba — mesmo gatilho do badge/billing */
    setTimeout(function () { probeVersion(true); }, 4000);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      if (Auth.me() && typeof Support !== 'undefined') Support.refreshOnVisible();
      probeVersion();
    });
    /* v8 · ciclo de vida do badge: polling 60s enquanto logado + refresh
       imediato (badge e billing) ao voltar para a aba — resolve o “ativei o
       plano e o cliente continuou travado até recarregar a página” */
    Bus.on('store:changed', U.debounce(function () {
      if (Auth.me() && typeof Support !== 'undefined') Support.startBadgePolling();
    }, 400));
    var redirect = consumeAuthRedirect();
    if (redirect && redirect.type && redirect.type !== 'recovery') {
      /* sessão veio por link (convite/signup/magiclink): hidrata o perfil */
      SupabaseDataAdapter.hydrateProfile().then(function () {
        return SupabaseDataAdapter.request('sync.pull', {});
      }).catch(function (e) { console.warn('hydrate pós-redirect:', e.message); }).then(function () { Router.start(); });
      return;
    }
    if (Config.env === 'production' && Store.state.session && Store.state.session.token) {
      var t0 = AuthService.touch();
      if (t0.state === 'ok' || t0.state === 'refreshed') {
        ApiClient.request('sync.pull').catch(function (e) { console.warn('sync.pull:', e.message); });
        if (typeof Support !== 'undefined') Support.startBadgePolling();
      } else { Store.state.session = { userId: null }; Store.persist(); }
    }
    if (Auth.me() && typeof Support !== 'undefined') Support.startBadgePolling();
    Billing.checkTrial();
    Router.start();
    console.info('%c🧱 LojaCerta v' + Config.version + ' (' + Config.env + ')', 'color:#EA580C;font-weight:bold;font-size:14px',
      '\nSistema de gestão — JR Sistemas e Tecnologia. Dados e sessões protegidos por RLS.');
  });
})();
