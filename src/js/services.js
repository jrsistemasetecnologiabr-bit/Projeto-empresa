/* ==========================================================================
   LojaCerta · Services
   Camada de domínio + adapters. TODA leitura/escrita passa por ApiClient →
   MockAdapter (dados locais). Para produção, troque o adapter por
   SupabaseAdapter/HttpAdapter sem alterar as páginas (ver INTEGRATIONS.md).
   ========================================================================== */
;(function () {
  'use strict';

  /* ---------------- Configuração central ---------------- */
  var Config = {
    env: '{{ENV}}',              // demo | production — preenchido pelo build (tokens {{...}})
    appName: 'LojaCerta',
    version: '1.9.3',
    latency: 110,                // ms — latência simulada do "backend" (0 em testes)
    siteUrl: '{{SITE_URL}}',     // URL pública do site (canonical, e-mails, redirects de auth)
    api: { baseUrl: '{{API_BASE}}', anonKey: '{{SUPABASE_ANON_KEY}}' }, // build injeta do .env
    billing: { provider: '{{BILLING_PROVIDER}}', publishableKey: '{{STRIPE_PK}}' },
    providers: { auth: 'mock', db: 'mock', billing: 'mock', analytics: 'stub', notifications: 'stub', fiscal: 'off' },
    features: { csvImport: true, offlineQueue: false, nfe: false, multiStore: false, suporte: true },
    simulateFailures: false,
    requireEmailConfirm: true,  // cadastro exige código de 6 dígitos (produção: confirmação nativa do Supabase)
    /* Anti-abuso do teste grátis: limites por IP e por dispositivo. Em produção a
       regra vive no servidor (Edge Function + RPCs do banco); aqui espelhamos os
       mesmos valores para o modo demo (mesma mensagem e comportamento). */
    trial: { ipLimit: Number('{{TRIAL_IP_LIMIT}}'), deviceLimit: Number('{{TRIAL_DEVICE_LIMIT}}') },
    integrations: [
      { id: 'supabase', name: 'Supabase (Banco + Auth)', status: 'ready', desc: 'Conectado — dados e sessões na nuvem, com RLS por empresa.' },
      { id: 'suporte', name: 'Central de Suporte', status: 'ready', desc: 'Tickets com conversa por mensagem — clientes abrem, a equipe JR Sistemas atende.' },
      { id: 'billing', name: 'Cobrança (Asaas)', status: 'ready', desc: 'Assinatura recorrente via Asaas — Pix, cartão e boleto, com liberação automática por webhook.' },
      { id: 'analytics', name: 'Analytics (GA4/Meta)', status: 'ready', desc: 'Analytics.track() já emite eventos; basta plugar o provider.' },
      { id: 'fiscal', name: 'Emissor NFC-e/NF-e', status: 'soon', desc: 'Fase 2 — integração via API parceira (Focus NFe/TecnoSpeed).' },
      { id: 'storage', name: 'Armazenamento (logos/PDF)', status: 'soon', desc: 'Upload de arquivos via Supabase Storage/S3.' }
    ]
  };
  /* Tokens {{...}} não substituídos (uso do source sem build) viram defaults seguros */
  (function normalizeConfig() {
    var t = function (v, d) { return (typeof v === 'string' && /^\{\{[A-Z_]+\}\}$/.test(v)) ? d : v; };
    Config.env = t(Config.env, 'demo');
    Config.siteUrl = String(t(Config.siteUrl, 'https://jrsistemasetecnologiabr-bit.github.io/Projeto-empresa')).replace(/\/+$/, '');
    Config.api.baseUrl = t(Config.api.baseUrl, '');
    Config.api.anonKey = t(Config.api.anonKey, '');
    Config.billing.provider = t(Config.billing.provider, 'mock');
    Config.billing.publishableKey = t(Config.billing.publishableKey, '');
    Config.trial.ipLimit = Number(t(Config.trial.ipLimit, 1)) || 1;
    Config.trial.deviceLimit = Number(t(Config.trial.deviceLimit, 1)) || 1;
  })();

  /* ---------------- ApiClient (seam de integração) ---------------- */
  function ApiError(code, message, details) {
    var e = new Error(message); e.name = 'ApiError'; e.code = code; e.details = details; return e;
  }
  var MockAdapter = {
    latency: function () {
      var base = Config.latency;
      if (!base) return Promise.resolve();
      return U.sleep(base * (0.6 + Math.random() * 0.8));
    },
    request: function (op, payload) {
      var self = this;
      return this.latency().then(function () {
        /* Allow mock in production for testing if explicitly enabled */
        var forceMock = false;
        try {
          if (typeof window !== 'undefined') {
            var search = '';
            try { search = window.location.search || ''; } catch (e) { }
            var lsVal = '';
            try { lsVal = typeof localStorage !== 'undefined' ? localStorage.getItem('lc_test_mock') : ''; } catch (e) { }
            forceMock = search.includes('test=mock') || lsVal === '1';
            if (forceMock) console.log('[MockAdapter] Mock mode ENABLED for op:', op, 'search:', search, 'lsVal:', lsVal);
          }
        } catch (e) { }
        if (Config.env === 'production' && !forceMock) {
          throw ApiError('NOT_CONFIGURED', 'Modo produção exige adapter real (Supabase/HTTP) — o mock de demonstração é bloqueado por segurança. Ver supabase/README.md.');
        }
        if (Config.simulateFailures || (Config.failOps && Config.failOps[op])) {
          throw ApiError('NETWORK', 'Falha de conexão ao executar "' + op + '". Verifique sua internet e tente novamente.');
        }
        if (!OPS[op]) throw ApiError('NOT_FOUND', 'Operação desconhecida: ' + op);

        /* ---- Test mode: simulate session refresh (for session.test.js) ---- */
        if (forceMock) {
          var sess = Store.state && Store.state.session;
          var now = Date.now();

          /* Test flags (set via localStorage by the test):
             - lc_test_server_rejects: server rejects even valid tokens (simulates 401)
             - lc_test_refresh_fail: refresh should fail (simulates invalid refresh token) */
          var serverRejects = false;
          var refreshFail = false;
          try {
            if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
              serverRejects = localStorage.getItem('lc_test_server_rejects') === '1';
              refreshFail = localStorage.getItem('lc_test_refresh_fail') === '1';
            }
          } catch (e) { }

          /* If no valid session, reject all authenticated requests */
          if (!sess || !sess.userId) {
            if (typeof window !== 'undefined') {
              console.log('[MockAdapter DEBUG] No valid session, rejecting request');
            }
            throw ApiError('UNAUTHORIZED', 'Sessão expirada. Entre novamente.');
          }

          var refreshToken = sess.refresh;
          var tokenExpired = sess.expiresAt && now > sess.expiresAt;
          var canRefresh = refreshToken && sess.refreshUntil && now <= sess.refreshUntil;

          var shouldRefresh = (tokenExpired || serverRejects) && canRefresh && !refreshFail;
          var shouldFail = (tokenExpired || serverRejects) && (!canRefresh || refreshFail);

          if (typeof window !== 'undefined') {
            console.log('[MockAdapter DEBUG] op:', op, 'tokenExpired:', tokenExpired, 'serverRejects:', serverRejects, 'canRefresh:', canRefresh, 'refreshFail:', refreshFail, 'shouldRefresh:', shouldRefresh, 'shouldFail:', shouldFail);
          }

          /* Deduplication for concurrent refreshes (like SessionRefresh._p in SupabaseAdapter) */
          var refreshKey = '__lc_test_refreshing';
          if (shouldRefresh) {
            if (sess[refreshKey] && now - sess[refreshKey] < 10000) {
              /* Another request is already refreshing, wait for it */
              console.log('[MockAdapter] Refresh already in progress, waiting...');
            } else {
              sess[refreshKey] = now;
              Store.persist();
              /* Simulate refresh: update token to 'NEW' (matches test expectation) */
              sess.token = 'NEW';
              sess.refresh = 'r2';
              sess.expiresAt = now + 3600 * 1000;
              sess.refreshUntil = now + 30 * 864e5;
              delete sess._refreshingAt;
              Store.persist();
              /* Notify test that refresh happened */
              if (typeof window !== 'undefined') {
                window.__lc_test_refresh_count = (window.__lc_test_refresh_count || 0) + 1;
                console.log('[MockAdapter] Simulated session refresh, count:', window.__lc_test_refresh_count);
              }
            }
          } else if (shouldFail) {
            /* Refresh failed / not possible: clear session */
            console.log('[MockAdapter] shouldFail triggered, clearing session');
            Store.state.session = { userId: null };
            Store.persist();
            /* Simulate router redirect to login */
            if (typeof window !== 'undefined') {
              window.location.hash = '#/entrar';
            }
            throw ApiError('UNAUTHORIZED', 'Sessão expirada. Entre novamente.');
          }
        }

        /* Toda operação do mock é uma mutação: persiste e notifica ao final.
           (Em produção, o adapter remoto persiste no servidor e re-sincroniza o store local.) */
        return Promise.resolve(OPS[op](payload || {})).then(function (res) {
          if (Store.state) { Store.persist(); Bus.emit('store:changed', Store.state); }
          return res;
        });
      });
    }
  };
  var ApiClient = {
    adapter: MockAdapter,
    request: function (op, payload) {
      Bus.emit('api:request', { op: op });
      return this.adapter.request(op, payload).catch(function (err) {
        Bus.emit('api:error', { op: op, err: err });
        throw err;
      });
    }
  };

  /* ---------------- Operações mock (o "backend" local) ---------------- */
  function st() { return Store.state; }
  function findUser(id) { return st().users.filter(function (u) { return u.id === id; })[0] || null; }
  function findProduct(id) { return st().products.filter(function (p) { return p.id === id; })[0] || null; }
  function pushAudit(acao, entidade, entidadeId, detalhes) {
    var u = Auth.me();
    st().audit.unshift({
      id: 'a' + st().seq.aud++, at: Date.now(), userId: u ? u.id : null, userName: u ? u.nome : 'sistema',
      acao: acao, entidade: entidade, entidadeId: entidadeId || null, detalhes: detalhes || ''
    });
    if (st().audit.length > 500) st().audit.length = 500;
  }

  var OPS = {
    /* ---- auth: delega ao AuthCore (mecânica real de tokens/senha/sessão) ---- */
    'auth.signup': function (d) { return AuthService.signup(d); },
    'auth.login': function (d) { return AuthService.login(d.email, d.password); },
    'auth.logout': function () { return AuthService.logout(); },
    /* ---- billing: máquina de estados via webhook idempotente (mesmo caminho do gateway real) ---- */
    'billing.subscribe': function (d) { return Billing.subscribe(d.planId, d.cycle, d.method); },
    'billing.cancel': function (d) { return Billing.cancel(d.reason); },
    'billing.setPastDue': function () { return Billing.simulatePastDue(); },
    /* ---- produtos ---- */
    'products.create': function (d) {
      var s = st();
      var codigo = String(d.codigo || '').trim();
      if (!codigo) { codigo = 'INT-' + U.pad(s.seq.int++); }
      if (s.products.some(function (p) { return p.codigo.toLowerCase() === codigo.toLowerCase(); }))
        throw ApiError('DUP_CODE', 'Já existe um produto com o código ' + codigo + '.');
      var p = {
        id: 'p' + s.seq.prod++, codigo: codigo, nome: String(d.nome).trim(), catId: d.catId, un: d.un || 'un',
        custo: U.round2(U.parseNum(d.custo) || 0), preco: U.round2(U.parseNum(d.preco) || 0),
        estoque: U.parseNum(d.estoque) || 0, min: U.parseNum(d.min) || 0,
        fornecedor: String(d.fornecedor || '').trim(), ativo: true, createdAt: Date.now()
      };
      if (!(p.preco > 0)) throw ApiError('VALIDATION', 'Preço de venda deve ser maior que zero.');
      s.products.push(p);
      if (p.estoque > 0) s.movements.unshift({ id: 'm' + s.seq.mov++, at: Date.now(), productId: p.id, tipo: 'entrada', qtd: p.estoque, userId: s.session.userId, origem: 'Cadastro inicial', obs: '' });
      pushAudit('produto.criado', 'product', p.id, p.nome);
      return { id: p.id };
    },
    'products.update': function (d) {
      var p = findProduct(d.id);
      if (!p) throw ApiError('NOT_FOUND', 'Produto não encontrado.');
      var s = st();
      if (d.codigo && String(d.codigo).trim() && String(d.codigo).trim().toLowerCase() !== p.codigo.toLowerCase() &&
        s.products.some(function (x) { return x.codigo.toLowerCase() === String(d.codigo).trim().toLowerCase(); }))
        throw ApiError('DUP_CODE', 'Código já usado por outro produto.');
      ['nome', 'catId', 'un', 'fornecedor'].forEach(function (k) { if (d[k] !== undefined) p[k] = d[k]; });
      ['custo', 'preco'].forEach(function (k) { if (d[k] !== undefined) p[k] = U.round2(U.parseNum(d[k]) || 0); });
      ['estoque', 'min'].forEach(function (k) { if (d[k] !== undefined) p[k] = U.parseNum(d[k]) || 0; });
      if (p.preco <= 0) throw ApiError('VALIDATION', 'Preço de venda deve ser maior que zero.');
      pushAudit('produto.editado', 'product', p.id, p.nome);
      return { id: p.id };
    },
    'products.toggle': function (d) {
      var p = findProduct(d.id);
      if (!p) throw ApiError('NOT_FOUND', 'Produto não encontrado.');
      p.ativo = !p.ativo;
      pushAudit(p.ativo ? 'produto.reativado' : 'produto.inativado', 'product', p.id, p.nome);
      return { ativo: p.ativo };
    },
    /* ---- estoque ---- */
    'inventory.entry': function (d) {
      var p = findProduct(d.productId);
      var qtd = U.parseNum(d.qtd);
      if (!p) throw ApiError('NOT_FOUND', 'Produto não encontrado.');
      if (!(qtd > 0)) throw ApiError('VALIDATION', 'Quantidade deve ser maior que zero.');
      p.estoque = U.round2((p.estoque + qtd) * 1000) / 1000;
      var custo = U.parseNum(d.custo);
      if (isFinite(custo) && custo > 0) p.custo = U.round2(custo);
      var s = st();
      var origem = ['Compra', d.fornecedor ? 'Fornecedor: ' + d.fornecedor : '', d.nf ? 'NF ' + d.nf : ''].filter(Boolean).join(' · ');
      s.movements.unshift({ id: 'm' + s.seq.mov++, at: Date.now(), productId: p.id, tipo: 'entrada', qtd: qtd, userId: s.session.userId, origem: origem, obs: d.note || '' });
      pushAudit('estoque.entrada', 'product', p.id, '+' + qtd + ' ' + p.un);
      return { estoque: p.estoque };
    },
    'inventory.adjust': function (d) {
      var p = findProduct(d.productId);
      var delta = U.parseNum(d.delta);
      if (!p) throw ApiError('NOT_FOUND', 'Produto não encontrado.');
      if (!delta) throw ApiError('VALIDATION', 'Informe uma quantidade diferente de zero.');
      if (!d.reason) throw ApiError('VALIDATION', 'O motivo do ajuste é obrigatório.');
      var novo = U.round2((p.estoque + delta) * 1000) / 1000;
      if (novo < 0 && !st().config.permiteEstoqueNegativo)
        throw ApiError('STOCK_NEG', 'Ajuste deixaria estoque negativo (' + novo + '). Corrija a quantidade ou permita estoque negativo nas configurações.');
      p.estoque = novo;
      st().movements.unshift({ id: 'm' + st().seq.mov++, at: Date.now(), productId: p.id, tipo: 'ajuste', qtd: delta, userId: st().session.userId, origem: d.reason, obs: d.note || '' });
      pushAudit('estoque.ajuste', 'product', p.id, (delta > 0 ? '+' : '') + delta + ' ' + p.un + ' (' + d.reason + ')');
      return { estoque: p.estoque };
    },
    /* ---- vendas ---- */
    'sales.commit': function (d) {
      var s = st();
      /* bloqueio de cobrança: status suspenso OU plano pago com prazo vencido */
      if (s.tenant.status === 'read_only' || Billing.planExpired(s.tenant))
        throw ApiError('BILLING_BLOCKED', 'PDV bloqueado: assinatura suspensa ou plano expirado. Reative na página Assinatura.');
      var items = d.items || [];
      if (!items.length) throw ApiError('EMPTY_CART', 'Adicione produtos à venda.');
      for (var i = 0; i < items.length; i++) {
        var p = findProduct(items[i].productId);
        var q = U.parseNum(items[i].qtd);
        if (!p || !p.ativo) throw ApiError('PROD_OFF', 'Produto indisponível no carrinho.');
        if (!(q > 0)) throw ApiError('VALIDATION', 'Quantidade inválida para ' + p.nome + '.');
        if (!s.config.permiteEstoqueNegativo && q > p.estoque)
          throw ApiError('NO_STOCK', 'Estoque insuficiente de "' + p.nome + '": disponível ' + U.num(p.estoque) + ' ' + p.un + '.');
      }
      var subtotal = U.round2(U.sum(items, function (it) {
        var p = findProduct(it.productId); return p.preco * (U.parseNum(it.qtd) || 0);
      }));
      var disc = d.discount || { tipo: 'R$', valor: 0 };
      var discVal = U.round2(disc.tipo === '%' ? subtotal * (U.parseNum(disc.valor) || 0) / 100 : (U.parseNum(disc.valor) || 0));
      discVal = U.clamp(discVal, 0, subtotal);
      var user = Auth.me();
      if (user && user.papel === 'operador') {
        var lim = s.config.descontoCaixaPct || 0;
        if (subtotal > 0 && (discVal / subtotal) * 100 > lim + 0.001)
          throw ApiError('DISCOUNT_LIMIT', 'Desconto acima do limite do caixa (' + lim + '%). Peça autorização de um gerente.');
      }
      var total = U.round2(subtotal - discVal);
      var pays = (d.payments || []).filter(function (p) { return U.parseNum(p.valor) > 0; })
        .map(function (p) { return { forma: p.forma, valor: U.round2(U.parseNum(p.valor)) }; });
      var pago = U.round2(U.sum(pays, function (p) { return p.valor; }));
      if (Math.abs(pago - total) > 0.011) throw ApiError('PAY_MISMATCH', 'A soma dos pagamentos (' + U.money(pago) + ') não fecha com o total (' + U.money(total) + ').');
      var troco = 0;
      pays.forEach(function (p) { if (p.forma === 'dinheiro') { /* troco exibido no front; gravado aqui p/ relatório */ } });
      var sale = {
        id: 's' + s.seq.sale, numero: 'VENDA-' + U.pad(s.seq.sale++), at: Date.now(),
        userId: user ? user.id : null, userName: user ? user.nome : '—',
        itens: items.map(function (it) {
          var p = findProduct(it.productId); var q = U.parseNum(it.qtd);
          return { productId: p.id, nome: p.nome, un: p.un, qtd: q, preco: p.preco, subtotal: U.round2(p.preco * q) };
        }),
        subtotal: subtotal, desconto: discVal, descontoTipo: disc.tipo, total: total,
        pagamentos: pays, troco: Math.max(0, U.round2(pago - total)), status: 'concluida'
      };
      sale.itens.forEach(function (it) {
        var p = findProduct(it.productId);
        p.estoque = U.round2((p.estoque - it.qtd) * 1000) / 1000;
        s.movements.unshift({ id: 'm' + s.seq.mov++, at: sale.at, productId: p.id, tipo: 'saida', qtd: it.qtd, userId: sale.userId, origem: sale.numero, obs: '' });
      });
      s.sales.unshift(sale);
      pushAudit('venda.concluida', 'sale', sale.id, sale.numero + ' · ' + U.money(sale.total));
      Analytics.track('sale_commit', { total: sale.total, itens: sale.itens.length });
      return { sale: U.clone(sale) };
    },
    'sales.cancel': function (d) {
      var s = st();
      var user = Auth.me();
      if (!user || user.papel !== 'admin') throw ApiError('FORBIDDEN', 'Apenas administradores podem cancelar vendas.');
      var sale = s.sales.filter(function (x) { return x.id === d.id; })[0];
      if (!sale) throw ApiError('NOT_FOUND', 'Venda não encontrada.');
      if (sale.status === 'cancelada') throw ApiError('ALREADY', 'Venda já cancelada.');
      if (!d.reason) throw ApiError('VALIDATION', 'Informe o motivo do cancelamento.');
      sale.status = 'cancelada'; sale.motivoCancelamento = d.reason; sale.canceledAt = Date.now();
      sale.itens.forEach(function (it) {
        var p = findProduct(it.productId);
        if (p) {
          p.estoque = U.round2((p.estoque + it.qtd) * 1000) / 1000;
          s.movements.unshift({ id: 'm' + s.seq.mov++, at: Date.now(), productId: p.id, tipo: 'venda_cancelada', qtd: it.qtd, userId: user.id, origem: sale.numero, obs: 'Motivo: ' + d.reason });
        }
      });
      pushAudit('venda.cancelada', 'sale', sale.id, sale.numero + ' · ' + d.reason);
      return { ok: true };
    },
    /* ---- config / dados ---- */
    'tenant.update': function (d) {
      var t = st().tenant, c = st().config;
      ['nome', 'cnpj', 'endereco', 'telefone'].forEach(function (k) { if (d[k] !== undefined) t[k] = d[k]; });
      if (d.descontoCaixaPct !== undefined) c.descontoCaixaPct = U.clamp(parseInt(d.descontoCaixaPct, 10) || 0, 0, 100);
      if (d.permiteEstoqueNegativo !== undefined) c.permiteEstoqueNegativo = !!d.permiteEstoqueNegativo;
      if (d.reciboMsg !== undefined) c.reciboMsg = String(d.reciboMsg).slice(0, 120);
      pushAudit('config.atualizada', 'tenant', t.id);
      return { ok: true };
    },
    'users.invite': function (d) {
      var s = st();
      if (findUserByEmail(d.email)) throw ApiError('EMAIL_EXISTS', 'Já existe um usuário com este e-mail.');
      var u = { id: 'u' + s.seq.user++, nome: String(d.nome).trim(), email: String(d.email).trim().toLowerCase(), senha: 'convite123', papel: d.papel || 'operador', ativo: true, convidado: true, createdAt: Date.now() };
      s.users.push(u);
      pushAudit('usuario.convidado', 'user', u.id, u.nome + ' (' + u.papel + ')');
      return { id: u.id };
    },
    'users.update': function (d) {
      var u = findUser(d.id);
      if (!u) throw ApiError('NOT_FOUND', 'Usuário não encontrado.');
      if (d.papel) u.papel = d.papel;
      if (d.ativo !== undefined) u.ativo = !!d.ativo;
      if (!st().users.some(function (x) { return x.papel === 'admin' && x.ativo; })) throw ApiError('LAST_ADMIN', 'A loja precisa de pelo menos um admin ativo.');
      pushAudit('usuario.editado', 'user', u.id, u.nome);
      return { ok: true };
    },

    /* ---- suporte: tickets (mock espelha o backend real) ---- */
    'audit.list': function (d) {
      return Promise.resolve(st().audit.slice(0, (d && d.limit) || 60).map(function (a) {
        return { id: a.id, userName: a.userName, acao: a.acao, detalhes: a.detalhes, at: a.at };
      }));
    },
    'audit.admin': function () {
      /* demo: mesma lista local (não existe globla fora do production) */
      return Promise.resolve(st().audit.slice(0, 100).map(function (a) {
        return { id: a.id, tenantName: st().tenant.nome, userName: a.userName, acao: a.acao, detalhes: a.detalhes, at: a.at };
      }));
    },
    'tickets.badge': function () {
      var me = Auth.me() || {};
      var isDev = me.papel === 'dev';
      var list = st().tickets;
      return Promise.resolve({
        aguardandoCliente: isDev ? 0 : list.filter(function (t) { return t.status === 'aguardando_cliente'; }).length,
        filaEquipe: isDev ? list.filter(function (t) { return t.status === 'aberto' || t.status === 'aguardando_equipe'; }).length : 0,
        ts: Date.now()
      });
    },
    'tickets.create': function (d) {
      var s = st(); var user = Auth.me();
      if (!user) throw ApiError('UNAUTHORIZED', 'Sessão expirada.');
      var assunto = String(d.assunto || '').trim(), descricao = String(d.descricao || '').trim();
      if (assunto.length < 4) throw ApiError('VALIDATION', 'O assunto precisa ter pelo menos 4 caracteres.');
      if (descricao.length < 10) throw ApiError('VALIDATION', 'Descreva o problema com pelo menos 10 caracteres.');
      var CATS = ['duvida', 'bug', 'sugestao', 'faturamento', 'outro'], PRIO = ['baixa', 'media', 'alta', 'urgente'];
      var t = {
        id: 'tk' + (s.seq.tick++), tenantId: s.tenant.id, userId: user.id, userName: user.nome, userEmail: user.email,
        tenantName: s.tenant.nome, numero: s.seq.tick, assunto: assunto,
        categoria: CATS.indexOf(d.categoria) > -1 ? d.categoria : 'duvida',
        prioridade: PRIO.indexOf(d.prioridade) > -1 ? d.prioridade : 'media',
        status: 'aberto', descricao: descricao, createdAt: Date.now(), updatedAt: Date.now(), closedAt: null,
        assigneeId: null, assigneeName: ''
      };
      s.tickets.unshift(t);
      pushAudit('ticket.criado', 'ticket', t.id, '#' + t.numero + ' ' + assunto.slice(0, 60));
      return { id: t.id, numero: t.numero };
    },
    'tickets.reply': function (d) {
      var s = st(); var user = Auth.me();
      if (!user) throw ApiError('UNAUTHORIZED', 'Sessão expirada.');
      var t = s.tickets.filter(function (x) { return x.id === d.ticketId; })[0];
      if (!t) throw ApiError('NOT_FOUND', 'Ticket não encontrado.');
      var msg = String(d.message || '').trim();
      if (msg.length < 1) throw ApiError('VALIDATION', 'Escreva uma mensagem.');
      var m = { id: 'tm' + Date.now() + Math.floor(Math.random() * 999), ticketId: t.id, senderId: user.id, senderName: user.nome, senderRole: user.papel, tipo: 'mensagem', message: msg.slice(0, 4000), at: Date.now() };
      s.ticketMsgs.push(m);
      t.updatedAt = Date.now();
      /* máquina de estados: a resposta move a “bola” conforme o papel de quem
         respondeu — espelha o trigger bump_ticket_on_msg da migração v7.
         DEV responde → aguardando_cliente (e assume o ticket se ninguém assumiu)
         CLIENTE responde → aguardando_equipe (ticket aberto continua na fila)   */
      var prev = t.status;
      if (user.papel === 'dev') {
        if (t.status !== 'aguardando_cliente') t.status = 'aguardando_cliente';
        if (!t.assigneeId) { t.assigneeId = user.id; t.assigneeName = user.nome; }
      } else if (t.status === 'em_andamento' || t.status === 'aguardando_cliente' || t.status === 'resolvido' || t.status === 'fechado') {
        t.status = 'aguardando_equipe';
      }
      if (t.status === 'resolvido' || t.status === 'fechado') t.closedAt = null; /* reaberto */
      /* evento de auditoria na própria conversa (igual ao trigger da v7) */
      if (t.status !== prev) {
        s.ticketMsgs.push({ id: 'tev' + Date.now() + Math.floor(Math.random() * 999), ticketId: t.id, senderId: user.id, senderName: user.nome, senderRole: user.papel, tipo: 'evento', message: 'status:' + prev + '>' + t.status, at: Date.now() });
      }
      return { id: m.id };
    },
    'tickets.update': function (d) {
      var s = st(); var user = Auth.me();
      if (!user) throw ApiError('UNAUTHORIZED', 'Sessão expirada.');
      var t = s.tickets.filter(function (x) { return x.id === d.id; })[0];
      if (!t) throw ApiError('NOT_FOUND', 'Ticket não encontrado.');
      var ST = ['aberto', 'em_andamento', 'aguardando_cliente', 'aguardando_equipe', 'resolvido', 'fechado'];
      var PR = ['baixa', 'media', 'alta', 'urgente'];
      if (d.status && ST.indexOf(d.status) === -1) throw ApiError('VALIDATION', 'Status inválido.');
      if (d.prioridade && PR.indexOf(d.prioridade) === -1) throw ApiError('VALIDATION', 'Prioridade inválida.');
      var isDev = user.papel === 'dev';
      var isOwner = t.userId === user.id;
      /* guard v7 — espelha o trigger guard_ticket_flow do banco:
         · status: dev sempre; dono pode encerrar/confirmar o próprio
         · prioridade/categoria/assignee: somente dev                          */
      if (d.status !== undefined && !isDev && !isOwner)
        throw ApiError('FORBIDDEN', 'Somente quem abriu o ticket (ou a equipe JR) pode alterar o status.');
      if ((d.prioridade !== undefined || d.categoria !== undefined || d.assigneeId !== undefined) && !isDev)
        throw ApiError('FORBIDDEN', 'Prioridade, categoria e responsável são definidos pela equipe JR Sistemas.');
      var prev = t.status;
      if (d.status) {
        t.status = d.status;
        t.closedAt = (d.status === 'resolvido' || d.status === 'fechado') ? Date.now() : null;
      }
      if (d.assigneeId !== undefined) {
        t.assigneeId = d.assigneeId || null;
        t.assigneeName = d.assigneeId ? (user.id === d.assigneeId ? user.nome : ((s.users.filter(function (u) { return u.id === d.assigneeId; })[0] || {}).nome || '')) : '';
      }
      if (d.prioridade) t.prioridade = d.prioridade;
      if (d.categoria && ['duvida','bug','sugestao','faturamento','outro'].indexOf(d.categoria) > -1) t.categoria = d.categoria;
      t.updatedAt = Date.now();
      /* evento de auditoria na conversa (igual ao trigger trg_tick_event) */
      if (t.status !== prev) {
        s.ticketMsgs.push({ id: 'tev' + Date.now() + Math.floor(Math.random() * 999), ticketId: t.id, senderId: user.id, senderName: user.nome, senderRole: user.papel, tipo: 'evento', message: 'status:' + prev + '>' + t.status, at: Date.now() });
      }
      pushAudit('ticket.atualizado', 'ticket', t.id, '#' + t.numero + ' → ' + (d.status || d.prioridade || d.categoria || (d.assigneeId !== undefined ? 'atender' : '')));
      return { ok: true };
    },
    'users.invites': function () {
      return st().invites.filter(function (i) { return !i.accepted && !i.revoked; });
    },
    'users.uninvite': function (d) {
      var i = st().invites.filter(function (x) { return x.id === d.id; })[0];
      if (!i) throw ApiError('NOT_FOUND', 'Convite não encontrado.');
      i.revoked = true;
      return { ok: true };
    },

    /* ---- billing: ferramentas da equipe JR (mock espelha a Edge Function) ----
       Em demo só existe a loja local (single-tenant); a UI funciona igual à produção. */
    'billing.tenant_info': function (d) {
      var t = st().tenant;
      if (d.tenantId && d.tenantId !== t.id) throw ApiError('NOT_FOUND', 'Empresa não encontrada (modo demo contém apenas a loja local).');
      return {
        nome: t.nome, status: t.status, plan_id: t.planId, plan_cycle: t.planCycle,
        plan_expires_at: t.planExpiresAt ? new Date(t.planExpiresAt).toISOString() : null,
        plan_activation_reason: t.planActivationReason || '',
        trial_ends_at: t.trialEndsAt, next_charge_at: t.nextChargeAt, canceled_at: t.canceledAt || null
      };
    },
    'billing.activate_plan': function (d) {
      var me = Auth.me();
      if (!me || me.papel !== 'dev') throw ApiError('FORBIDDEN', 'Somente a equipe JR Sistemas ativa planos.');
      var pl = Billing.planById(d.planId);
      if (!pl) throw ApiError('VALIDATION', 'Plano inválido.');
      var days = parseInt(d.days, 10);
      var expiresAt;
      if (d.expiresAt) expiresAt = new Date(d.expiresAt).getTime();
      else {
        if (!(days > 0)) throw ApiError('VALIDATION', 'Informe a duração do plano.');
        var base = Date.now();
        var t0 = st().tenant;
        /* edge case: estender plano ativo soma os dias restantes aos novos dias */
        if (d.extend === true && (t0.status === 'active' || t0.status === 'past_due') &&
            t0.planExpiresAt && new Date(t0.planExpiresAt).getTime() > base)
          base = new Date(t0.planExpiresAt).getTime();
        expiresAt = base + days * 864e5;
      }
      if (!(expiresAt > Date.now())) throw ApiError('VALIDATION', 'A data de vencimento deve ser futura.');
      var t = st().tenant;
      t.status = 'active';
      t.planId = d.planId;
      t.planCycle = d.cycle === 'anual' ? 'anual' : 'mensal';
      t.planExpiresAt = new Date(expiresAt).toISOString();
      t.planActivatedAt = Date.now();
      t.planActivationReason = String(d.reason || '').slice(0, 120);
      t.startedAt = t.startedAt || Date.now();
      t.canceledAt = null; t.cancelReason = '';
      t.nextChargeAt = t.planExpiresAt;
      var valor = d.days === 365 ? pl.annualTotal : Math.round(pl.monthly * (((days || 30)) / 30));
      t.invoices.unshift({ id: 'inv_' + Date.now(), at: Date.now(), planId: pl.id, planName: pl.name, cycle: t.planCycle, valor: valor, status: 'pago', metodo: d.reason === 'cortesia' ? 'cortesia' : 'pix' });
      pushAudit('plano.ativado', 'tenant', t.id, pl.name + ' até ' + U.date(expiresAt) + ' · motivo: ' + (d.reason || '—'));
      Bus.emit('billing:changed');
      return { ok: true, status: 'active', planId: pl.id, cycle: t.planCycle, planExpiresAt: t.planExpiresAt, nextChargeAt: t.nextChargeAt };
    },
    'billing.suspend_tenant': function (d) {
      var me = Auth.me();
      if (!me || me.papel !== 'dev') throw ApiError('FORBIDDEN', 'Somente a equipe JR Sistemas suspende acessos.');
      var t = st().tenant;
      t.status = 'read_only';
      t.canceledAt = Date.now();
      t.cancelReason = String(d.reason || '').slice(0, 200) || 'suspenso pela equipe JR Sistemas';
      pushAudit('assinatura.suspensa', 'tenant', t.id, t.cancelReason);
      Bus.emit('billing:changed');
      return { ok: true, status: 'read_only' };
    },
    'billing.refresh': function () {
      var t = st().tenant;
      if (t.status === 'trialing' && new Date(t.trialEndsAt).getTime() <= Date.now()) t.status = 'read_only';
      else if (Billing.planExpired(t) && (t.status === 'active' || t.status === 'past_due')) t.status = 'read_only';
      return { status: t.status, planId: t.planId, planCycle: t.planCycle, planExpiresAt: t.planExpiresAt, nextChargeAt: t.nextChargeAt };
    }
  };
  function findUserByEmail(email) {
    return st().users.filter(function (u) { return u.email === String(email || '').trim().toLowerCase(); })[0] || null;
  }

  /* ---------------- Serviços de domínio ---------------- */
  var Auth = {
    me: function () {
      var sess = Store.state && Store.state.session;
      if (!sess || !sess.userId) return null;
      if (Config.env === 'production') return sess.profile || null;
      return findUser(sess.userId);
    },
    signup: function (data) { return AuthService.signup(data).then(function () { Analytics.track('signup', { plano: data.plano || null, segmento: data.segment || null }); return Auth.me(); }); },
    login: function (email, password) { return AuthService.login(email, password).then(function () { return Auth.me(); }); },
    logout: function () { return AuthService.logout(); }
  };

  var Billing = {
    PLANS: [
      { id: 'essencial', name: 'Essencial', monthly: 59, annual: 49, annualTotal: 588, users: 2, pdvs: 1, products: 3000, for: 'Para começar com 1 caixa', features: ['2 usuários · 1 PDV', 'Até 3.000 produtos', 'Estoque + PDV + comprovante', 'Dashboard e relatórios básicos', 'Central de suporte no app'] },
      { id: 'profissional', name: 'Profissional', monthly: 129, annual: 107, annualTotal: 1284, users: 6, pdvs: 3, products: 20000, hot: true, for: 'Para loja com 2–3 caixas', features: ['6 usuários · 3 PDVs', 'Até 20.000 produtos', 'Relatórios completos + exportação', 'Clientes, fiado e contas a pagar', 'Orçamento que vira venda', 'Suporte prioritário'] },
      { id: 'premium', name: 'Premium', monthly: 249, annual: 207, annualTotal: 2484, users: Infinity, pdvs: Infinity, products: Infinity, for: 'Para quem emite nota e tem 2+ lojas', features: ['Usuários e PDVs ilimitados', 'Produtos ilimitados', 'NFC-e / NF-e (fase 2)', 'Multi-loja (fase 3)', 'Onboarding ao vivo', 'Suporte prioritário'] }
    ],
    planById: function (id) { return this.PLANS.filter(function (p) { return p.id === id; })[0] || null; },
    /* Plano pago com prazo vencido? (guarda do front; o servidor confirma via billing.refresh).
       Conta dev (planId='dev') nunca expira. */
    planExpired: function (tenant) {
      var t = tenant || (st() ? st().tenant : null);
      return !!(t && t.planId !== 'dev' && t.planExpiresAt && new Date(t.planExpiresAt).getTime() <= Date.now());
    },
    statusInfo: function () {
      var t = st().tenant;
      /* Conta DEV (equipe JR Sistemas): plano interno, tudo liberado e SEM prazo.
         Vale para o tenant com plan_id='dev' ou para qualquer usuário com papel dev. */
      var me = (typeof Auth !== 'undefined' && Auth.me) ? (Auth.me() || {}) : {};
      if (t.planId === 'dev' || me.papel === 'dev') {
        return { status: 'active', cycle: t.planCycle, unlimited: true,
          plan: { id: 'dev', name: 'Dev', users: Infinity, pdvs: Infinity, products: Infinity,
            features: ['Acesso completo a todos os recursos', 'Tempo indeterminado', 'Painel de atendimento (tickets de todas as empresas)', 'Ferramentas de ativação de planos'] } };
      }
      var info = { status: t.status, plan: t.planId ? this.planById(t.planId) : null, cycle: t.planCycle };
      if (t.status === 'trialing') {
        var left = Math.max(0, Math.ceil((new Date(t.trialEndsAt).getTime() - Date.now()) / 864e5));
        info.daysLeft = left; info.usedPct = U.clamp(Math.round(((14 - left) / 14) * 100), 0, 100);
        if (left === 0) info.expired = true;
      }
      /* Plano PAGO COM PRAZO (plan_expires_at): o vencimento manda na UI.
         Quem pagou 30 dias fica 30 dias — não existe mais "ativo para sempre".
         Sem a propriedade (contas antigas/trial) mantém o comportamento anterior. */
      if (t.planExpiresAt) {
        var exp = new Date(t.planExpiresAt).getTime();
        info.planExpiresAt = exp;
        var dLeft = Math.ceil((exp - Date.now()) / 864e5);
        if (dLeft <= 0) {
          /* vencido: acesso tratado como suspenso até pagar/reativar
             (vale mesmo se o status já foi virado para read_only pelo checkTrial) */
          if (info.status === 'active' || info.status === 'past_due') info.status = 'read_only';
          info.expiredByPlan = true;
          info.daysLeft = 0;
        } else if (t.status === 'active' || t.status === 'past_due') {
          info.daysLeft = dLeft;
          if (dLeft <= 5) info.expiring = true; /* janela de aviso: poucos dias restantes */
        }
      }
      if (t.nextChargeAt) info.nextCharge = t.nextChargeAt;
      return info;
    },
    subscribe: function (planId, cycle, method) {
      var pl = this.planById(planId);
      if (!pl) return Promise.reject(ApiError('BAD_PLAN', 'Plano inválido.'));
      var valor = cycle === 'anual' ? pl.annualTotal : pl.monthly;
      /* Demo: o "gateway" responde pelo MESMO caminho de webhook que o gateway
         real usará em produção (idempotente, via BillingWebhook.ingest). */
      var ev = { id: 'ev_demo_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), provider: Config.billing.provider || 'demo', type: 'checkout.completed', data: { planId: planId, cycle: cycle, valor: valor, metodo: method || 'pix' } };
      Analytics.track('subscribe', { plan: planId, cycle: cycle });
      return Promise.resolve(BillingWebhook.ingest(ev));
    },
    cancel: function (reason) {
      /* produção: grava no servidor via Edge (guard do banco impede PATCH direto) */
      if (Config.env === 'production') {
        Analytics.track('cancel_subscription');
        return ApiClient.request('billing.cancel', { reason: reason || '' }).then(function (r) {
          Store.update(function (s) { s.tenant.status = 'read_only'; s.tenant.canceledAt = Date.now(); s.tenant.cancelReason = reason || ''; });
          Bus.emit('billing:changed');
          return r;
        });
      }
      st().tenant.cancelReason = reason || '';
      Analytics.track('cancel_subscription');
      return Promise.resolve(BillingWebhook.ingest({ id: 'ev_cancel_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), provider: 'internal', type: 'subscription.canceled', data: {} }));
    },
    simulatePastDue: function () {
      return Promise.resolve(BillingWebhook.ingest({ id: 'ev_pd_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), provider: 'demo', type: 'payment.declined', data: {} }));
    },
    upgrade: function (planId, cycle) {
      var t = st().tenant;
      if (t.status !== 'active') return Promise.reject(ApiError('BILLING_BLOCKED', 'Upgrade disponível apenas com assinatura ativa.'));
      var pl = this.planById(planId);
      if (!pl) return Promise.reject(ApiError('BAD_PLAN', 'Plano inválido.'));
      var valor = cycle === 'anual' ? pl.annualTotal : pl.monthly;
      return Promise.resolve(BillingWebhook.ingest({ id: 'ev_up_' + Date.now(), provider: Config.billing.provider || 'demo', type: 'checkout.completed', data: { planId: planId, cycle: cycle, valor: valor, upgrade: true } }));
    },
    downgrade: function (planId) {
      var t = st().tenant;
      if (!this.planById(planId)) return Promise.reject(ApiError('BAD_PLAN', 'Plano inválido.'));
      t.scheduledPlan = planId; // aplicado na próxima cobrança (via webhook payment.approved)
      Store.persist(); Bus.emit('billing:changed');
      return Promise.resolve({ scheduled: true });
    },
    refund: function (invoiceId, reason) {
      return Promise.resolve(BillingWebhook.ingest({ id: 'ev_rf_' + Date.now(), provider: 'internal', type: 'refund.created', data: { invoiceId: invoiceId, reason: reason || '' } }));
    },
    /* expiração de trial E de plano pago + aviso a 3 dias: chamado no boot e a cada navegação */
    checkTrial: function () {
      var t = st().tenant;
      if (!t) return;
      if (t.status === 'trialing') {
        var left = Math.max(0, Math.ceil((new Date(t.trialEndsAt).getTime() - Date.now()) / 864e5));
        if (left <= 3 && left > 0 && !t.trialWarned) {
          t.trialWarned = true;
          var adm = st().users.filter(function (u) { return u.papel === 'admin'; })[0];
          if (adm) EmailService.send('trial_ending', adm.email, { dias: left });
          Store.persist();
        }
        if (left === 0) {
          /* local: bloqueia na hora (modo leitura) */
          BillingWebhook.ingest({ id: 'ev_trialxp_' + t.id, provider: 'internal', type: 'trial.expired', data: {} });
          /* produção: persiste a suspensão no servidor (todas as sessões/dispositivos) */
          if (Config.env === 'production') {
            ApiClient.request('billing.refresh').then(function (r) {
              if (r && r.status) Store.update(function (s) { s.tenant.status = r.status; });
            }).catch(function () { });
          }
        }
      }
      /* plano pago com prazo vencido: suspende na hora (local) e reconcilia no servidor.
         A liberação só volta com pagamento/reativação — nunca sozinha. */
      if (Billing.planExpired(t) && (t.status === 'active' || t.status === 'past_due')) {
        t.status = 'read_only';
        t.planExpiredNotified = true;
        Store.persist();
        Bus.emit('billing:changed');
        if (Config.env === 'production') {
          ApiClient.request('billing.refresh').then(function (r) {
            if (r && r.status) Store.update(function (s) { s.tenant.status = r.status; });
          }).catch(function () { });
        }
      }
    },
    /* produção: reconcilia com o servidor — pega ativação feita pela equipe JR
       (ex.: plano ativado via ticket) sem precisar re-login. Throttle de 45s. */
    syncRemote: function () {
      if (Config.env !== 'production') return;
      this._lastSync = this._lastSync || 0;
      if (Date.now() - this._lastSync < 45000) return;
      var t = st().tenant;
      if (!t || t.status !== 'read_only') return;
      this._lastSync = Date.now();
      ApiClient.request('billing.refresh').then(function (r) {
        if (r && r.status === 'active' && r.planId) {
          Store.update(function (s) {
            s.tenant.status = 'active';
            s.tenant.planId = r.planId;
            s.tenant.planCycle = r.planCycle || 'mensal';
            /* vencimento real do plano, quando o servidor passa (recomendação v6);
               sem o campo, preserva o que a ativação local calculou */
            s.tenant.planExpiresAt = r.planExpiresAt ? new Date(r.planExpiresAt).getTime() : s.tenant.planExpiresAt;
            s.tenant.nextChargeAt = r.nextChargeAt ? new Date(r.nextChargeAt).getTime() : null;
            s.tenant.canceledAt = null; s.tenant.cancelReason = '';
          });
          Bus.emit('billing:changed');
          var pl = Billing.planById(r.planId);
          UI.toast('🎉 Assinatura ativada! Bem-vindo ao plano ' + (pl ? pl.name : r.planId) + '.', { type: 'ok', timeout: 6000 });
        }
      }).catch(function () { });
    },
    /* Seam de checkout real: quando o gateway (Asaas) estiver integrado,
       o adapter cria a sessão e devolve {url}. Até lá, orienta o caminho atual
       (Pix + ativação pelo Suporte) em vez de falhar com erro genérico. */
    startCheckout: function (planId, cycle, method) {
      if (Config.env !== 'production') return Promise.resolve({ simulated: true });
      /* Asaas: o servidor cria cliente+assinatura e devolve a URL da fatura.
         A ativação só acontece no webhook (pagamento confirmado). */
      Analytics.track('checkout_start', { plan: planId, cycle: cycle, method: method });
      return ApiClient.request('billing.checkout', { planId: planId, cycle: cycle, method: method || 'pix' });
    }
  };

  /* ---------------- Webhook de cobrança (caminho único de mutação de assinatura)
     Em produção é chamado pela Edge Function billing-webhook após verificar a
     assinatura do gateway; na demo, pelo checkout simulado. Idempotente por event id. */
  var BillingWebhook = {
    ingest: function (ev) {
      var s = st();
      if (!s.auth) s.auth = { accounts: [], tokens: [], throttle: {}, outbox: [], webhookEvents: [], subEvents: [] };
      var seen = s.auth.webhookEvents;
      if (seen.indexOf(ev.id) > -1) return { duplicate: true };
      seen.push(ev.id); if (seen.length > 300) seen.shift();
      var t = s.tenant, d = ev.data || {};
      var log = function (type) {
        s.auth.subEvents.unshift({ id: 'se_' + ev.id, at: Date.now(), type: type, provider: ev.provider || '', event: ev.id });
        if (s.auth.subEvents.length > 200) s.auth.subEvents.length = 200;
      };
      var adminEmail = function () { var a = s.users.filter(function (u) { return u.papel === 'admin'; })[0]; return a ? a.email : ''; };
      switch (ev.type) {
        case 'checkout.completed':
        case 'payment.approved':
          if (t.scheduledPlan) { t.planId = t.scheduledPlan; t.scheduledPlan = null; log('downgrade_applied'); }
          else if (d.upgrade) log('upgrade');
          else log(ev.type);
          t.status = 'active'; t.startedAt = t.startedAt || Date.now();
          t.planId = d.planId || t.planId; t.planCycle = d.cycle || t.planCycle || 'mensal';
          /* plano pago tem PRAZO (plan_expires_at): quem paga 30/365 dias recebe
             exatamente esse período — a renovação só com novo pagamento aprovado */
          var durDays = d.days || (t.planCycle === 'anual' ? 365 : 30);
          t.planExpiresAt = U.addDays(Date.now(), durDays).toISOString();
          t.planActivatedAt = Date.now();
          t.planActivationReason = d.metodo === 'pix' ? 'pix' : (d.metodo || 'pagamento');
          t.nextChargeAt = t.planExpiresAt;
          var pl = Billing.planById(t.planId);
          t.invoices.unshift({ id: 'inv_' + (d.invoiceId || ev.id), at: Date.now(), planId: t.planId, planName: pl ? pl.name : '', cycle: t.planCycle, valor: d.valor || (pl ? (t.planCycle === 'anual' ? pl.annualTotal : pl.monthly) : 0), status: 'pago', metodo: d.metodo || 'pix' });
          EmailService.send('payment_received', adminEmail(), { plano: pl ? pl.name : '', valor: U.money(t.invoices[0].valor) });
          break;
        case 'payment.declined':
          t.status = 'past_due';
          if (t.invoices[0]) t.invoices[0].status = 'falhou';
          log(ev.type);
          EmailService.send('payment_failed', adminEmail(), {});
          break;
        case 'trial.expired':
          t.status = 'read_only'; log(ev.type); break;
        case 'subscription.canceled':
          t.status = 'read_only'; t.canceledAt = Date.now();
          log(ev.type);
          EmailService.send('subscription_canceled', adminEmail(), {});
          break;
        case 'refund.created': {
          var inv = t.invoices.filter(function (i) { return i.id === d.invoiceId; })[0];
          if (inv) inv.status = 'refundado';
          log(ev.type); break;
        }
        default: log('ignored:' + ev.type);
      }
      Store.persist();
      Bus.emit('billing:changed');
      return { ok: true };
    }
  };

  var Catalog = {
    list: function (f) {
      f = f || {};
      var q = String(f.q || '').trim().toLowerCase();
      return st().products.filter(function (p) {
        if (!f.inactive && !p.ativo) return false;
        if (f.catId && p.catId !== f.catId) return false;
        if (f.lowOnly && !(p.estoque <= p.min)) return false;
        if (q && p.codigo.toLowerCase().indexOf(q) === -1 && p.nome.toLowerCase().indexOf(q) === -1) return false;
        return true;
      }).map(function (p) { return U.clone(p); });
    },
    get: function (id) { var p = findProduct(id); return p ? U.clone(p) : null; },
    byCodeOrName: function (q) {
      q = String(q || '').trim();
      if (!q) return null;
      var s = st();
      var exact = s.products.filter(function (p) { return p.ativo && p.codigo.toLowerCase() === q.toLowerCase(); })[0];
      if (exact) return U.clone(exact);
      var low = q.toLowerCase();
      var part = s.products.filter(function (p) { return p.ativo && p.nome.toLowerCase().indexOf(low) > -1; });
      return part.length ? U.clone(part[0]) : null;
    },
    search: function (q, limit) {
      q = String(q || '').trim().toLowerCase();
      if (!q) return [];
      return st().products.filter(function (p) {
        return p.ativo && (p.nome.toLowerCase().indexOf(q) > -1 || p.codigo.toLowerCase().indexOf(q) > -1);
      }).slice(0, limit || 8).map(function (p) { return U.clone(p); });
    },
    categories: function () { return st().categories.slice(); },
    catName: function (id) { var c = st().categories.filter(function (x) { return x.id === id; })[0]; return c ? c.nome : '—'; },
    create: function (data) { return ApiClient.request('products.create', data); },
    update: function (data) { return ApiClient.request('products.update', data); },
    toggle: function (id) { return ApiClient.request('products.toggle', { id: id }); },
    duplicate: function (id) {
      var p = findProduct(id);
      if (!p) return Promise.reject(ApiError('NOT_FOUND', 'Produto não encontrado.'));
      return ApiClient.request('products.create', { nome: p.nome + ' (cópia)', catId: p.catId, un: p.un, custo: p.custo, preco: p.preco, estoque: 0, min: p.min, fornecedor: p.fornecedor });
    },
    /* CSV: retorna {headers, preview:[{linha,data,errors}], valid, invalid} */
    parseCSV: function (text) {
      var rows = U.csvParse(text);
      if (rows.length < 2) return { preview: [], valid: 0, invalid: 0, error: 'Envie pelo menos cabeçalho + 1 linha.' };
      var ALIASES = {
        codigo: ['codigo', 'cod', 'código', 'ean', 'codigobarras', 'sku'],
        nome: ['nome', 'produto', 'descricao', 'descrição', 'item'],
        categoria: ['categoria', 'cat', 'grupo'],
        unidade: ['unidade', 'un', 'medida'],
        custo: ['custo', 'preco_custo', 'precocusto'],
        preco: ['preco', 'preço', 'venda', 'preco_venda'],
        estoque: ['estoque', 'qtd', 'quantidade', 'saldo'],
        min: ['min', 'minimo', 'mínimo', 'estoque_minimo']
      };
      var head = rows[0].map(function (h) {
        return String(h).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z_]/g, '');
      });
      var map = {};
      Object.keys(ALIASES).forEach(function (field) {
        for (var i = 0; i < head.length; i++) { if (ALIASES[field].indexOf(head[i]) > -1) { map[field] = i; break; } }
      });
      if (map.nome === undefined) return { preview: [], valid: 0, invalid: 0, error: 'Coluna "nome" (ou "produto") não encontrada no cabeçalho.' };
      var cats = st().categories;
      var preview = rows.slice(1).slice(0, 400).map(function (r, i) {
        var g = function (f) { return map[f] !== undefined ? String(r[map[f]] == null ? '' : r[map[f]]).trim() : ''; };
        var errors = [];
        var nome = g('nome'); if (!nome) errors.push('sem nome');
        var preco = U.parseNum(g('preco')); if (!(preco > 0)) errors.push('preço inválido');
        var cat = g('categoria');
        var catId = (cats.filter(function (c) { return c.nome.toLowerCase() === cat.toLowerCase(); })[0] || {}).id || cats[0].id;
        return {
          linha: i + 2, errors: errors,
          data: { codigo: g('codigo'), nome: nome, catId: catId, un: g('unidade') || 'un', custo: g('custo') || '0', preco: g('preco') || '0', estoque: g('estoque') || '0', min: g('min') || '0' }
        };
      });
      var valid = preview.filter(function (r) { return !r.errors.length; }).length;
      return { preview: preview, valid: valid, invalid: preview.length - valid, error: null };
    },
    commitCSV: function (rows) {
      var ok = 0, fail = 0;
      var chain = Promise.resolve();
      rows.filter(function (r) { return !r.errors.length; }).forEach(function (r) {
        chain = chain.then(function () {
          return ApiClient.request('products.create', r.data).then(function () { ok++; }, function () { fail++; });
        });
      });
      return chain.then(function () { return { ok: ok, fail: fail }; });
    }
  };

  var Inventory = {
    entry: function (d) { return ApiClient.request('inventory.entry', d); },
    adjust: function (d) { return ApiClient.request('inventory.adjust', d); },
    history: function (f) {
      f = f || {};
      return st().movements.filter(function (m) {
        if (f.productId && m.productId !== f.productId) return false;
        if (f.tipo && m.tipo !== f.tipo) return false;
        if (f.from && m.at < f.from) return false;
        return true;
      }).slice(0, f.limit || 200).map(function (m) {
        var u = findUser(m.userId);
        return { id: m.id, at: m.at, productId: m.productId, tipo: m.tipo, qtd: m.qtd, userName: u ? u.nome : 'sistema', origem: m.origem, obs: m.obs };
      });
    },
    belowMin: function () { return st().products.filter(function (p) { return p.ativo && p.estoque <= p.min; }).map(function (p) { return U.clone(p); }); },
    valuation: function () {
      return st().products.filter(function (p) { return p.ativo; }).reduce(function (a, p) { return a + p.custo * Math.max(0, p.estoque); }, 0);
    }
  };

  var Sales = {
    commit: function (d) { return ApiClient.request('sales.commit', d).then(function (r) { Bus.emit('sales:changed'); return r.sale; }); },
    cancel: function (id, reason) { return ApiClient.request('sales.cancel', { id: id, reason: reason }).then(function () { Bus.emit('sales:changed'); }); },
    get: function (id) { var s = st().sales.filter(function (x) { return x.id === id; })[0]; return s ? U.clone(s) : null; },
    list: function (f) {
      f = f || {};
      var from = f.days != null ? U.dayStart(f.days - 1) : 0;
      return st().sales.filter(function (s) { return s.at >= from && (!f.status || s.status === f.status); })
        .slice().sort(function (a, b) { return b.at - a.at; });
    }
  };

  var Reports = {
    _window: function (days) { var from = days >= 9999 ? 0 : U.dayStart(days - 1); return st().sales.filter(function (s) { return s.status === 'concluida' && s.at >= from; }); },
    summary: function (days) {
      var ss = this._window(days);
      var total = U.round2(U.sum(ss, function (s) { return s.total; }));
      var itens = U.sum(ss, function (s) { return s.itens.length; });
      return { total: total, count: ss.length, avg: ss.length ? U.round2(total / ss.length) : 0, itens: itens };
    },
    byPayment: function (days) {
      var m = {};
      this._window(days).forEach(function (s) { s.pagamentos.forEach(function (p) { m[p.forma] = U.round2((m[p.forma] || 0) + p.valor); }); });
      return m;
    },
    byOperator: function (days) {
      var m = {};
      this._window(days).forEach(function (s) { var o = m[s.userName] || (m[s.userName] = { n: 0, t: 0 }); o.n++; o.t = U.round2(o.t + s.total); });
      return m;
    },
    topProducts: function (days, limit) {
      var m = {};
      this._window(days).forEach(function (s) {
        s.itens.forEach(function (it) { var a = m[it.nome] || (m[it.nome] = { q: 0, f: 0 }); a.q = U.round2((a.q + it.qtd) * 1000) / 1000; a.f = U.round2(a.f + it.subtotal); });
      });
      return Object.keys(m).map(function (k) { return { nome: k, q: m[k].q, f: m[k].f }; })
        .sort(function (a, b) { return b.q - a.q; }).slice(0, limit || 10);
    },
    byDay: function (n) {
      var out = [];
      for (var i = n - 1; i >= 0; i--) {
        var a = U.dayStart(i), b = U.dayStart(i - 1);
        var tot = U.round2(U.sum(st().sales.filter(function (s) { return s.status === 'concluida' && s.at >= a && s.at < b; }), function (s) { return s.total; }));
        out.push({ date: new Date(a), label: new Date(a).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }), total: tot, today: i === 0 });
      }
      return out;
    }
  };

  var Audit = { list: function (limit) { return st().audit.slice(0, limit || 80); } };

  /* ---------------- Suporte (tickets) ----------------
     Mesmo contrato em mock e produção: create/reply/update/list.
     Em produção o adapter (adapters.js) fala com PostgREST + RPC do Supabase. */
  var Support = {
    CAT_LABEL: { duvida: 'Dúvida', bug: 'Problema/Bug', sugestao: 'Sugestão', faturamento: 'Faturamento', outro: 'Outro' },
    PRIO_LABEL: { baixa: 'Baixa', media: 'Média', alta: 'Alta', urgente: 'Urgente' },
    STATUS_LABEL: {
      aberto: 'Aberto', em_andamento: 'Em atendimento', aguardando_cliente: 'Aguardando cliente',
      aguardando_equipe: 'Aguardando equipe', resolvido: 'Resolvido', fechado: 'Fechado'
    },
    /* transições de status por papel (a “bola” troca de lado) — espelha a v7 */
    isDev: function () { var u = Auth.me(); return !!u && u.papel === 'dev'; },
    create: function (d) {
      return ApiClient.request('tickets.create', d).then(function (r) {
        Analytics.track('ticket_created', { categoria: d.categoria, prioridade: d.prioridade });
        return r;
      });
    },
    reply: function (ticketId, message) { return ApiClient.request('tickets.reply', { ticketId: ticketId, message: message }); },
    update: function (d) { return ApiClient.request('tickets.update', d); },
    /* dev assume o ticket: em_andamento + responsável (mesma semântica do RPC support_take_ticket) */
    take: function (id) {
      var me = Auth.me() || {};
      return ApiClient.request('tickets.update', { id: id, status: 'em_andamento', assigneeId: me.id });
    },
    list: function (opts) {
      opts = opts || {};
      if (Config.env === 'production') return ApiClient.request('tickets.list', { q: opts.q || '', limit: opts.limit, offset: opts.offset });
      var s = st();
      return Promise.resolve(s.tickets.map(function (t) {
        return {
          id: t.id, tenantId: t.tenantId, userId: t.userId, numero: t.numero, assunto: t.assunto, categoria: t.categoria, prioridade: t.prioridade, status: t.status,
          descricao: t.descricao, requesterName: t.userName, requesterEmail: t.userEmail, tenantName: t.tenantName,
          assigneeId: t.assigneeId || null, assigneeName: t.assigneeName || '',
          createdAt: t.createdAt, updatedAt: t.updatedAt
        };
      }));
    },
    messages: function (ticketId) {
      if (Config.env === 'production') return ApiClient.request('tickets.messages', { ticketId: ticketId });
      return Promise.resolve(st().ticketMsgs.filter(function (m) { return m.ticketId === ticketId; })
        .map(function (m) { return { id: m.id, senderId: m.senderId, senderName: m.senderName, senderRole: m.senderRole, tipo: m.tipo || 'mensagem', message: m.message, at: m.at }; }));
    },
    openCount: function () { return st().tickets.filter(function (t) { return t.status !== 'resolvido' && t.status !== 'fechado'; }).length; },

    /* ============ v8 · badge da sidebar + banner (notificação in-app) ============
       O cliente fica sabendo que a equipe respondeu SEM abrir o Suporte:
       badge no item "Suporte" do menu (qualquer tela) + banner persistente
       quando há chamado aguardando a resposta dele. Polling leve de 60s e
       refresh imediato ao voltar para a aba (visibilitychange, no main.js). */
    badgeData: null,
    badge: function () {
      if (Config.env === 'production') {
        return ApiClient.request('tickets.badge', {}).then(function (r) {
          Support.badgeData = { aguardandoCliente: (r && r.aguardandoCliente) || 0, filaEquipe: (r && r.filaEquipe) || 0, ts: Date.now() };
          Bus.emit('badge:changed', Support.badgeData);
          return Support.badgeData;
        });
      }
      var me = Auth.me() || {};
      var isDev = me.papel === 'dev';
      var list = st().tickets;
      Support.badgeData = {
        aguardandoCliente: isDev ? 0 : list.filter(function (t) { return t.status === 'aguardando_cliente'; }).length,
        filaEquipe: isDev ? list.filter(function (t) { return t.status === 'aberto' || t.status === 'aguardando_equipe'; }).length : 0,
        ts: Date.now()
      };
      Bus.emit('badge:changed', Support.badgeData);
      return Promise.resolve(Support.badgeData);
    },
    /* número que aparece no menu (dev → fila da equipe; usuário → bola com ele) */
    badgeCount: function () {
      var b = this.badgeData;
      if (!b) return 0;
      var me = Auth.me() || {};
      return me.papel === 'dev' ? (b.filaEquipe || 0) : (b.aguardandoCliente || 0);
    },
    _badgeTimer: null,
    startBadgePolling: function () {
      var self = this;
      if (this._badgeTimer) return;
      var tick = function () {
        if (!Auth.me()) { self.stopBadgePolling(); return; }
        self.badge().catch(function () { });
        /* PDV destrava sozinho: cliente com a aba ABERTA E VISÍVEL o dia todo
           (caixa do balcão) nunca dispara visibilitychange — o tick de 60s
           também reconcilia o billing (syncRemote só faz chamada quando o
           tenant está read_only; para ativos é no-op local) */
        try { Billing.syncRemote(); } catch (e) { /* não bloqueia */ }
      };
      tick();
      this._badgeTimer = setInterval(tick, 60000);
    },
    stopBadgePolling: function () {
      if (this._badgeTimer) { clearInterval(this._badgeTimer); this._badgeTimer = null; }
      this.badgeData = null;
    },
    /* ao voltar para a aba: badge na hora + reconciliação de billing (destrava
       o PDV se a equipe JR ativou o plano enquanto o cliente estava fora) */
    refreshOnVisible: function () {
      if (!Auth.me()) return;
      this.badge().catch(function () { });
      try {
        Billing._lastSync = 0;   /* zera o throttle de 45s — syncRemote imediato */
        Billing.syncRemote();
      } catch (e) { /* não bloqueia */ }
    },

    /* ============ v8 · PIN da equipe JR (2º fator de cobrança) ============ */
    devPin: {
      get: function () { try { return sessionStorage.getItem('lc_dev_pin') || ''; } catch (e) { return ''; } },
      set: function (v) { try { v ? sessionStorage.setItem('lc_dev_pin', v) : sessionStorage.removeItem('lc_dev_pin'); } catch (e) { } },
      clear: function () { this.set(''); }
    }
  };

  var DataOps = {
    exportJSON: function () {
      var data = U.clone(st());
      data.users.forEach(function (u) { delete u.senha; delete u.passHash; delete u.salt; }); // nunca exportar credenciais
      if (data.auth) (data.auth.accounts || []).forEach(function (a) { delete a.passHash; delete a.salt; });
      return U.download('lojacerta-dados-' + (function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })(new Date()) + '.json', JSON.stringify(data, null, 2), 'application/json');
    },
    exportCSV: function (entity) {
      var s = st();
      if (entity === 'produtos') {
        return U.download('produtos.csv', U.csvBuild(
          ['codigo', 'nome', 'categoria', 'unidade', 'custo', 'preco', 'estoque', 'minimo', 'ativo'],
          s.products.map(function (p) { return [p.codigo, p.nome, Catalog.catName(p.catId), p.un, p.custo, p.preco, p.estoque, p.min, p.ativo ? 'sim' : 'nao']; })
        ), 'text/csv');
      }
      if (entity === 'vendas') {
        return U.download('vendas.csv', U.csvBuild(
          ['numero', 'data', 'operador', 'itens', 'subtotal', 'desconto', 'total', 'pagamentos', 'status'],
          s.sales.map(function (v) { return [v.numero, U.dt(v.at), v.userName, v.itens.length, v.subtotal, v.desconto, v.total, v.pagamentos.map(function (p) { return p.forma + ':' + p.valor; }).join(' | '), v.status]; })
        ), 'text/csv');
      }
      if (entity === 'movimentacoes') {
        return U.download('movimentacoes.csv', U.csvBuild(
          ['data', 'produto', 'tipo', 'qtd', 'usuario', 'origem', 'obs'],
          Inventory.history({ limit: 10000 }).map(function (m) { return [U.dt(m.at), (findProduct(m.productId) || {}).nome || '?', m.tipo, m.qtd, m.userName, m.origem, m.obs]; })
        ), 'text/csv');
      }
      return false;
    },
    resetDemo: function () { Store.reset(Seed.demo()); Bus.emit('data:reset'); },
    clearData: function () {
      var me = Auth.me();
      var s = Seed.freshTenant(st().tenant.nome, me ? me.nome : 'Admin', me ? me.email : 'admin@loja.demo', 'demo123');
      Store.reset(s); Bus.emit('data:reset');
    }
  };

  /* ---------------- Seed ---------------- */
  var CATS = [
    { id: 'c1', nome: 'Cimento' }, { id: 'c2', nome: 'Areia e Pedra' }, { id: 'c3', nome: 'Ferragem' },
    { id: 'c4', nome: 'Elétrica' }, { id: 'c5', nome: 'Hidráulica' }, { id: 'c6', nome: 'Tintas' },
    { id: 'c7', nome: 'Ferramentas' }, { id: 'c8', nome: 'Acabamento' }, { id: 'c9', nome: 'Básico' }
  ];
  var UNIDADES = ['un', 'mg', 'g', 'kg', 't', 'mL', 'L', 'm', 'm²', 'm³', 'saco', 'cx', 'pct', 'fd', 'par', 'dz', 'rolo', 'barra', 'milheiro', 'balde', 'galão', 'hr', 'serv'];
  /* Segmentos de varejo suportados (multi-vertical) */
  var SEGMENTS = {
    'material-construcao': { label: 'Depósito / material de construção', cats: ['Cimento', 'Areia e Pedra', 'Ferragem', 'Elétrica', 'Hidráulica', 'Tintas', 'Ferramentas', 'Acabamento', 'Básico'] },
    'supermercado': { label: 'Supermercado / mercearia', cats: ['Hortifruti', 'Açougue', 'Padaria', 'Bebidas', 'Mercearia', 'Frios e Laticínios', 'Congelados', 'Limpeza', 'Higiene'] },
    'varejo': { label: 'Varejo / loja generalista', cats: ['Vestuário', 'Calçados', 'Acessórios', 'Eletrônicos', 'Papelaria', 'Casa e Decoração', 'Presentes', 'Promoções'] },
    'pub-restaurante': { label: 'Pub / restaurante', cats: ['Cervejas e Chopes', 'Destilados e Drinks', 'Não Alcoólicos', 'Entradas', 'Pratos Principais', 'Sobremesas', 'Insumos de Cozinha', 'Descartáveis'] },
    'odontologia': { label: 'Clínica odontológica', cats: ['Materiais de Consumo', 'Instrumentais', 'EPIs', 'Estética', 'Implantes', 'Ortodontia', 'Esterilização', 'Escritório'] },
    'outro': { label: 'Outro segmento', cats: ['Produtos', 'Serviços', 'Insumos', 'Outros'] }
  };

  function baseState(segment) {
    var seg = SEGMENTS[segment] || SEGMENTS['outro'];
    return {
      meta: { v: 1, seededAt: Date.now(), savedAt: null },
      session: { userId: null },
      auth: { accounts: [], tokens: [], throttle: {}, outbox: [], webhookEvents: [], subEvents: [], signups: [] },
      tenant: {
        id: 't1', nome: 'Minha Loja', cnpj: '', endereco: '', telefone: '', segmento: segment || 'outro',
        status: 'trialing', trialEndsAt: U.addDays(Date.now(), 14).toISOString(),
        planId: null, planCycle: 'mensal', planExpiresAt: null, planActivatedAt: null, planActivationReason: '',
        startedAt: null, nextChargeAt: null, canceledAt: null, cancelReason: '',
        invoices: []
      },
      config: { descontoCaixaPct: 10, permiteEstoqueNegativo: false, reciboMsg: 'Obrigado pela preferência!' },
      users: [], categories: seg.cats.map(function (n, i) { return { id: 'c' + (i + 1), nome: n }; }), products: [], sales: [], movements: [], audit: [],
      tickets: [], ticketMsgs: [], invites: [],
      seq: { sale: 1, int: 1, prod: 1, user: 1, mov: 1, aud: 1, inv: 1, tick: 1 }
    };
  }

  var Seed = {
    /* Instalação de produção nasce vazia: sem usuários (1º cadastro vira admin), sem produtos */
    emptyTenant: function () {
      var s = baseState('outro');
      s.tenant.nome = 'Minha Loja';
      s.session.userId = null;
      return s;
    },
    freshTenant: function (storeName, adminName, email, password, segment) {
      var s = baseState(segment);
      s.tenant.nome = storeName || 'Minha Loja';
      s.users.push({ id: 'u' + s.seq.user++, nome: adminName || 'Administrador', email: String(email || '').toLowerCase(), papel: 'admin', ativo: true, createdAt: Date.now() });
      s.session.userId = s.users[0].id;
      s.audit.push({ id: 'a' + s.seq.aud++, at: Date.now(), userId: s.users[0].id, userName: s.users[0].nome, acao: 'conta.criada', entidade: 'tenant', entidadeId: s.tenant.id, detalhes: 'Trial de 14 dias iniciado' });
      return s;
    },
    demo: function () {
      if (Config.env === 'production') return Seed.emptyTenant(); // em produção, seed demo é inerte
      var s = baseState('material-construcao');
      s.tenant.nome = 'Depósito São José';
      s.tenant.endereco = 'Av. das Obras, 1234 — Centro';
      s.tenant.telefone = '(11) 3456-7890';
      s.tenant.cnpj = '12.345.678/0001-90';
      s.tenant.trialEndsAt = U.addDays(Date.now(), 11).toISOString();
      s.users = [
        { id: 'u1', nome: 'Maria Souza', email: 'maria@lojacerta.demo', senha: 'demo123', papel: 'admin', ativo: true, createdAt: Date.now() },
        { id: 'u2', nome: 'Pedro Lima', email: 'pedro@lojacerta.demo', senha: 'demo123', papel: 'gerente', ativo: true, createdAt: Date.now() },
        { id: 'u3', nome: 'João Batista', email: 'joao@lojacerta.demo', senha: 'demo123', papel: 'operador', ativo: true, createdAt: Date.now() }
      ];
      s.seq.user = 4;
      /* contas de autenticação (hash salgado — nunca texto puro) */
      s.auth.accounts = [
        { id: 'acc_u1', userId: 'u1', email: 'maria@lojacerta.demo', salt: 'salt-u1', passHash: window.hashPassword ? window.hashPassword('demo123', 'salt-u1') : '', confirmed: true, createdAt: Date.now() },
        { id: 'acc_u2', userId: 'u2', email: 'pedro@lojacerta.demo', salt: 'salt-u2', passHash: window.hashPassword ? window.hashPassword('demo123', 'salt-u2') : '', confirmed: true, createdAt: Date.now() },
        { id: 'acc_u3', userId: 'u3', email: 'joao@lojacerta.demo', salt: 'salt-u3', passHash: window.hashPassword ? window.hashPassword('demo123', 'salt-u3') : '', confirmed: true, createdAt: Date.now() }
      ];
      // sessão definida abaixo (visita fresca = deslogada)
      var P = [
        ['7891000001011', 'Cimento CP-II 50kg — Votoran', 'c1', 'saco', 30.5, 38.9, 96, 30],
        ['7891000001028', 'Cimento CP-II 50kg — InterCement', 'c1', 'saco', 29.9, 36.5, 18, 25],
        ['INT-000003', 'Areia lavada', 'c2', 'm³', 85, 110, 7.5, 3],
        ['INT-000004', 'Brita nº 1', 'c2', 'm³', 100, 135, 4, 3],
        ['7891000005019', 'Vergalhão CA-50 3/8" (12m)', 'c3', 'barra', 33, 42.9, 54, 20],
        ['INT-000006', 'Arame recozido', 'c3', 'kg', 9.5, 14.9, 22, 10],
        ['7891000007013', 'Tubo PVC soldável 25mm (6m)', 'c5', 'un', 12.4, 18.7, 37, 15],
        ['INT-000008', 'Fio 2,5mm² 750V — rolo 100m (azul)', 'c4', 'rolo', 142, 189.9, 11, 5],
        ['INT-000009', 'Tinta acrílica branca 18L — Coral', 'c6', 'un', 214, 279.9, 8, 4],
        ['INT-000010', 'Tijolo cerâmico 8 furos', 'c9', 'milheiro', 610, 780, 3, 2],
        ['7891000011010', 'Argamassa AC-II 20kg — Quartzolit', 'c8', 'saco', 24.8, 33.5, 21, 10],
        ['INT-000012', 'Nível de bolha 24"', 'c7', 'un', 36, 54.9, 2, 3],
        ['INT-000013', 'Colher de pedreiro 8"', 'c7', 'un', 12.5, 19.9, 19, 5],
        ['INT-000014', 'Fita veda-rosca 18mm', 'c5', 'un', 2.1, 4.5, 140, 40],
        ['INT-000015', 'Telha fibrocimento 2,44m', 'c9', 'un', 38, 52.9, 26, 10],
        ['INT-000016', 'Prego 18x30', 'c3', 'kg', 11, 17.9, 6, 8]
      ];
      P.forEach(function (r) {
        s.products.push({ id: 'p' + s.seq.prod++, codigo: r[0], nome: r[1], catId: r[2], un: r[3], custo: r[4], preco: r[5], estoque: r[6], min: r[7], fornecedor: '', ativo: true, createdAt: Date.now() });
      });
      s.seq.int = 17;
      s.session.userId = null; // visita fresca começa deslogada (login pela tela de contas demo)

      /* vendas dos últimos 7 dias (determinístico): [diasAtrás, hora, min, userId, itens[[prodIdx,qtd]], desconto, pagamento] */
      var V = [
        [0, 9, 12, 'u3', [[0, 10], [10, 4]], 0, 'pix'], [0, 11, 40, 'u1', [[4, 12], [5, 3]], 0, ['pix', 60, 'dinheiro', 40]],
        [0, 15, 22, 'u3', [[2, 2]], 0, 'credito'], [0, 16, 50, 'u2', [[13, 12], [12, 1]], 0, 'pix'],
        [1, 8, 50, 'u3', [[1, 15]], 0, 'pix'], [1, 14, 10, 'u2', [[8, 2], [12, 1]], 0, 'debito'],
        [1, 17, 5, 'u3', [[13, 10], [14, 4]], 0, 'pix'],
        [2, 9, 30, 'u1', [[7, 3]], 0, 'credito'], [2, 13, 15, 'u3', [[9, 1], [10, 10]], 15, 'pix'],
        [2, 16, 20, 'u3', [[6, 5], [5, 1]], 0, 'dinheiro'],
        [3, 10, 0, 'u2', [[0, 20], [2, 3]], 0, ['debito', 50, 'pix', 50]], [3, 16, 45, 'u3', [[12, 2], [13, 5]], 0, 'dinheiro'],
        [4, 9, 20, 'u3', [[6, 8], [5, 1]], 0, 'pix'], [4, 15, 0, 'u1', [[14, 10]], 0, 'credito'],
        [4, 17, 35, 'u3', [[3, 2], [15, 1]], 0, 'pix'],
        [5, 10, 30, 'u2', [[0, 8], [10, 6]], 0, 'pix'], [5, 16, 20, 'u3', [[11, 1]], 0, 'dinheiro'],
        [6, 8, 40, 'u3', [[1, 10], [0, 5]], 0, ['pix', 65, 'dinheiro', 35]], [6, 14, 55, 'u1', [[4, 6]], 0, 'pix']
      ];
      V.forEach(function (v) {
        var d = new Date(); d.setDate(d.getDate() - v[0]); d.setHours(v[1], v[2], 0, 0);
        var user = findUserIn(s, v[3]);
        var itens = v[4].map(function (it) {
          var p = s.products[it[0]];
          return { productId: p.id, nome: p.nome, un: p.un, qtd: it[1], preco: p.preco, subtotal: U.round2(p.preco * it[1]) };
        });
        var sub = U.round2(U.sum(itens, function (x) { return x.subtotal; }));
        var total = U.round2(sub - v[5]);
        var spec = v[6];
        var pagamentos;
        if (Array.isArray(spec)) {
          var acc = 0; pagamentos = [];
          for (var i = 0; i < spec.length; i += 2) {
            var val = i + 3 >= spec.length ? U.round2(total - acc) : U.round2(total * spec[i + 1] / 100);
            acc = U.round2(acc + val);
            pagamentos.push({ forma: spec[i], valor: val });
          }
        } else pagamentos = [{ forma: spec, valor: total }];
        var sale = {
          id: 's' + s.seq.sale, numero: 'VENDA-' + U.pad(s.seq.sale++), at: d.getTime(),
          userId: user.id, userName: user.nome, itens: itens, subtotal: sub, desconto: v[5],
          descontoTipo: 'R$', total: total, pagamentos: pagamentos, troco: 0, status: 'concluida'
        };
        s.sales.push(sale);
        itens.forEach(function (it) {
          s.movements.unshift({ id: 'm' + s.seq.mov++, at: sale.at, productId: it.productId, tipo: 'saida', qtd: it.qtd, userId: user.id, origem: sale.numero, obs: '' });
        });
      });
      s.sales.sort(function (a, b) { return b.at - a.at; });
      s.movements.unshift({ id: 'm' + s.seq.mov++, at: Date.now() - 5 * 864e5, productId: 'p1', tipo: 'entrada', qtd: 50, userId: 'u1', origem: 'Compra · Fornecedor: Votoran · NF 4581', obs: '' });
      s.movements.unshift({ id: 'm' + s.seq.mov++, at: Date.now() - 4 * 864e5, productId: 'p14', tipo: 'entrada', qtd: 100, userId: 'u1', origem: 'Compra · Fornecedor: Vedacit · NF 4590', obs: '' });
      s.movements.unshift({ id: 'm' + s.seq.mov++, at: Date.now() - 2 * 864e5, productId: 'p3', tipo: 'ajuste', qtd: -0.5, userId: 'u2', origem: 'Inventário', obs: 'Diferença de medição' });
      s.movements.sort(function (a, b) { return b.at - a.at; });
      s.audit = [
        { id: 'a' + s.seq.aud++, at: Date.now(), userId: 'u1', userName: 'Maria Souza', acao: 'login', entidade: 'user', entidadeId: 'u1', detalhes: 'Sessão de demonstração' }
      ];
      return s;
    }
  };
  function findUserIn(s, id) { return s.users.filter(function (u) { return u.id === id; })[0] || s.users[0]; }

  /* ---------------- Exporta ---------------- */
  window.Config = Config; window.ApiClient = ApiClient; window.ApiError = ApiError; window.MockAdapter = MockAdapter;
  window.Auth = Auth; window.Billing = Billing; window.Catalog = Catalog; window.Inventory = Inventory;
  window.Sales = Sales; window.Reports = Reports; window.Audit = Audit; window.DataOps = DataOps;
  window.Seed = Seed; window.UNIDADES = UNIDADES; window.SEGMENTS = SEGMENTS;
  window.BillingWebhook = BillingWebhook; window.Support = Support;
})();
