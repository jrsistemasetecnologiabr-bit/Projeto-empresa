/* ==========================================================================
   LojaCerta · Pages — Suporte (central de tickets)
   --------------------------------------------------------------------------
   Duas visões sobre as MESMAS telas, decididas por Auth.me().papel === 'dev':

   · USUÁRIO (tenant/cliente): vê apenas os tickets da própria empresa
     (ticket.tenantId === tenant atual). Abre tickets, responde (a bola volta
     para a equipe) e encerra/confirma SOMENTE os tickets que ele mesmo abriu
     — sem dropdown livre de status. Vê "⏳ Aguardando você" quando a bola
     está com ele.

   · DEV (equipe JR Sistemas / super-admin): painel GLOBAL multi-tenant.
     Vê todos os chamados de todas as empresas (badge com o nome da empresa),
     KPIs por estado, fila pessoal ("Minha fila"), ações contextuais —
     Atender (assume + em_andamento), Voltar à fila, Resolver, Fechar,
     Reabrir — prioridade/categoria e status avançado, com resposta livre.
     Ferramentas de billing no próprio ticket: Ativar/Estender plano COM
     PRAZO (DevPlanActivationModal) e Suspender acesso.

   Máquina de estados (v7) — o status diz DE QUEM É A BOLA:
     aberto → (dev Atender) → em_andamento → (dev responde) → aguardando_cliente
            → (cliente responde) → aguardando_equipe → (dev responde) → …
     resolvido (solução proposta; dono confirma) → fechado (encerrado).
   A transição automática mora no BACKEND (trigger por papel) e no mock
   (services.js) — a UI apenas reflete. Eventos de status aparecem na conversa.

   Produção: PostgREST + RPC + Edge (adapters.js). Demo: MockAdapter (services.js).
   ========================================================================== */
;(function () {
  'use strict';
  window.Pages = window.Pages || {};

  /* ---------- v13 · rascunhos no banco (por usuário + chave do ticket) ----------
     A fonte primária passa a ser o banco (ticket_drafts, via RPC — o texto
     atravessa troca de navegador/máquina); o localStorage segue como cópia
     offline (fallback de leitura se o banco não responder). Em demo (sem
     banco) o comportamento é 100% local, igual à v8.
     chave do rascunho: uuid do ticket (resposta) · 'novo' (novo ticket) */
  var Draft = {
    localKey: function (key) {
      if (key === 'novo') return 'lc_draft_newtk';
      return 'lc_draft_tk_' + key.slice(0, 8) + '_' + ((Auth.me() || {}).id || '').slice(0, 8);
    },
    get: function (key, cb) {
      var local = null;
      try { local = localStorage.getItem(Draft.localKey(key)); } catch (e) { }
      if (Config.env !== 'production') { cb(local); return; }
      ApiClient.request('draft.get', { key: key }).then(function (r) {
        var c = r && r.conteudo;
        if (c) cb(c);
        else if (local) {
          /* rascunho antigo que só existia localmente → migra para o banco */
          cb(local);
          try { ApiClient.request('draft.save', { key: key, conteudo: local }).catch(function () { }); } catch (e2) { }
        } else cb(null);
      }).catch(function () { cb(local); });
    },
    save: function (key, conteudo) {
      try { conteudo ? localStorage.setItem(Draft.localKey(key), conteudo) : localStorage.removeItem(Draft.localKey(key)); } catch (e) { }
      if (Config.env === 'production') {
        try { ApiClient.request('draft.save', { key: key, conteudo: conteudo || '' }).catch(function () { }); } catch (e2) { }
      }
    },
    del: function (key) {
      try { localStorage.removeItem(Draft.localKey(key)); } catch (e) { }
      if (Config.env === 'production') {
        try { ApiClient.request('draft.del', { key: key }).catch(function () { }); } catch (e2) { }
      }
    }
  };

  /* ---------- máquina de estados (v7): o status diz DE QUEM É A BOLA ----------
     aberto             → na fila, ninguém da equipe assumiu          (bola: equipe)
     em_andamento       → dev assumiu e está trabalhando               (bola: dev)
     aguardando_cliente → equipe respondeu, espera o cliente           (bola: cliente)
     aguardando_equipe  → cliente respondeu, espera a equipe           (bola: equipe)
     resolvido / fechado → solução proposta / encerrado                                */
  var STATUS_META = {
    aberto: { label: 'Aberto', badge: 'badge-warn' },
    em_andamento: { label: 'Em atendimento', badge: 'badge-info' },
    aguardando_cliente: { label: 'Aguardando cliente', badge: 'badge-brand' },
    aguardando_equipe: { label: 'Aguardando equipe', badge: 'badge-info' },
    resolvido: { label: 'Resolvido', badge: 'badge-ok' },
    fechado: { label: 'Fechado', badge: 'badge-mut' }
  };
  /* rótulo do status considerando o papel: cliente vê “Aguardando você” */
  function stLabel(s, isDev) {
    if (!isDev && s === 'aguardando_cliente') return 'Aguardando você';
    var m = STATUS_META[s]; return m ? m.label : s;
  }
  function stBadge(s, isDev) {
    var m = STATUS_META[s] || STATUS_META.aberto;
    return raw('<span class="badge ' + m.badge + '" title="' + U.esc(stLabel(s, isDev)) + '">' + U.esc(stLabel(s, isDev)) + '</span>');
  }
  function prBadge(p) { var m = PRIO_META[p] || PRIO_META.media; return raw('<span class="badge ' + m.badge + ' no-dot">' + U.esc(m.label) + '</span>'); }
  var PRIO_META = {
    baixa: { label: 'Baixa', badge: 'badge-mut' },
    media: { label: 'Média', badge: 'badge-info' },
    alta: { label: 'Alta', badge: 'badge-warn' },
    urgente: { label: 'Urgente', badge: 'badge-danger' }
  };
  var PRIO_ORDER = { urgente: 0, alta: 1, media: 2, baixa: 3 };
  var CAT_META = {
    duvida: 'Dúvida', bug: 'Problema/Bug', sugestao: 'Sugestão', faturamento: 'Faturamento', outro: 'Outro'
  };

  function tenantBadge(name) {
    return raw('<span class="badge badge-mut no-dot" title="Empresa">' + I('store', 11) + ' ' + U.esc(name || '—') + '</span>');
  }
  /* o dono do ticket: quem abriu (produção: user_id; fallback por e-mail) */
  function isOwner(t, me) {
    if (!me) return false;
    if (t.userId && me.id && t.userId === me.id) return true;
    if (t.requesterEmail && me.email && String(t.requesterEmail).toLowerCase() === String(me.email).toLowerCase()) return true;
    return false;
  }

  /* ---------- linha da lista (card) ---------- */
  function ticketRow(t, isDev, myId) {
    var last = t.updatedAt || t.createdAt;
    var closed = t.status === 'resolvido' || t.status === 'fechado';
    var waitingMe = !isDev && t.status === 'aguardando_cliente'; /* bola com o cliente */
    return html`
      <button type="button" class="ticket-row ${!closed ? 'is-open' : ''} ${waitingMe ? 'is-waiting' : ''}" data-open="${t.id}">
        <span class="tr-main">
          <span class="tr-top">
            <span class="tr-num mono">#${t.numero}</span>
            <span class="tr-assunto">${t.assunto}</span>
            ${isDev ? tenantBadge(t.tenantName) : ''}
            ${waitingMe
              ? raw('<span class="badge badge-warn">' + I('clock', 11) + ' Aguardando você</span>')
              : stBadge(t.status, isDev)}
          </span>
          <span class="tr-sub">
            <span class="badge badge-mut no-dot">${CAT_META[t.categoria] || t.categoria}</span>
            ${prBadge(t.prioridade)}
            ${isDev
              ? html`<span class="muted small nowrap">${raw(I('users', 11))} ${t.requesterName || '—'}</span>${t.assigneeName ? raw('<span class="badge badge-brand no-dot" title="Responsável">' + I('headset', 11) + ' ' + U.esc(t.assigneeName === (Auth.me() || {}).nome ? 'você' : t.assigneeName) + '</span>') : ''}`
              : html`<span class="muted small">por ${t.requesterName || '—'}</span>`}
          </span>
        </span>
        <span class="tr-side">
          <span class="muted small nowrap">${U.dt(last)}</span>
          ${raw(I('chevron-right', 16))}
        </span>
      </button>`;
  }

  /* ---------- evento de status (linha discreta no meio da conversa) ---------- */
  function eventLine(m) {
    /* formato persistido: 'status:<de>><para>' */
    var txt = String(m.message || '');
    var from = '', to = '';
    var mt = txt.match(/^status:([a-z_]+)>([a-z_]+)$/);
    if (mt) { from = stLabel(mt[1], true); to = stLabel(mt[2], true); }
    else from = txt;
    return html`
      <div class="msg-event">
        <span>${raw(I('refresh', 12))} <b>${m.senderName || 'Sistema'}</b> alterou o status${mt ? html`: <span class="mono">${from}</span> → <span class="mono">${to}</span>` : ''} · <span class="muted">${U.dt(m.at)}</span></span>
      </div>`;
  }

  /* ---------- mensagem do chat ---------- */
  function msgBubble(m, me) {
    var mine = m.senderId === me.id || m.senderName === me.nome;
    var isDev = m.senderRole === 'dev';
    return html`
      <div class="msg ${mine ? 'mine' : ''}">
        <span class="avatar sm ${isDev ? '' : 'gray'}">${U.initials(m.senderName)}</span>
        <span class="msg-body">
          <span class="msg-head">
            <b>${m.senderName || 'Usuário'}</b>
            ${isDev ? raw('<span class="badge badge-brand no-dot">Equipe JR</span>') : ''}
            <span class="muted small">${U.dt(m.at)}</span>
          </span>
          <span class="msg-text">${m.message}</span>
        </span>
      </div>`;
  }

  Pages.suporte = {
    title: 'Suporte',
    sel: null,          /* id do ticket aberto */
    filter: { status: '', prio: '', cat: '', tenant: '', q: '', sort: 'recent', mine: false },
    _list: [],
    _tinfo: {},         /* cache do retrato de billing por tenantId (painel dev) */
    render: function () { return C.skeleton('table'); },
    mounted: function (root, params, query) {
      var self = this;
      this.rerender = function () { self.fill(document.getElementById('page-root')); };
      setTimeout(function () {
        self.fill(root);
        /* chegou pela tela Assinatura ("Pedir ativação"): abre o formulário
           já com a categoria Faturamento e assunto sugerido */
        if (query && query.novoticket) {
          self.newModal(root, {
            categoria: query.categoria === 'faturamento' ? 'faturamento' : '',
            assunto: query.assunto || ''
          });
        }
      }, 0);
    },
    onStoreChanged: function () { /* produção atualiza por fetch próprio */ },

    fill: function (root) {
      var self = this;
      var isDev = Support.isDev();
      var me = Auth.me() || {};
      /* v8 · busca server-side + paginação (dev): PAGE por página, "carregar
         mais" amplia o limit; a busca (q) filtra no BANCO (assunto, descrição,
         solicitante, empresa) — a fila continua usável com centenas de tickets */
      var PAGE = 100;
      var pages = Math.max(1, self._pages || 1);
      var opts = isDev ? { q: String(self.filter.q || '').trim(), limit: PAGE * pages } : {};
      Support.list(opts).then(function (rawList) {
        /* USUÁRIO: somente tickets da própria empresa (produção o backend já filtra;
           demo/final garantem o filtro no cliente). DEV: tudo. */
        var myTenant = (Store.state.session || {}).tenantId || (Store.state.tenant || {}).id;
        var list = isDev ? rawList : rawList.filter(function (t) { return !t.tenantId || !myTenant || t.tenantId === myTenant; });
        self._list = list;
        self._hasMore = isDev && rawList.length >= PAGE * pages;
        if (self.sel) {
          var t = list.filter(function (x) { return x.id === self.sel; })[0];
          if (t) { self.detail(root, t, me, isDev); return; }
          self.sel = null;
        }
        self.overview(root, list, me, isDev);
      }).catch(function (e) {
        mount(root, C.errorPanel(e));
      });
    },

    /* ================= FILTROS / ORDENAÇÃO ================= */
    applyFilters: function (list, isDev) {
      var f = this.filter;
      var me = Auth.me() || {};
      var out = list.filter(function (t) {
        if (f.status && t.status !== f.status) return false;
        if (isDev && f.mine && t.assigneeId !== me.id) return false;
        if (isDev && f.prio && t.prioridade !== f.prio) return false;
        if (isDev && f.cat && t.categoria !== f.cat) return false;
        if (isDev && f.tenant && (t.tenantName || '') !== f.tenant) return false;
        if (f.q) {
          var q = f.q.toLowerCase();
          if (String(t.assunto).toLowerCase().indexOf(q) === -1 && String(t.numero).indexOf(q) === -1 &&
              String(t.requesterName || '').toLowerCase().indexOf(q) === -1 &&
              (!isDev || String(t.tenantName || '').toLowerCase().indexOf(q) === -1)) return false;
        }
        return true;
      });
      if (isDev) {
        if (f.sort === 'oldest') out = out.slice().sort(function (a, b) { return (a.updatedAt || 0) - (b.updatedAt || 0); });
        else if (f.sort === 'priority') out = out.slice().sort(function (a, b) {
          var pa = PRIO_ORDER[a.prioridade] != null ? PRIO_ORDER[a.prioridade] : 9;
          var pb = PRIO_ORDER[b.prioridade] != null ? PRIO_ORDER[b.prioridade] : 9;
          return pa !== pb ? pa - pb : (b.updatedAt || 0) - (a.updatedAt || 0);
        });
        else out = out.slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      }
      return out;
    },
    hasFilters: function (isDev) {
      var f = this.filter;
      return !!(f.status || f.q || (isDev && (f.prio || f.cat || f.tenant || f.mine || f.sort !== 'recent')));
    },

    /* ================= VISÃO GERAL / LISTA ================= */
    overview: function (root, list, me, isDev) {
      var self = this;
      var flt = this.applyFilters(list, isDev);
      var count = function (st) { return list.filter(function (t) { return t.status === st; }).length; };
      var open = list.filter(function (t) { return t.status !== 'resolvido' && t.status !== 'fechado'; });
      var companies = isDev
        ? Object.keys(U.groupBy(list, function (t) { return t.tenantName || '—'; })).sort()
        : [];
      var myQueue = isDev && me
        ? list.filter(function (t) { return t.assigneeId === me.id && t.status !== 'resolvido' && t.status !== 'fechado'; })
        : [];

      mount(root, html`
        ${C.pageHead(isDev ? 'Atendimento — Suporte' : 'Suporte',
          isDev ? 'central multi-empresa: todos os chamados das empresas cliente em um só lugar' : 'abra um chamado e acompanhe a conversa com a nossa equipe',
          raw('<button type="button" class="btn btn-primary" data-new>' + I('plus', 15) + (isDev ? ' Novo ticket' : ' Abrir ticket') + '</button>'))}

        ${isDev ? html`
        <div class="kpi-grid mb-3">
          ${C.kpi({ lbl: 'Na fila (abertos)', val: count('aberto'), icon: 'mail', tone: 'warn' })}
          ${C.kpi({ lbl: 'Em atendimento', val: count('em_andamento'), icon: 'headset', tone: 'info' })}
          ${C.kpi({ lbl: 'Aguardando cliente', val: count('aguardando_cliente'), icon: 'clock', tone: 'mut' })}
          ${C.kpi({ lbl: 'Aguardando equipe', val: count('aguardando_equipe'), icon: 'users', tone: 'info' })}
          ${C.kpi({ lbl: 'Minha fila', val: myQueue.length, sub: 'atribuídos a você', icon: 'check', tone: 'brand' })}
          ${C.kpi({ lbl: 'Resolvidos', val: list.filter(function (t) { return t.status === 'resolvido' || t.status === 'fechado'; }).length, icon: 'check-circle', tone: 'ok' })}
        </div>` : html`
        <div class="kpi-grid mb-3">
          ${C.kpi({ lbl: 'Chamados abertos', val: open.length, icon: 'headset', tone: 'info' })}
          ${C.kpi({ lbl: 'Aguardando sua resposta', val: count('aguardando_cliente'), icon: 'clock', tone: 'warn' })}
          ${C.kpi({ lbl: 'Resolvidos', val: list.filter(function (t) { return t.status === 'resolvido' || t.status === 'fechado'; }).length, icon: 'check', tone: 'ok' })}
        </div>`}

        <div class="toolbar">
          <span class="search-box">${raw(I('search', 15))}
            <input class="input" id="tk-q" type="search" placeholder="Buscar assunto, nº${isDev ? ', empresa ou solicitante' : ''}…" value="${this.filter.q}" aria-label="Buscar tickets"></span>
          <select class="select" id="tk-status" aria-label="Filtrar por status">
            <option value="">Todos os status</option>
            ${Object.keys(STATUS_META).map(function (s) {
              return html`<option value="${s}" ${self.filter.status === s ? raw('selected') : ''}>${stLabel(s, isDev)}</option>`;
            })}
          </select>
          ${isDev ? html`
          <select class="select" id="tk-prio" aria-label="Filtrar por prioridade">
            <option value="">Todas as prioridades</option>
            ${Object.keys(PRIO_META).map(function (p) {
              return html`<option value="${p}" ${self.filter.prio === p ? raw('selected') : ''}>${PRIO_META[p].label}</option>`;
            })}
          </select>
          <select class="select" id="tk-cat" aria-label="Filtrar por categoria">
            <option value="">Todas as categorias</option>
            ${Object.keys(CAT_META).map(function (c) {
              return html`<option value="${c}" ${self.filter.cat === c ? raw('selected') : ''}>${CAT_META[c]}</option>`;
            })}
          </select>
          <select class="select" id="tk-tenant" aria-label="Filtrar por empresa">
            <option value="">Todas as empresas</option>
            ${companies.map(function (cName) {
              return html`<option value="${cName}" ${self.filter.tenant === cName ? raw('selected') : ''}>${cName}</option>`;
            })}
          </select>
          <select class="select" id="tk-sort" aria-label="Ordenar">
            <option value="recent" ${this.filter.sort === 'recent' ? raw('selected') : ''}>Mais recentes</option>
            <option value="oldest" ${this.filter.sort === 'oldest' ? raw('selected') : ''}>Mais antigos</option>
            <option value="priority" ${this.filter.sort === 'priority' ? raw('selected') : ''}>Prioridade primeiro</option>
          </select>
          <button type="button" class="btn btn-sm ${this.filter.mine ? 'btn-primary' : 'btn-ghost'}" id="tk-mine" title="Somente tickets atribuídos a você" aria-pressed="${!!this.filter.mine}">
            ${raw(I('headset', 14))} Minha fila <span class="badge no-dot ${this.filter.mine ? 'badge-mut' : 'badge-brand'}">${myQueue.length}</span>
          </button>` : ''}
        </div>

        <div class="panel">
          <div class="panel-head">
            <h3>${isDev ? 'Todos os tickets' : 'Tickets da minha empresa'} <span class="muted" style="font-weight:400">(${flt.length}${flt.length !== list.length ? ' de ' + list.length : ''})</span></h3>
            ${this.hasFilters(isDev) ? raw('<button type="button" class="btn btn-sm btn-ghost" data-clear>' + I('x', 13) + ' Limpar filtros</button>') : ''}
          </div>
          ${flt.length ? html`<div class="ticket-list">${flt.map(function (t) { return ticketRow(t, isDev, me.id); })}</div>
            ${isDev && self._hasMore ? html`<div style="padding:12px;text-align:center">
              <button type="button" class="btn btn-outline btn-sm" data-more>${raw(I('chevron-down', 14))} Carregar mais chamados</button>
              <p class="field-hint">mostrando os ${list.length} mais recentes — a busca filtra no servidor</p></div>` : ''}`
            : (list.length === 0
              ? C.empty('headset', isDev ? 'Nenhum ticket ainda' : 'Tudo certo por aqui!',
                  isDev ? 'Quando as empresas cliente abrirem tickets, eles aparecem aqui para atendimento.'
                    : 'Não encontrou um problema? Se precisar de ajuda com estoque, vendas ou cobrança, abra um ticket — a equipe JR Sistemas responde em horário comercial.',
                  raw('<button type="button" class="btn btn-primary" data-new>' + I('plus', 15) + (isDev ? ' Abrir primeiro ticket' : ' Abrir meu primeiro ticket') + '</button>'))
              : C.empty('search', 'Nada encontrado', 'Ajuste a busca ou os filtros para ver resultados.', raw('<button type="button" class="btn" data-clear>Limpar filtros</button>')))}
        </div>

        ${isDev && companies.length > 1 ? self.companiesPanel(companies, list) : ''}

        ${!isDev ? html`<div class="panel mt-4 sup-help">
          <div class="panel-head"><h3>Como funciona</h3></div>
          <ul class="mini-list">
            <li class="mini-row"><span class="mr-main"><span class="mr-name">1 · Descreva o problema</span><span class="mr-sub">assunto, categoria e detalhes do que aconteceu</span></span>${raw(I('edit', 18))}</li>
            <li class="mini-row"><span class="mr-main"><span class="mr-name">2 · Nossa equipe responde</span><span class="mr-sub">a conversa acontece aqui mesmo, com histórico completo</span></span>${raw(I('headset', 18))}</li>
            <li class="mini-row"><span class="mr-main"><span class="mr-name">3 · Você fecha quando resolver</span><span class="mr-sub">só quem abriu o ticket encerra — e pode reabrir comentando</span></span>${raw(I('check', 18))}</li>
          </ul>
        </div>` : ''}`);

      /* bindings */
      var qEl = root.querySelector('#tk-q');
      if (qEl) qEl.addEventListener('input', U.debounce(function () {
        self.filter.q = qEl.value;
        if (isDev) {
          /* dev: a busca roda no SERVIDOR (fila global pode ter centenas) */
          self._pages = 1;
          self.fill(root);
        } else {
          var list2 = self._list || [];
          self.overview(root, list2, me, isDev);
          var nq = root.querySelector('#tk-q'); if (nq) { nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); }
        }
      }, isDev ? 450 : 300));
      var more = root.querySelector('[data-more]');
      if (more) more.addEventListener('click', function () {
        self._pages = (self._pages || 1) + 1;
        self.fill(root);
      });
      var bindSel = function (id, key) {
        var el = root.querySelector(id);
        if (el) el.addEventListener('change', function () { self.filter[key] = el.value; self.fill(root); });
      };
      bindSel('#tk-status', 'status');
      bindSel('#tk-prio', 'prio');
      bindSel('#tk-cat', 'cat');
      bindSel('#tk-tenant', 'tenant');
      bindSel('#tk-sort', 'sort');
      var mineBtn = root.querySelector('#tk-mine');
      if (mineBtn) mineBtn.addEventListener('click', function () {
        self.filter.mine = !self.filter.mine;
        self.fill(root);
      });
      var cl = root.querySelector('[data-clear]');
      if (cl) cl.addEventListener('click', function () { self.filter = { status: '', prio: '', cat: '', tenant: '', q: '', sort: 'recent', mine: false }; self.fill(root); });
      var nb = root.querySelector('[data-new]');
      if (nb) nb.addEventListener('click', function () { self.newModal(root, isDev); });
      root.querySelectorAll('[data-open]').forEach(function (b) {
        b.addEventListener('click', function () {
          self.sel = b.dataset.open;
          self.fill(root);
          window.scrollTo(0, 0);
        });
      });
      root.querySelectorAll('[data-company]').forEach(function (b) {
        b.addEventListener('click', function () {
          self.filter.tenant = b.dataset.company;
          self.fill(root);
          window.scrollTo(0, 0);
        });
      });
    },

    /* ---------- resumo por empresa (dashboard dev) ---------- */
    companiesPanel: function (companies, list) {
      var rows = companies.map(function (name) {
        var ts = list.filter(function (t) { return (t.tenantName || '—') === name; });
        return {
          name: name,
          fila: ts.filter(function (t) { return t.status === 'aberto'; }).length,
          atendimento: ts.filter(function (t) { return t.status === 'em_andamento'; }).length,
          aguardando: ts.filter(function (t) { return t.status === 'aguardando_cliente' || t.status === 'aguardando_equipe'; }).length,
          resolvidos: ts.filter(function (t) { return t.status === 'resolvido' || t.status === 'fechado'; }).length,
          total: ts.length
        };
      }).sort(function (a, b) { return (b.fila + b.atendimento + b.aguardando) - (a.fila + a.atendimento + a.aguardando); });
      return html`
        <div class="panel mt-4">
          <div class="panel-head"><h3>Resumo por empresa</h3><span class="panel-sub">clique numa empresa para filtrar os chamados</span></div>
          <div class="table-wrap" style="border:none"><table class="table">
            <thead><tr><th>Empresa</th><th class="num">Na fila</th><th class="num">Em atendimento</th><th class="num">Aguardando</th><th class="num">Resolvidos</th><th class="num">Total</th></tr></thead>
            <tbody>${rows.map(function (r) {
              return html`<tr>
                <td><button type="button" class="btn btn-sm btn-ghost" data-company="${r.name}" style="text-align:left">${raw(I('store', 13))} <b>${r.name}</b></button></td>
                <td class="num">${r.fila ? raw('<span class="badge badge-warn no-dot">' + r.fila + '</span>') : html`<span class="muted">0</span>`}</td>
                <td class="num">${r.atendimento ? raw('<span class="badge badge-info no-dot">' + r.atendimento + '</span>') : html`<span class="muted">0</span>`}</td>
                <td class="num">${r.aguardando ? raw('<span class="badge badge-brand no-dot">' + r.aguardando + '</span>') : html`<span class="muted">0</span>`}</td>
                <td class="num">${r.resolvidos ? raw('<span class="badge badge-ok no-dot">' + r.resolvidos + '</span>') : html`<span class="muted">0</span>`}</td>
                <td class="num"><b>${r.total}</b></td>
              </tr>`;
            })}</tbody></table></div>
        </div>`;
    },

    /* ================= DETALHE / CONVERSA =================
       Botões CONTEXTUAIS por estado (o dropdown livre deu lugar a ações com
       significado): a resposta move a bola sozinha; aqui ficam as ações
       explícitas — cada uma só aparece quando faz sentido para o estado. */
    detail: function (root, t, me, isDev) {
      var self = this;
      Support.messages(t.id).then(function (msgs) {
        var closed = t.status === 'resolvido' || t.status === 'fechado';
        var owner = isOwner(t, me);
        var chat = msgs.filter(function (m) { return (m.tipo || 'mensagem') === 'mensagem'; });
        var st = t.status;

        /* ---- ações do DEV por estado (liberdade total, guiada) ---- */
        var devBtns = [];
        if (isDev) {
          if (st === 'aberto' || st === 'aguardando_equipe')
            devBtns.push(raw('<button type="button" class="btn btn-primary btn-sm" data-take>' + I('headset', 14) + ' Atender</button>'));
          if (st !== 'resolvido' && st !== 'fechado' && st !== 'aberto')
            devBtns.push(raw('<button type="button" class="btn btn-sm" data-unqueue>' + I('arrow-left', 14) + ' Voltar à fila</button>'));
          if (st !== 'resolvido' && st !== 'fechado')
            devBtns.push(raw('<button type="button" class="btn btn-sm" data-resolve>' + I('check', 14) + ' Resolver</button>'));
          if (st === 'resolvido')
            devBtns.push(raw('<button type="button" class="btn btn-sm" data-close-final>' + I('check-circle', 14) + ' Fechar</button>'));
          if (closed)
            devBtns.push(raw('<button type="button" class="btn btn-sm" data-reopen>' + I('refresh', 14) + ' Reabrir</button>'));
        }

        /* ---- ações do USUÁRIO dono (sem dropdown livre) ---- */
        var userBtns = [];
        if (!isDev && owner) {
          if (st === 'resolvido')
            userBtns.push(raw('<button type="button" class="btn btn-primary" data-close-final>' + I('check-circle', 15) + ' Confirmar resolução</button>'));
          else if (!closed)
            userBtns.push(raw('<button type="button" class="btn" data-close>' + I('check', 15) + ' Encerrar chamado</button>'));
        }

        /* ---- faixa "de quem é a bola" ---- */
        var ballTxt = isDev
          ? (st === 'aguardando_cliente' ? 'Você respondeu — aguardando o cliente.' : 'A bola está com a equipe JR Sistemas.')
          : (st === 'aguardando_cliente'
            ? '⏳ A equipe respondeu — aguardando VOCÊ. Continue a conversa abaixo ou encerre se resolveu.'
            : 'A equipe JR Sistemas está cuidando do seu chamado.');

        mount(root, html`
          <div class="page-head">
            <div style="min-width:0">
              <button type="button" class="btn btn-ghost btn-sm mb-2" data-back>${raw(I('arrow-left', 14))} Voltar aos tickets</button>
              <h2 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span class="mono muted">#${t.numero}</span> ${t.assunto} ${stBadge(t.status, isDev)}</h2>
              <p class="ph-sub">
                ${isDev ? html`<b>${t.tenantName || '—'}</b> · ${t.requesterName || '—'} (${t.requesterEmail || ''}) · ` : ''}
                aberto ${U.date(t.createdAt)} · <span class="badge badge-mut no-dot">${CAT_META[t.categoria] || t.categoria}</span> ${prBadge(t.prioridade)}
                ${isDev && t.assigneeName ? html` · ${raw(I('headset', 12))} responsável: <b>${t.assigneeName === me.nome ? 'você' : t.assigneeName}</b>` : ''}
              </p>
            </div>
            ${(devBtns.length || userBtns.length) ? html`<div class="page-actions" style="flex-wrap:wrap;gap:8px">
              ${userBtns}
              ${devBtns}
              ${isDev ? html`
              <select class="select" id="dt-prio" aria-label="Alterar prioridade">
                ${Object.keys(PRIO_META).map(function (p) { return html`<option value="${p}" ${t.prioridade === p ? raw('selected') : ''}>Prioridade: ${PRIO_META[p].label}</option>`; })}
              </select>
              <select class="select" id="dt-cat" aria-label="Alterar categoria">
                ${Object.keys(CAT_META).map(function (c) { return html`<option value="${c}" ${t.categoria === c ? raw('selected') : ''}>${CAT_META[c]}</option>`; })}
              </select>
              <details class="advanced-status">
                <summary class="btn btn-sm btn-ghost">${raw(I('settings', 13))} Status avançado</summary>
                <select class="select" id="dt-status" aria-label="Status avançado">
                  ${Object.keys(STATUS_META).map(function (s) { return html`<option value="${s}" ${t.status === s ? raw('selected') : ''}>${STATUS_META[s].label}</option>`; })}
                </select>
              </details>` : ''}
            </div>` : ''}
          </div>

          ${!closed ? html`<div class="auth-note mb-3 ${st === 'aguardando_cliente' && !isDev ? 'is-warn' : ''}">${raw(I(st === 'aguardando_cliente' && !isDev ? 'clock' : 'info', 15))}<span>${ballTxt}</span></div>` : ''}

          ${isDev && t.tenantId ? self.billingPanel(t) : ''}

          <div class="panel">
            <div class="panel-head"><h3>Conversa</h3><span class="panel-sub">${chat.length} ${chat.length === 1 ? 'mensagem' : 'mensagens'}${msgs.length !== chat.length ? ' · ' + (msgs.length - chat.length) + ' evento' + (msgs.length - chat.length > 1 ? 's' : '') + ' de status' : ''}</span></div>
            <div class="ticket-thread">
              <div class="msg">
                <span class="avatar sm gray">${U.initials(t.requesterName)}</span>
                <span class="msg-body">
                  <span class="msg-head"><b>${t.requesterName || 'Cliente'}</b>
                    ${isDev ? raw('<span class="badge badge-mut no-dot">' + U.esc(t.tenantName || '') + '</span>') : ''}
                    <span class="muted small">${U.dt(t.createdAt)}</span></span>
                  <span class="msg-text">${t.descricao}</span>
                </span>
              </div>
              ${msgs.map(function (m) { return (m.tipo || 'mensagem') === 'evento' ? eventLine(m) : msgBubble(m, me); })}
            </div>
            ${closed ? html`
              <div class="auth-note mb-3" style="border-color:var(--ok-line);background:var(--ok-bg);color:var(--ok)">
                ${raw(I('check-circle', 15))}<span>Este ticket foi ${stLabel(t.status, isDev).toLowerCase()}. Envie uma mensagem para reabrir a conversa.</span></div>` : ''}
            <form id="reply-form" novalidate>
              <div class="reply-box">
                <textarea class="textarea" id="reply-msg" rows="3" maxlength="4000" placeholder="${isDev ? 'Escreva a resposta ao cliente — ao enviar, o ticket passa a aguardar o cliente…' : 'Escreva sua mensagem para a equipe de suporte…'}" aria-label="Mensagem"></textarea>
                <button class="btn btn-primary" type="submit" id="reply-btn" style="align-self:flex-end">${raw(I('mail', 15))} Enviar</button>
              </div>
              <p class="field-hint">Ctrl + Enter envia${isDev ? ' · sua resposta devolve a bola para o cliente' : ' · a equipe JR responde em horário comercial'}.</p>
            </form>
          </div>`);

        root.querySelector('[data-back]').addEventListener('click', function () { self.sel = null; self.fill(root); window.scrollTo(0, 0); });
        var sc = root.querySelector('.ticket-thread'); if (sc) sc.scrollTop = sc.scrollHeight;

        var form = root.querySelector('#reply-form');
        form.addEventListener('submit', function (e) { e.preventDefault(); self.sendReply(root, t); });
        var ta = root.querySelector('#reply-msg');
        /* v13 · rascunho no banco (por usuário+ticket) com cópia local offline:
           o texto volta mesmo trocando de navegador — e não se perde se o
           login cair no meio da escrita */
        Draft.get(t.id, function (saved) { if (saved && !ta.value) ta.value = saved; });
        ta.addEventListener('input', U.debounce(function () {
          Draft.save(t.id, ta.value);
        }, 400));
        ta.addEventListener('keydown', function (e) {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); self.sendReply(root, t); }
        });

        /* helper: atualiza e recarrega com toast */
        var go = function (payload, msg, tone) {
          Support.update(payload).then(function () {
            if (msg) UI.toast(msg, { type: tone || 'ok' });
            self.fill(root); Bus.emit('shell:refresh');
          }).catch(function (e2) { UI.toast(e2.message, { type: 'err' }); });
        };

        /* usuário dono: encerrar / confirmar resolução (sem dropdown) */
        var cb = root.querySelector('[data-close]');
        if (cb) cb.addEventListener('click', function () {
          UI.confirm({ title: 'Encerrar chamado?', text: 'O ticket será marcado como resolvido. Se precisar, você pode reabrir enviando uma nova mensagem.', okText: 'Encerrar' })
            .then(function (ok) {
              if (!ok) return;
              go({ id: t.id, status: 'resolvido' }, 'Ticket resolvido! 🎉');
            });
        });
        var cfBtns = root.querySelectorAll('[data-close-final]');
        cfBtns.forEach(function (btn) {
          btn.addEventListener('click', function () {
            UI.confirm({ title: 'Fechar definitivamente?', text: 'Fechar encerra o histórico do chamado. Reabrir é possível enviando uma nova mensagem.', okText: 'Fechar' })
              .then(function (ok) {
                if (!ok) return;
                go({ id: t.id, status: 'fechado' }, 'Ticket fechado.');
              });
          });
        });

        /* dev: ações contextuais */
        var tk = root.querySelector('[data-take]');
        if (tk) tk.addEventListener('click', function () {
          Support.take(t.id).then(function () {
            UI.toast('Você assumiu o ticket — agora ele está em atendimento.', { type: 'ok' });
            self.fill(root); Bus.emit('shell:refresh');
          }).catch(function (e2) { UI.toast(e2.message, { type: 'err' }); });
        });
        var uq = root.querySelector('[data-unqueue]');
        if (uq) uq.addEventListener('click', function () {
          go({ id: t.id, status: 'aberto', assigneeId: null }, 'Ticket devolvido à fila.');
        });
        var rv = root.querySelector('[data-resolve]');
        if (rv) rv.addEventListener('click', function () {
          go({ id: t.id, status: 'resolvido' }, 'Ticket marcado como resolvido — aguardando confirmação do cliente.');
        });
        var ro = root.querySelector('[data-reopen]');
        if (ro) ro.addEventListener('click', function () {
          go({ id: t.id, status: 'em_andamento', assigneeId: (me || {}).id || null }, 'Ticket reaberto e atribuído a você.');
        });

        /* dev: mudanças livres de prioridade/categoria (guard permite só dev) */
        var prSel = root.querySelector('#dt-prio');
        if (prSel) prSel.addEventListener('change', function () {
          Support.update({ id: t.id, prioridade: prSel.value }).then(function () {
            UI.toast('Prioridade: ' + PRIO_META[prSel.value].label, { type: 'ok' });
          }).catch(function (e2) { UI.toast(e2.message, { type: 'err' }); });
        });
        var ctSel = root.querySelector('#dt-cat');
        if (ctSel) ctSel.addEventListener('change', function () {
          Support.update({ id: t.id, categoria: ctSel.value }).then(function () {
            UI.toast('Categoria: ' + (CAT_META[ctSel.value] || ctSel.value), { type: 'ok' });
            self.fill(root);
          }).catch(function (e2) { UI.toast(e2.message, { type: 'err' }); });
        });
        /* dev: status avançado (qualquer estado, liberdade total) */
        var stSel = root.querySelector('#dt-status');
        if (stSel) stSel.addEventListener('change', function () {
          go({ id: t.id, status: stSel.value }, 'Status: ' + STATUS_META[stSel.value].label);
        });

        if (isDev && t.tenantId) self.bindBillingPanel(root, t);
      }).catch(function (e) { mount(root, C.errorPanel(e)); });
    },

    /* ================= PAINEL DE PLANO (somente dev) =================
       No atendimento, a equipe JR vê o status da empresa e gerencia a
       assinatura: ATIVAR/ESTENDER plano com prazo definido (modal) ou
       suspender o acesso. Substitui o antigo "toggle" binário/infinito. */
    billingPanel: function (t) {
      return html`
        <div class="panel mb-4" id="dev-billing" data-tenant="${t.tenantId}" style="border-color:rgba(234,88,12,.35)">
          <div class="panel-head"><h3>Plano da empresa · ${t.tenantName || ''}</h3><span class="panel-sub">ferramenta da equipe JR</span></div>
          <div id="db-info"><p class="muted small">Carregando dados da empresa…</p></div>
          <div class="flex gap-2 items-center mt-2" style="flex-wrap:wrap">
            <button type="button" class="btn btn-primary btn-sm" id="db-activate">${raw(I('zap', 14))} Ativar / estender plano</button>
            <button type="button" class="btn btn-danger-ghost btn-sm" id="db-suspend">${raw(I('lock', 14))} Suspender acesso</button>
          </div>
          <p class="field-hint mt-2">Ativação com prazo real (30/90/180/365 dias ou data personalizada). Use após confirmar o pagamento (Pix etc.) — a liberação vale na hora para o cliente, sem re-login.</p>
        </div>`;
    },
    bindBillingPanel: function (root, t) {
      var self = this;
      var infoBox = root.querySelector('#db-info');
      var paint = function (r) {
        if (!r) r = {};
        if (!infoBox) return;
        self._tinfo[t.tenantId] = r;
        var lbl = { trialing: 'Teste grátis', active: 'Ativo', past_due: 'Pgto pendente', read_only: 'Suspenso', canceled: 'Cancelado' };
        var badge = r.status === 'active' ? 'badge-ok' : (r.status === 'trialing' ? 'badge-warn' : 'badge-danger');
        var planName = r.plan_id === 'dev' ? 'Dev (interno)' : (function () { var pl = Billing.planById(r.plan_id); return pl ? pl.name : (r.plan_id || '—'); })();
        var bits = ['Status: <span class="badge ' + badge + '">' + U.esc(lbl[r.status] || r.status || '—') + '</span>'];
        bits.push('Plano: <b>' + U.esc(String(planName)) + '</b>');
        if (r.status === 'trialing' && r.trial_ends_at)
          bits.push('teste até <b>' + U.date(r.trial_ends_at) + '</b>');
        if (r.plan_expires_at || r.planExpiresAt) {
          var expMs = r.planExpiresAt || new Date(r.plan_expires_at).getTime();
          var dLeft = Math.ceil((expMs - Date.now()) / 864e5);
          bits.push('vence em <b>' + U.datetime(expMs) + '</b>' + (dLeft > 0 ? ' <span class="badge ' + (dLeft <= 5 ? 'badge-warn' : 'badge-mut') + ' no-dot">' + dLeft + 'd</span>' : ' <span class="badge badge-danger no-dot">vencido</span>'));
        } else if (r.status === 'active' && r.next_charge_at) {
          bits.push('próxima cobrança <b>' + U.date(r.next_charge_at) + '</b>');
        }
        if (r.canceled_at) bits.push('cancelado ' + U.date(r.canceled_at));
        infoBox.innerHTML = '<p class="small" style="margin:0">' + bits.join(' · ') + '</p>';
      };

      /* cache da sessão → sem refetch a cada re-render */
      if (self._tinfo[t.tenantId]) paint(self._tinfo[t.tenantId]);
      ApiClient.request('billing.tenant_info', { tenantId: t.tenantId }).then(paint).catch(function () {
        if (infoBox && !self._tinfo[t.tenantId]) infoBox.innerHTML = '<p class="muted small">Não foi possível carregar os dados da empresa.</p>';
      });

      var act = root.querySelector('#db-activate');
      if (act) act.addEventListener('click', function () {
        self.planModal(t, self._tinfo[t.tenantId] || {}, function (result) {
          /* callback pós-ativação: repinta painel e listas com o estado novo */
          paint(result.info);
          self.fill(root);
        });
      });
      var sus = root.querySelector('#db-suspend');
      if (sus) sus.addEventListener('click', function () {
        UI.confirm({
          title: 'Suspender acesso da empresa?',
          text: '"' + (t.tenantName || '') + '" entra em modo leitura (PDV e escrita bloqueados). Use para cancelamentos/estornos.',
          danger: true, okText: 'Suspender'
        }).then(function (ok) {
          if (!ok) return;
          var doSuspend = function () {
            UI.busy(sus, true);
            ApiClient.request('billing.suspend_tenant', { tenantId: t.tenantId, reason: 'suspenso pela equipe JR via ticket #' + t.numero }).then(function () {
              UI.busy(sus, false);
              UI.toast('Acesso suspenso.', { type: 'warn' });
              paint({ status: 'read_only', plan_id: null, canceled_at: new Date().toISOString() });
              self._tinfo[t.tenantId] = { status: 'read_only', plan_id: null, canceled_at: new Date().toISOString() };
              Bus.emit('billing:changed'); Bus.emit('shell:refresh');
            }).catch(function (e) {
              UI.busy(sus, false);
              if (e && e.code === 'DEV_PIN_REQUIRED') {
                UI.toast(e.message, { type: 'warn' });
                self.askDevPin(doSuspend);
                return;
              }
              UI.toast(e.message, { type: 'err' });
            });
          };
          doSuspend();
        });
      });
    },

    /* ================= DevPlanActivationModal =================
       Ativa/estende plano com PRAZO. O front calcula o vencimento:
         base = hoje (ou o vencimento atual, se estendendo plano ativo)
         plan_expires_at = base + dias × 86400000  (ou data custom)
       Depois: ApiClient 'billing.activate_plan' → Store.update (tenant
       local, se for o da sessão) → Bus 'billing:changed' + 'shell:refresh'
       para destravar o PDV do cliente instantaneamente. */
    planModal: function (t, info, onDone) {
      var self = this;
      info = info || {};
      var PLANS = Billing.PLANS;
      var curPlanId = (info.plan_id && Billing.planById(info.plan_id)) ? info.plan_id : '';
      var curExpMs = info.planExpiresAt || (info.plan_expires_at ? new Date(info.plan_expires_at).getTime() : null);
      var isActivePaid = info.status === 'active' && !!curPlanId && curPlanId !== 'dev';
      var canExtend = isActivePaid && curExpMs && curExpMs > Date.now();
      var todayISO = (function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })(new Date());

      UI.modal({
        title: 'Ativar / estender plano', size: 'lg',
        sub: (t.tenantName || 'Empresa') + ' · defina plano, duração e motivo — o vencimento é calculado automaticamente',
        body: html`<form id="dp-form" novalidate>
          <div class="field"><label for="dp-plan">Plano <span class="req">*</span></label>
            <select class="select" id="dp-plan" name="planId" data-autofocus>
              ${PLANS.map(function (pl) {
                return html`<option value="${pl.id}" ${curPlanId === pl.id ? raw('selected') : ''}>${pl.name} — R$ ${pl.monthly}/mês · R$ ${pl.annualTotal}/ano</option>`;
              })}
            </select>
            ${isActivePaid ? html`<p class="field-hint">Plano atual: <b>${Billing.planById(curPlanId).name}</b>${curExpMs ? html` · vence ${U.datetime(curExpMs)}` : ''} — selecionar outro plano substitui o atual.</p>` : ''}</div>

          <div class="field-row">
            <div class="field"><label for="dp-duration">Duração <span class="req">*</span></label>
              <select class="select" id="dp-duration" name="duration">
                <option value="30" selected>30 dias (1 mês)</option>
                <option value="90">90 dias (3 meses)</option>
                <option value="180">180 dias (6 meses)</option>
                <option value="365">365 dias (anual)</option>
                <option value="custom">Data personalizada…</option>
              </select></div>
            <div class="field" id="dp-custom-wrap" hidden><label for="dp-custom">Vencimento em <span class="req">*</span></label>
              <input class="input" type="date" id="dp-custom" name="customDate" min="${todayISO}">
              <p class="field-hint">O plano vale até este dia (23h59).</p></div>
          </div>

          <div class="field"><label for="dp-reason">Motivo da ativação <span class="req">*</span></label>
            <select class="select" id="dp-reason" name="reason">
              <option value="pix" selected>Pagamento confirmado (Pix)</option>
              <option value="cartao">Pagamento confirmado (cartão)</option>
              <option value="cortesia">Cortesia / bônus</option>
              <option value="reativacao">Reativação de cliente</option>
              <option value="bug">Compensação por bug/atraso</option>
              <option value="outro">Outro</option>
            </select></div>

          ${canExtend ? html`
          <div class="field">
            <label class="field-label">Contagem do prazo</label>
            <div class="pay-method-pick" role="radiogroup" aria-label="Contagem do prazo">
              <label class="pm-opt sel"><input type="radio" name="dpBase" value="extend" checked>
                <span><b>Estender o prazo atual</b><span>Soma os ${Math.max(0, Math.ceil((curExpMs - Date.now()) / 864e5))} dias restantes aos novos dias — vencimento atual: ${U.date(curExpMs)}</span></span></label>
              <label class="pm-opt"><input type="radio" name="dpBase" value="reset">
                <span><b>Recomeçar de hoje</b><span>Descarta o prazo restante e conta a nova duração a partir de agora</span></span></label>
            </div>
          </div>` : ''}

          <div id="dp-preview" class="auth-note" style="margin-bottom:14px" aria-live="polite"></div>

          <label class="chk" style="display:inline-flex;align-items:center;gap:8px;font-size:.83rem;color:var(--ink-2);cursor:pointer">
            <input type="checkbox" id="dp-log" checked style="width:16px;height:16px;accent-color:var(--brand)">
            Registrar mensagem no ticket #${t.numero} para o cliente</label>

          <div class="field" id="dp-pin-wrap" hidden>
            <label for="dp-pin">PIN de segurança da equipe JR <span class="req">*</span></label>
            <input class="input" id="dp-pin" type="password" autocomplete="off" placeholder="PIN (secret DEV_PIN)">
            <p class="field-hint">O servidor pediu o 2º fator para operações de cobrança — fica salvo só nesta sessão.</p>
          </div>
          <div id="dp-err"></div>
        </form>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>' +
          '<button type="button" class="btn btn-danger-ghost" data-suspend>' + I('lock', 15) + ' Suspender acesso</button>' +
          '<button type="button" class="btn btn-primary" data-ok>' + I('zap', 15) + ' Ativar plano</button>'),
        onMount: function (panel, close) {
          var durSel = panel.querySelector('#dp-duration');
          var customWrap = panel.querySelector('#dp-custom-wrap');
          var customInp = panel.querySelector('#dp-custom');
          var planSel = panel.querySelector('#dp-plan');
          var reasonSel = panel.querySelector('#dp-reason');
          var prevBox = panel.querySelector('#dp-preview');

          /* radio cards (mesmo padrão do checkout) */
          panel.querySelectorAll('.pm-opt').forEach(function (opt) {
            opt.addEventListener('click', function () {
              panel.querySelectorAll('.pm-opt').forEach(function (o) { o.classList.remove('sel'); });
              opt.classList.add('sel'); opt.querySelector('input').checked = true;
              preview();
            });
          });

          function baseMs() {
            var mode = (panel.querySelector('input[name="dpBase"]:checked') || {}).value || 'reset';
            if (mode === 'extend' && canExtend && curExpMs > Date.now()) return curExpMs;
            return Date.now();
          }
          /* calcula {expiresAt, days} conforme o formulário — única fonte de verdade */
          function compute() {
            var days = 0, expiresAt = 0;
            if (durSel.value === 'custom') {
              if (!customInp.value) return null;
              expiresAt = new Date(customInp.value + 'T23:59:59').getTime();
              days = Math.ceil((expiresAt - baseMs()) / 864e5);
            } else {
              days = parseInt(durSel.value, 10);
              expiresAt = baseMs() + days * 864e5;
            }
            if (!isFinite(expiresAt) || expiresAt <= Date.now() || !(days > 0)) return null;
            return { expiresAt: expiresAt, days: days };
          }
          function preview() {
            var c = compute();
            var pl = Billing.planById(planSel.value);
            customWrap.hidden = durSel.value !== 'custom';
            if (!c) {
              prevBox.innerHTML = I('info', 15) + '<span>' + (durSel.value === 'custom' && !customInp.value
                ? 'Escolha a data de vencimento do plano.'
                : 'Informe uma duração/data futura válida.') + '</span>';
              return;
            }
            var ref = '';
            if (pl && reasonSel.value !== 'cortesia') {
              var valor = c.days >= 365 ? pl.annualTotal : Math.round(pl.monthly * (c.days / 30));
              ref = ' · referência: <b>' + U.money(valor) + '</b>';
            } else if (reasonSel.value === 'cortesia') ref = ' · sem cobrança (cortesia)';
            var isExtend = ((panel.querySelector('input[name="dpBase"]:checked') || {}).value === 'extend') && canExtend;
            var totalDays = Math.max(1, Math.ceil((c.expiresAt - Date.now()) / 864e5));
            prevBox.innerHTML = I('calendar', 15) + '<span>Novo vencimento: <b>' + U.date(c.expiresAt) + '</b> — ' +
              (isExtend
                ? '+' + c.days + (c.days === 1 ? ' dia' : ' dias') + ' ao prazo atual (novo total: ' + totalDays + ' dias de acesso)'
                : c.days + (c.days === 1 ? ' dia' : ' dias') + ' de acesso') + ref + '</span>';
          }
          [durSel, customInp, planSel, reasonSel].forEach(function (el) {
            el.addEventListener('change', preview);
          });
          preview();

          panel.querySelector('[data-suspend]').addEventListener('click', function () {
            UI.confirm({
              title: 'Suspender acesso da empresa?',
              text: '"' + (t.tenantName || '') + '" entra em modo leitura (PDV e escrita bloqueados).',
              danger: true, okText: 'Suspender'
            }).then(function (ok) {
              if (!ok) return;
              close('suspend');
              var doSuspend = function () {
                ApiClient.request('billing.suspend_tenant', { tenantId: t.tenantId, reason: 'suspenso pela equipe JR via ticket #' + t.numero }).then(function () {
                  UI.toast('Acesso suspenso.', { type: 'warn' });
                  self._tinfo[t.tenantId] = { status: 'read_only', plan_id: null, canceled_at: new Date().toISOString() };
                  Bus.emit('billing:changed'); Bus.emit('shell:refresh');
                  if (onDone) onDone({ suspended: true, info: self._tinfo[t.tenantId] });
                }).catch(function (e) {
                  if (e && e.code === 'DEV_PIN_REQUIRED') {
                    UI.toast(e.message, { type: 'warn' });
                    self.askDevPin(doSuspend);
                    return;
                  }
                  UI.toast(e.message, { type: 'err' });
                });
              };
              doSuspend();
            });
          });

          panel.querySelector('[data-ok]').addEventListener('click', function () {
            var btn = this;
            var c = compute();
            if (!c) {
              UI.toast('Informe uma duração (ou data futura) válida.', { type: 'err' });
              (durSel.value === 'custom' ? customInp : durSel).focus();
              return;
            }
            var planId = planSel.value;
            var reason = reasonSel.value;
            var cycle = c.days >= 365 ? 'anual' : 'mensal';
            var extendMode = ((panel.querySelector('input[name="dpBase"]:checked') || {}).value === 'extend');
            var logIt = panel.querySelector('#dp-log').checked;
            /* v8 · PIN informado (se o servidor pedir 2º fator) vai junto no header */
            var pinInp = panel.querySelector('#dp-pin');
            var pinWrap = panel.querySelector('#dp-pin-wrap');
            if (pinInp && pinInp.value.trim()) Support.devPin.set(pinInp.value.trim());
            UI.busy(btn, true);

            /* 1) backend (Edge com service role na produção; mock na demo).
               O front já envia o vencimento calculado — o backend v6 persiste;
               no v5 ele aplica 30/365 dias e a UI mantém o prazo calculado. */
            ApiClient.request('billing.activate_plan', {
              tenantId: t.tenantId, planId: planId, cycle: cycle,
              days: c.days, expiresAt: new Date(c.expiresAt).toISOString(),
              reason: reason, extend: extendMode
            }).then(function (r) {
              var finalExp = (r && (r.planExpiresAt || r.plan_expires_at))
                ? new Date(r.planExpiresAt || r.plan_expires_at).getTime() : c.expiresAt;
              var finalDays = Math.max(1, Math.ceil((finalExp - Date.now()) / 864e5));
              var pl = Billing.planById(planId);

              /* 2) estado local: se a empresa editada é a da sessão, o Store
                 reflete na hora (destrava PDV, badges, banner da Assinatura) */
              var myTenant = (Store.state.session || {}).tenantId || (Store.state.tenant || {}).id;
              if (t.tenantId === myTenant) {
                Store.update(function (s) {
                  s.tenant.status = 'active';
                  s.tenant.planId = planId;
                  s.tenant.planCycle = cycle;
                  s.tenant.planExpiresAt = new Date(finalExp).toISOString();
                  s.tenant.planActivatedAt = Date.now();
                  s.tenant.planActivationReason = reason;
                  s.tenant.nextChargeAt = new Date(finalExp).toISOString();
                  s.tenant.canceledAt = null; s.tenant.cancelReason = '';
                });
              }
              var newInfo = {
                status: 'active', plan_id: planId, plan_cycle: cycle,
                plan_expires_at: new Date(finalExp).toISOString(), next_charge_at: new Date(finalExp).toISOString()
              };
              self._tinfo[t.tenantId] = newInfo;

              /* 3) efeitos colaterais: destrava o cliente na hora */
              Bus.emit('billing:changed');
              Bus.emit('shell:refresh');

              /* 4) rastro no ticket (opcional) */
              var logMsg = '✅ Plano ' + (pl ? pl.name : planId) + ' ativado pela equipe JR: ' +
                finalDays + ' dias de acesso (até ' + U.datetime(finalExp) + ') · motivo: ' +
                ({ pix: 'pagamento Pix', cartao: 'pagamento cartão', cortesia: 'cortesia', reativacao: 'reativação', bug: 'compensação por bug', outro: 'outro' }[reason] || reason) + '.';
              var after = function () {
                UI.busy(btn, false); close('ok');
                UI.toast('✅ Plano ' + (pl ? pl.name : planId) + ' ativado para ' + (t.tenantName || 'a empresa') +
                  ' — válido até ' + U.datetime(finalExp) + ' (' + finalDays + ' dias).', { type: 'ok', timeout: 6500 });
                if (onDone) onDone({ activated: true, info: newInfo });
              };
              if (logIt) Support.reply(t.id, logMsg).then(after, after);
              else after();
            }).catch(function (e) {
              UI.busy(btn, false);
              /* v8 · servidor pediu 2º fator: revela o campo PIN e deixa o dev
                 tentar de novo sem perder o preenchimento do modal */
              if (e && e.code === 'DEV_PIN_REQUIRED' && pinWrap) {
                pinWrap.hidden = false;
                if (pinInp) pinInp.focus();
                UI.toast(e.message, { type: 'warn' });
                return;
              }
              UI.toast(e.message, { type: 'err' });
            });
          });
        }
      });
    },

    sendReply: function (root, t) {
      var self = this;
      var ta = root.querySelector('#reply-msg'), btn = root.querySelector('#reply-btn');
      var msg = String(ta.value || '').trim();
      if (!msg) { UI.toast('Escreva uma mensagem antes de enviar.', { type: 'warn' }); ta.focus(); return; }
      UI.busy(btn, true);
      Support.reply(t.id, msg).then(function () {
        UI.busy(btn, false);
        /* mensagem foi — o rascunho pode ir embora (banco + cópia local) */
        Draft.del(t.id);
        ta.value = '';
        self.fill(root);
        var sc = root.querySelector('.ticket-thread'); if (sc) sc.scrollTop = sc.scrollHeight;
      }).catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err' }); });
    },

    /* ================= NOVO TICKET =================
       Cliente: chamado para a própria empresa.
       Dev: ticket interno (aberto em nome da conta JR). */
    /* v8 · PIN da equipe JR: modal único usado pelas operações de cobrança
       quando o servidor pede 2º fator (secret DEV_PIN configurado). */
    askDevPin: function (onOk) {
      UI.modal({
        title: 'PIN de segurança da equipe JR',
        sub: 'Operações de cobrança exigem o PIN além da senha da conta.',
        body: html`<div class="field"><label for="pin-in">PIN da equipe</label>
          <input class="input" id="pin-in" type="password" autocomplete="off" data-autofocus>
          <p class="field-hint">Definido pela JR Sistemas (secret <span class="mono">DEV_PIN</span> no Supabase). Fica guardado apenas nesta sessão do navegador e é apagado ao sair.</p></div>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>' +
          '<button type="button" class="btn btn-primary" data-ok>Continuar</button>'),
        onMount: function (panel, close) {
          panel.querySelector('[data-ok]').addEventListener('click', function () {
            var v = String(panel.querySelector('#pin-in').value || '').trim();
            if (!v) { UI.toast('Informe o PIN.', { type: 'warn' }); return; }
            Support.devPin.set(v);
            close('ok');
            if (onOk) onOk();
          });
        }
      });
    },
    newModal: function (root, prefill) {
      var self = this;
      var isDev = Support.isDev();
      prefill = prefill || {};
      UI.modal({
        title: isDev ? 'Abrir ticket interno' : 'Abrir ticket de suporte', size: 'lg',
        sub: isDev
          ? 'Ticket aberto em nome da equipe JR Sistemas — use para registrar acompanhamentos internos.'
          : 'Descreva o que está acontecendo — quanto mais detalhes, mais rápido resolvemos.',
        body: html`<form id="tk-form" novalidate>
          <div class="field"><label for="tk-assunto">Assunto <span class="req">*</span></label>
            <input class="input" id="tk-assunto" name="assunto" maxlength="160" placeholder="Ex.: Produto não salva ao editar preço" data-autofocus></div>
          <div class="field-row">
            <div class="field"><label for="tk-cat">Categoria</label>
              <select class="select" id="tk-cat" name="categoria">
                <option value="duvida">Dúvida</option>
                <option value="bug">Problema/Bug</option>
                <option value="sugestao">Sugestão</option>
                <option value="faturamento">Faturamento</option>
                <option value="outro">Outro</option>
              </select></div>
            <div class="field"><label for="tk-prio">Prioridade</label>
              <select class="select" id="tk-prio" name="prioridade">
                <option value="baixa">Baixa — pode esperar</option>
                <option value="media" selected>Média — atrapalha o dia a dia</option>
                <option value="alta">Alta — loja parcialmente parada</option>
                <option value="urgente">Urgente — não consigo vender/operar</option>
              </select></div>
          </div>
          <div class="field"><label for="tk-desc">Descrição do problema <span class="req">*</span></label>
            <textarea class="textarea" id="tk-desc" name="descricao" rows="6" maxlength="4000" placeholder="O que você estava fazendo quando o problema aconteceu? Qual mensagem apareceu? Desde quando ocorre?"></textarea></div>
          <div id="tk-err"></div>
        </form>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>' +
          '<button type="button" class="btn btn-primary" data-ok>' + I('mail', 16) + ' Enviar ticket</button>'),
        onMount: function (panel, close) {
          if (prefill.categoria) { var c = panel.querySelector('#tk-cat'); if (c) c.value = prefill.categoria; }
          if (prefill.assunto) { var a = panel.querySelector('#tk-assunto'); if (a) a.value = prefill.assunto; }
          /* v13 · rascunho do novo ticket — mesmo mecanismo (banco + local) */
          var fields = { assunto: panel.querySelector('#tk-assunto'), descricao: panel.querySelector('#tk-desc') };
          Draft.get('novo', function (d) {
            try { d = JSON.parse(d || 'null'); } catch (e2) { d = null; }
            if (d) {
              if (d.assunto && !fields.assunto.value) fields.assunto.value = d.assunto;
              if (d.descricao && !fields.descricao.value) fields.descricao.value = d.descricao;
            }
          });
          var saveDraft = U.debounce(function () {
            Draft.save('novo', JSON.stringify({ assunto: fields.assunto.value, descricao: fields.descricao.value }));
          }, 400);
          fields.assunto.addEventListener('input', saveDraft);
          fields.descricao.addEventListener('input', saveDraft);
          panel.querySelector('[data-ok]').addEventListener('click', function () {
            var form = panel.querySelector('#tk-form');
            var res = Validate.run(form, {
              assunto: [['required'], ['min', 4]],
              descricao: [['required'], ['min', 10]]
            });
            Validate.paint(form, res.errors);
            if (!res.ok) { UI.toast('Preencha assunto e descrição (mín. 10 caracteres).', { type: 'err' }); return; }
            var btn = this; UI.busy(btn, true);
            Support.create({
              assunto: res.values.assunto, descricao: res.values.descricao,
              categoria: form.elements.categoria.value, prioridade: form.elements.prioridade.value
            }).then(function (r) {
              UI.busy(btn, false); close('ok');
              Draft.del('novo');
              UI.toast('Ticket #' + (r.numero || '') + (isDev ? ' interno aberto.' : ' aberto! A equipe JR Sistemas já foi avisada.'), { type: 'ok', timeout: 5200 });
              if (!isDev) UI.toast('Você será notificado AQUI no app: um aviso aparece no menu Suporte e um banner no topo quando a equipe responder.', { type: 'info', timeout: 8000 });
              self.sel = r.id || null;
              self.fill(document.getElementById('page-root'));
              Bus.emit('shell:refresh');
            }).catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err' }); });
          });
        }
      });
    }
  };
})();
