/* ==========================================================================
   LojaCerta · Recursos dos planos (v2.0)
   Plans  → o que cada plano libera (espelho de public.plan_has no banco)
   Biz    → serviços: clientes, contas a receber/pagar, orçamentos, lojas,
            nota fiscal. As telas só falam com o Biz.
   BizLocal  → implementação local (modo demonstração / testes)
   BizRemote → implementação Supabase (PostgREST + RPCs + Edge "api")
   ========================================================================== */
;(function () {
  'use strict';

  /* ---------------- Planos ---------------- */
  var FEATURES = {
    clientes: { label: 'Clientes', plan: 'profissional' },
    fiado: { label: 'Venda no fiado', plan: 'profissional' },
    financeiro: { label: 'Contas a pagar e receber', plan: 'profissional' },
    orcamentos: { label: 'Orçamentos', plan: 'profissional' },
    multiloja: { label: 'Multi-loja', plan: 'premium' },
    fiscal: { label: 'NFC-e / NF-e', plan: 'premium' }
  };
  var Plans = {
    FEATURES: FEATURES,
    has: function (f) {
      var s = window.Store && Store.state;
      var t = (s && s.tenant) || {};
      var u = window.Auth && Auth.me ? Auth.me() : null;
      if ((u && u.papel === 'dev') || t.planId === 'dev') return true;
      if (t.status === 'trialing') return true;
      var need = (FEATURES[f] || {}).plan;
      if (need === 'profissional') return t.planId === 'profissional' || t.planId === 'premium';
      if (need === 'premium') return t.planId === 'premium';
      return true;
    },
    planName: function (f) { return (FEATURES[f] || {}).plan === 'premium' ? 'Premium' : 'Profissional'; },
    /* painel de upgrade usado quando o plano atual não inclui o recurso */
    upsell: function (f, desc) {
      var feat = FEATURES[f] || { label: f };
      return html`<div class="card upsell-card">
        <div class="upsell-ico">${raw(I('lock', 26))}</div>
        <h2>${feat.label} faz parte do plano ${Plans.planName(f)}</h2>
        <p>${desc || 'Faça upgrade para liberar este recurso agora mesmo — sem perder nenhum dado.'}</p>
        <a class="btn btn-primary btn-lg" href="#/app/assinatura">${raw(I('billing', 17))} Ver planos e fazer upgrade</a>
      </div>`;
    }
  };

  function req(op, p) { return ApiClient.request('biz.' + op, p || {}); }
  var Biz = {
    customers: {
      list: function () { return req('customers.list'); },
      save: function (c) { return req('customers.save', c); },
      toggle: function (id, ativo) { return req('customers.toggle', { id: id, ativo: ativo }); }
    },
    receivables: {
      list: function () { return req('receivables.list'); },
      create: function (r) { return req('receivables.create', r); },
      settle: function (id, valor, forma) { return req('fin.settle', { kind: 'receber', id: id, valor: valor, forma: forma, acao: 'pagar' }); },
      cancel: function (id) { return req('fin.settle', { kind: 'receber', id: id, acao: 'cancelar' }); }
    },
    payables: {
      list: function () { return req('payables.list'); },
      create: function (r) { return req('payables.create', r); },
      settle: function (id, valor, forma) { return req('fin.settle', { kind: 'pagar', id: id, valor: valor, forma: forma, acao: 'pagar' }); },
      cancel: function (id) { return req('fin.settle', { kind: 'pagar', id: id, acao: 'cancelar' }); }
    },
    quotes: {
      list: function () { return req('quotes.list'); },
      create: function (q) { return req('quotes.create', q); },
      cancel: function (id) { return req('quotes.cancel', { id: id }); }
    },
    stores: {
      list: function () { return req('stores.list'); },
      create: function (s) { return req('stores.create', s); },
      switchTo: function (id) { return req('stores.switch', { id: id }); },
      summary: function (days) { return req('stores.summary', { days: days || 30 }); }
    },
    fiscal: {
      config: function () { return req('fiscal.config'); },
      saveConfig: function (c) { return req('fiscal.saveConfig', c); },
      test: function () { return req('fiscal.test'); },
      docs: function (saleId) { return req('fiscal.docs', { saleId: saleId || null }); },
      emit: function (saleId, modelo, cpf) { return req('fiscal.emit', { saleId: saleId, modelo: modelo || 'nfce', cpf: cpf || '' }); },
      status: function (docId) { return req('fiscal.status', { docId: docId }); },
      cancel: function (docId, justificativa) { return req('fiscal.cancel', { docId: docId, justificativa: justificativa }); }
    },
    /* helpers de apresentação */
    today: function () { var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); },
    addDays: function (iso, n) { var d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); },
    fmtDate: function (iso) { if (!iso) return '—'; var p = String(iso).slice(0, 10).split('-'); return p[2] + '/' + p[1] + '/' + p[0]; },
    overdue: function (r) { return r.status === 'aberto' && r.vencimento < Biz.today(); },
    saldo: function (r) { return U.round2(r.valor - (r.valorPago || 0)); }
  };

  /* =================== Implementação LOCAL (demonstração) =================== */
  function uid(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function bz() {
    var s = Store.state;
    if (!s.biz) s.biz = { customers: [], receivables: [], payables: [], quotes: [], fiscalDocs: [], fiscal: { ambiente: 'homologacao', autoEmitir: false, regime: 1, hasToken: false }, stores: [], seeded: false };
    var b = s.biz;
    if (!b.seeded) {
      b.seeded = true;
      var hoje = Biz.today();
      b.customers.push(
        { id: 'c1', nome: 'Construtora Horizonte Ltda', documento: '12345678000190', ie: '', telefone: '(31) 98888-1111', email: 'compras@horizonte.demo', logradouro: 'Av. Amazonas', numero: '1500', bairro: 'Centro', municipio: 'Belo Horizonte', uf: 'MG', cep: '30180001', limite: 5000, obs: 'Paga sempre no dia 10', ativo: true },
        { id: 'c2', nome: 'José Pedreiro', documento: '52998224725', ie: '', telefone: '(31) 97777-2222', email: '', logradouro: 'Rua das Flores', numero: '45', bairro: 'Barreiro', municipio: 'Belo Horizonte', uf: 'MG', cep: '30640000', limite: 800, obs: '', ativo: true },
        { id: 'c3', nome: 'Maria Reformas', documento: '', ie: '', telefone: '(31) 96666-3333', email: '', logradouro: '', numero: '', bairro: '', municipio: '', uf: '', cep: '', limite: 0, obs: '', ativo: true }
      );
      b.receivables.push(
        { id: 'r1', customerId: 'c2', saleId: null, descricao: 'Fiado · compra de cimento', valor: 320, valorPago: 0, vencimento: Biz.addDays(hoje, -3), status: 'aberto', forma: '', createdAt: Date.now() - 20 * 864e5 },
        { id: 'r2', customerId: 'c1', saleId: null, descricao: 'Fiado · pedido de obra', valor: 1850, valorPago: 500, vencimento: Biz.addDays(hoje, 12), status: 'aberto', forma: 'pix', createdAt: Date.now() - 5 * 864e5 }
      );
      b.payables.push(
        { id: 'pg1', fornecedor: 'Votoran Cimentos', descricao: 'Compra de cimento (NF 4521)', categoria: 'Fornecedores', valor: 4200, valorPago: 0, vencimento: Biz.addDays(hoje, 5), status: 'aberto', forma: '', createdAt: Date.now() - 2 * 864e5 },
        { id: 'pg2', fornecedor: 'Imobiliária Central', descricao: 'Aluguel do depósito', categoria: 'Aluguel', valor: 3500, valorPago: 0, vencimento: Biz.addDays(hoje, -1), status: 'aberto', forma: '', createdAt: Date.now() - 25 * 864e5 }
      );
    }
    return b;
  }
  function custName(id) { var c = bz().customers.filter(function (x) { return x.id === id; })[0]; return c ? c.nome : ''; }
  function abertoDe(cid) { return U.round2(U.sum(bz().receivables.filter(function (r) { return r.customerId === cid && r.status === 'aberto'; }), function (r) { return r.valor - r.valorPago; })); }
  function need(f) { if (!Plans.has(f)) throw ApiError('PLAN', (FEATURES[f] || {}).label + ' faz parte do plano ' + Plans.planName(f) + '. Faça upgrade em Assinatura.'); }
  function isStaff() { var u = Auth.me(); return !!(u && ['admin', 'gerente', 'dev'].indexOf(u.papel) > -1); }

  var BizLocal = {
    'biz.customers.list': function () {
      return bz().customers.map(function (c) { return Object.assign({}, c, { aberto: abertoDe(c.id) }); })
        .sort(function (a, b) { return a.nome.localeCompare(b.nome); });
    },
    'biz.customers.save': function (d) {
      need('clientes');
      if (!d.nome || String(d.nome).trim().length < 2) throw ApiError('VALIDATION', 'Informe o nome do cliente.');
      var b = bz(), c = d.id ? b.customers.filter(function (x) { return x.id === d.id; })[0] : null;
      var row = { nome: String(d.nome).trim(), documento: String(d.documento || '').replace(/\D/g, ''), ie: d.ie || '', telefone: d.telefone || '', email: d.email || '',
        logradouro: d.logradouro || '', numero: d.numero || '', bairro: d.bairro || '', municipio: d.municipio || '', uf: String(d.uf || '').toUpperCase(), cep: String(d.cep || '').replace(/\D/g, ''),
        limite: U.round2(Number(d.limite) || 0), obs: d.obs || '' };
      if (c) Object.assign(c, row); else { c = Object.assign({ id: uid('c'), ativo: true }, row); b.customers.push(c); }
      return { id: c.id };
    },
    'biz.customers.toggle': function (d) { need('clientes'); var c = bz().customers.filter(function (x) { return x.id === d.id; })[0]; if (c) c.ativo = !!d.ativo; return { ok: true }; },
    'biz.receivables.list': function () {
      return bz().receivables.map(function (r) { return Object.assign({}, r, { customerNome: custName(r.customerId) }); })
        .sort(function (a, b) { return a.vencimento < b.vencimento ? -1 : 1; });
    },
    'biz.receivables.create': function (d) {
      need('financeiro'); if (!isStaff()) throw ApiError('FORBIDDEN', 'Somente gerente ou administrador.');
      if (!(Number(d.valor) > 0)) throw ApiError('VALIDATION', 'Informe um valor maior que zero.');
      var r = { id: uid('r'), customerId: d.customerId || null, saleId: null, descricao: d.descricao || 'Conta a receber', valor: U.round2(Number(d.valor)), valorPago: 0, vencimento: d.vencimento || Biz.addDays(Biz.today(), 30), status: 'aberto', forma: '', createdAt: Date.now() };
      bz().receivables.push(r); return { id: r.id };
    },
    'biz.payables.list': function () {
      if (!isStaff()) return [];
      return bz().payables.slice().sort(function (a, b) { return a.vencimento < b.vencimento ? -1 : 1; });
    },
    'biz.payables.create': function (d) {
      need('financeiro'); if (!isStaff()) throw ApiError('FORBIDDEN', 'Somente gerente ou administrador.');
      if (!(Number(d.valor) > 0)) throw ApiError('VALIDATION', 'Informe um valor maior que zero.');
      if (!d.descricao || String(d.descricao).trim().length < 2) throw ApiError('VALIDATION', 'Descreva a conta.');
      if (!d.vencimento) throw ApiError('VALIDATION', 'Informe o vencimento.');
      var r = { id: uid('pg'), fornecedor: d.fornecedor || '', descricao: String(d.descricao).trim(), categoria: d.categoria || 'Outros', valor: U.round2(Number(d.valor)), valorPago: 0, vencimento: d.vencimento, status: 'aberto', forma: '', createdAt: Date.now() };
      bz().payables.push(r); return { id: r.id };
    },
    'biz.fin.settle': function (d) {
      need('financeiro'); if (!isStaff()) throw ApiError('FORBIDDEN', 'Somente gerente ou administrador.');
      var list = d.kind === 'pagar' ? bz().payables : bz().receivables;
      var r = list.filter(function (x) { return x.id === d.id; })[0];
      if (!r) throw ApiError('NOT_FOUND', 'Conta não encontrada.');
      if (r.status !== 'aberto') throw ApiError('VALIDATION', 'Esta conta já está ' + r.status + '.');
      if (d.acao === 'cancelar') { if (Auth.me().papel !== 'admin' && Auth.me().papel !== 'dev') throw ApiError('FORBIDDEN', 'Somente o administrador cancela contas.'); r.status = 'cancelado'; return { ok: true }; }
      var v = U.round2(Number(d.valor) || 0), saldo = U.round2(r.valor - r.valorPago);
      if (v <= 0) v = saldo;
      if (v > saldo + 0.001) throw ApiError('VALIDATION', 'O valor informado é maior que o saldo em aberto (' + U.money(saldo) + ').');
      r.valorPago = U.round2(r.valorPago + v); r.forma = d.forma || '';
      if (r.valorPago >= r.valor - 0.001) { r.status = 'pago'; r.pagoEm = Date.now(); }
      return { ok: true };
    },
    'biz.quotes.list': function () {
      return bz().quotes.map(function (q) { return Object.assign({}, q, { clienteNome: q.clienteNome || custName(q.customerId) }); })
        .sort(function (a, b) { return b.createdAt - a.createdAt; });
    },
    'biz.quotes.create': function (d) {
      need('orcamentos');
      var b = bz();
      var itens = (d.itens || []).map(function (it) {
        var p = Store.state.products.filter(function (x) { return x.id === it.productId; })[0];
        if (!p) return null; var q = Number(it.qtd) || 0; if (q <= 0) return null;
        return { productId: p.id, nome: p.nome, un: p.un, qtd: q, preco: p.preco, subtotal: U.round2(p.preco * q) };
      }).filter(Boolean);
      if (!itens.length) throw ApiError('VALIDATION', 'Adicione ao menos um produto ao orçamento.');
      var sub = U.round2(U.sum(itens, function (i) { return i.subtotal; })), desc = U.clamp(U.round2(Number(d.desconto) || 0), 0, sub);
      var n = b.quotes.length + 1;
      var q = { id: uid('q'), numero: 'ORC-' + U.pad(n), customerId: d.customerId || null, clienteNome: d.clienteNome || '', itens: itens, subtotal: sub, desconto: desc, total: U.round2(sub - desc),
        validade: d.validade || Biz.addDays(Biz.today(), 7), status: 'aberto', saleId: null, obs: d.obs || '', createdAt: Date.now() };
      b.quotes.push(q); return { id: q.id, numero: q.numero };
    },
    'biz.quotes.cancel': function (d) { need('orcamentos'); var q = bz().quotes.filter(function (x) { return x.id === d.id; })[0]; if (q && q.status === 'aberto') q.status = 'cancelado'; return { ok: true }; },
    'biz.stores.list': function () {
      var b = bz(), t = Store.state.tenant;
      return [{ id: 'local', nome: t.nome, papel: 'admin', principal: true, atual: !b.storeAtual }].concat(b.stores.map(function (x) { return { id: x.id, nome: x.nome, papel: 'admin', principal: false, atual: b.storeAtual === x.id }; }));
    },
    'biz.stores.create': function (d) {
      need('multiloja');
      if (!d.nome || String(d.nome).trim().length < 2) throw ApiError('VALIDATION', 'Informe o nome da nova loja.');
      var x = { id: uid('lj'), nome: String(d.nome).trim() }; bz().stores.push(x); return x;
    },
    'biz.stores.switch': function (d) { bz().storeAtual = d.id === 'local' ? null : d.id; return { ok: true, local: true }; },
    'biz.stores.summary': function () {
      var vendas = Store.state.sales.filter(function (s) { return s.status === 'concluida' && s.at > Date.now() - 30 * 864e5; });
      var base = { id: 'local', nome: Store.state.tenant.nome, vendas: vendas.length, faturamento: U.round2(U.sum(vendas, function (v) { return v.total; })),
        abaixoMinimo: Store.state.products.filter(function (p) { return p.ativo && p.estoque <= p.min; }).length, receberAberto: U.round2(U.sum(bz().receivables.filter(function (r) { return r.status === 'aberto'; }), function (r) { return r.valor - r.valorPago; })) };
      return [base].concat(bz().stores.map(function (x) { return { id: x.id, nome: x.nome, vendas: 0, faturamento: 0, abaixoMinimo: 0, receberAberto: 0 }; }));
    },
    'biz.fiscal.config': function () { return Object.assign({ liberado: Plans.has('fiscal') }, bz().fiscal); },
    'biz.fiscal.saveConfig': function (d) {
      need('fiscal');
      var f = bz().fiscal; f.ambiente = d.ambiente === 'producao' ? 'producao' : 'homologacao'; f.autoEmitir = !!d.autoEmitir; f.regime = Number(d.regime) || 1;
      if (d.token) f.hasToken = true;
      return Object.assign({ liberado: true }, f);
    },
    'biz.fiscal.test': function () { need('fiscal'); if (!bz().fiscal.hasToken) throw ApiError('NOT_CONFIGURED', 'Informe o token do Focus NFe e salve antes de testar.'); return { ok: true, message: 'Demonstração: conexão simulada com o emissor fiscal.' }; },
    'biz.fiscal.docs': function (d) { return bz().fiscalDocs.filter(function (x) { return !d.saleId || x.saleId === d.saleId; }).sort(function (a, b) { return b.createdAt - a.createdAt; }); },
    'biz.fiscal.emit': function (d) {
      need('fiscal');
      if (!bz().fiscal.hasToken) throw ApiError('NOT_CONFIGURED', 'Nota fiscal ainda não configurada: informe o token do Focus NFe em Nota fiscal.');
      var sale = Store.state.sales.filter(function (s) { return s.id === d.saleId; })[0];
      if (!sale) throw ApiError('NOT_FOUND', 'Venda não encontrada.');
      var ex = bz().fiscalDocs.filter(function (x) { return x.saleId === d.saleId && x.modelo === (d.modelo || 'nfce') && x.status === 'autorizado'; })[0];
      if (ex) return { ok: true, doc: ex, existing: true };
      var n = bz().fiscalDocs.length + 1;
      var doc = { id: uid('fd'), saleId: d.saleId, modelo: d.modelo || 'nfce', ref: uid('ref'), status: 'autorizado', numero: String(n), serie: '1', chave: String(Date.now()) + '0000000000000000000000000000000', danfeUrl: '', xmlUrl: '',
        mensagem: 'Demonstração — nota simulada, sem valor fiscal', ambiente: bz().fiscal.ambiente, createdAt: Date.now() };
      bz().fiscalDocs.push(doc); return { ok: true, doc: doc };
    },
    'biz.fiscal.status': function (d) { return { ok: true, doc: bz().fiscalDocs.filter(function (x) { return x.id === d.docId; })[0] }; },
    'biz.fiscal.cancel': function (d) {
      var doc = bz().fiscalDocs.filter(function (x) { return x.id === d.docId; })[0];
      if (!doc) throw ApiError('NOT_FOUND', 'Nota não encontrada.');
      if (String(d.justificativa || '').trim().length < 15) throw ApiError('VALIDATION', 'A justificativa do cancelamento deve ter entre 15 e 255 caracteres.');
      doc.status = 'cancelado'; doc.mensagem = 'Cancelamento homologado (demonstração)'; return { ok: true, doc: doc };
    },
    /* ganchos da venda local (mesma regra do banco: sale_post_hook) */
    _beforeSale: function (d, total) {
      var fiado = U.round2(U.sum((d.payments || []).filter(function (p) { return p.forma === 'fiado'; }), function (p) { return Number(p.valor) || 0; }));
      var c = d.customerId ? bz().customers.filter(function (x) { return x.id === d.customerId; })[0] : null;
      if (d.customerId && (!c || !c.ativo)) throw ApiError('VALIDATION', 'Cliente não encontrado ou inativo.');
      if (fiado > 0) {
        need('fiado');
        if (!c) throw ApiError('VALIDATION', 'Selecione o cliente para vender no fiado.');
        if (c.limite > 0 && abertoDe(c.id) + fiado > c.limite + 0.001)
          throw ApiError('CREDIT_LIMIT', 'Limite de crédito de ' + c.nome + ' excedido: em aberto ' + U.money(abertoDe(c.id)) + ', limite ' + U.money(c.limite) + '.');
      }
      return fiado;
    },
    _afterSale: function (sale, d, fiado) {
      if (d.customerId) { sale.customerId = d.customerId; sale.customerNome = custName(d.customerId); }
      if (fiado > 0) bz().receivables.push({ id: uid('r'), customerId: d.customerId, saleId: sale.id, descricao: 'Fiado · ' + sale.numero, valor: fiado, valorPago: 0,
        vencimento: d.fiadoVencimento || Biz.addDays(Biz.today(), 30), status: 'aberto', forma: '', createdAt: Date.now() });
      if (d.quoteId) { var q = bz().quotes.filter(function (x) { return x.id === d.quoteId; })[0]; if (q && q.status === 'aberto') { q.status = 'convertido'; q.saleId = sale.id; } }
    },
    _afterCancel: function (saleId) {
      bz().receivables.forEach(function (r) { if (r.saleId === saleId && r.status === 'aberto') r.status = 'cancelado'; });
      bz().quotes.forEach(function (q) { if (q.saleId === saleId && q.status === 'convertido') { q.status = 'aberto'; q.saleId = null; } });
    }
  };

  /* =================== Implementação SUPABASE =================== */
  function rpc(c, fn, body) { return fetch(c.B + '/rest/v1/rpc/' + fn, { method: 'POST', headers: c.H, body: JSON.stringify(body || {}) }).then(c.j); }
  function get(c, path) { return fetch(c.B + '/rest/v1/' + path, { headers: c.H }).then(c.j); }
  function send(c, method, path, body) {
    return fetch(c.B + '/rest/v1/' + path, { method: method, headers: Object.assign({ Prefer: 'return=representation' }, c.H), body: JSON.stringify(body) }).then(c.j)
      .then(function (rows) {
        if (method !== 'POST' && Array.isArray(rows) && !rows.length) throw ApiError('FORBIDDEN', 'Sem permissão para alterar este registro (plano ou papel).');
        return rows;
      });
  }
  function edge(c, op, payload) { return fetch(c.B + '/functions/v1/api', { method: 'POST', headers: c.H, body: JSON.stringify({ op: op, payload: payload || {} }) }).then(c.j); }
  function mapCust(x) {
    return { id: x.id, nome: x.nome, documento: x.documento, ie: x.ie, telefone: x.telefone, email: x.email, logradouro: x.logradouro, numero: x.numero, bairro: x.bairro,
      municipio: x.municipio, uf: x.uf, cep: x.cep, limite: Number(x.limite_credito), obs: x.obs, ativo: x.ativo };
  }
  function mapFin(x) {
    return { id: x.id, customerId: x.customer_id || null, customerNome: (x.customers && x.customers.nome) || '', saleId: x.sale_id || null, fornecedor: x.fornecedor || '', categoria: x.categoria || '',
      descricao: x.descricao, valor: Number(x.valor), valorPago: Number(x.valor_pago), vencimento: x.vencimento, status: x.status, forma: x.forma_pagamento || '',
      pagoEm: x.pago_em ? new Date(x.pago_em).getTime() : null, createdAt: new Date(x.created_at).getTime() };
  }
  function mapDoc(x) {
    return { id: x.id, saleId: x.sale_id, modelo: x.modelo, ref: x.ref, status: x.status, numero: x.numero, serie: x.serie, chave: x.chave, danfeUrl: x.danfe_url, xmlUrl: x.xml_url,
      mensagem: x.mensagem, ambiente: x.ambiente, createdAt: new Date(x.created_at).getTime() };
  }
  var BizRemote = {
    'biz.customers.list': function (p, c) {
      return Promise.all([get(c, 'customers?select=*&tenant_id=eq.' + c.sid + '&order=nome&limit=5000'),
        get(c, 'receivables?select=customer_id,valor,valor_pago&status=eq.aberto&tenant_id=eq.' + c.sid + '&limit=10000')]).then(function (d) {
        var ab = {}; (d[1] || []).forEach(function (r) { if (r.customer_id) ab[r.customer_id] = U.round2((ab[r.customer_id] || 0) + Number(r.valor) - Number(r.valor_pago)); });
        return (d[0] || []).map(function (x) { return Object.assign(mapCust(x), { aberto: ab[x.id] || 0 }); });
      });
    },
    'biz.customers.save': function (p, c) {
      var row = { nome: String(p.nome || '').trim(), documento: String(p.documento || '').replace(/\D/g, ''), ie: p.ie || '', telefone: p.telefone || '', email: p.email || '',
        logradouro: p.logradouro || '', numero: p.numero || '', bairro: p.bairro || '', municipio: p.municipio || '', uf: String(p.uf || '').toUpperCase(),
        cep: String(p.cep || '').replace(/\D/g, ''), limite_credito: Number(p.limite) || 0, obs: p.obs || '' };
      var op = p.id ? send(c, 'PATCH', 'customers?id=eq.' + p.id, row) : send(c, 'POST', 'customers', Object.assign({ tenant_id: c.sid }, row));
      return op.then(function (rows) { return { id: rows[0].id }; });
    },
    'biz.customers.toggle': function (p, c) { return send(c, 'PATCH', 'customers?id=eq.' + p.id, { ativo: !!p.ativo }).then(function () { return { ok: true }; }); },
    'biz.receivables.list': function (p, c) { return get(c, 'receivables?select=*,customers(nome)&tenant_id=eq.' + c.sid + '&order=vencimento.asc&limit=5000').then(function (r) { return (r || []).map(mapFin); }); },
    'biz.receivables.create': function (p, c) {
      return send(c, 'POST', 'receivables', { tenant_id: c.sid, customer_id: p.customerId || null, descricao: p.descricao || 'Conta a receber', valor: Number(p.valor),
        vencimento: p.vencimento, created_by: (Store.state.session || {}).userId }).then(function (r) { return { id: r[0].id }; });
    },
    'biz.payables.list': function (p, c) { return get(c, 'payables?select=*&tenant_id=eq.' + c.sid + '&order=vencimento.asc&limit=5000').then(function (r) { return (r || []).map(mapFin); }); },
    'biz.payables.create': function (p, c) {
      return send(c, 'POST', 'payables', { tenant_id: c.sid, fornecedor: p.fornecedor || '', descricao: p.descricao, categoria: p.categoria || 'Outros', valor: Number(p.valor),
        vencimento: p.vencimento, created_by: (Store.state.session || {}).userId }).then(function (r) { return { id: r[0].id }; });
    },
    'biz.fin.settle': function (p, c) { return rpc(c, 'fin_settle', { p: p }); },
    'biz.quotes.list': function (p, c) {
      return get(c, 'quotes?select=*,customers(nome)&tenant_id=eq.' + c.sid + '&order=created_at.desc&limit=1000').then(function (r) {
        return (r || []).map(function (x) {
          return { id: x.id, numero: x.numero, customerId: x.customer_id, clienteNome: x.cliente_nome || (x.customers && x.customers.nome) || '', itens: (x.itens || []).map(function (i) { return { productId: i.productId, nome: i.nome, un: i.un, qtd: Number(i.qtd), preco: Number(i.preco), subtotal: Number(i.subtotal) }; }),
            subtotal: Number(x.subtotal), desconto: Number(x.desconto), total: Number(x.total), validade: x.validade, status: x.status, saleId: x.sale_id, obs: x.obs, createdAt: new Date(x.created_at).getTime() };
        });
      });
    },
    'biz.quotes.create': function (p, c) {
      return send(c, 'POST', 'quotes', { tenant_id: c.sid, customer_id: p.customerId || null, cliente_nome: p.clienteNome || '', desconto: Number(p.desconto) || 0,
        validade: p.validade, obs: p.obs || '', itens: (p.itens || []).map(function (i) { return { productId: i.productId, qtd: Number(i.qtd) }; }) }).then(function (r) { return { id: r[0].id, numero: r[0].numero }; });
    },
    'biz.quotes.cancel': function (p, c) { return send(c, 'PATCH', 'quotes?id=eq.' + p.id, { status: 'cancelado' }).then(function () { return { ok: true }; }); },
    'biz.stores.list': function (p, c) { return rpc(c, 'store_list'); },
    'biz.stores.create': function (p, c) { return rpc(c, 'store_create', { p: { nome: p.nome, cnpj: p.cnpj || '', telefone: p.telefone || '', endereco: p.endereco || '' } }); },
    'biz.stores.switch': function (p, c) { return rpc(c, 'store_switch', { p: { id: p.id } }); },
    'biz.stores.summary': function (p, c) { return rpc(c, 'group_summary', { p_days: p.days || 30 }); },
    'biz.fiscal.config': function (p, c) { return rpc(c, 'fiscal_config_get'); },
    'biz.fiscal.saveConfig': function (p, c) { return rpc(c, 'fiscal_config_set', { p: p }); },
    'biz.fiscal.test': function (p, c) { return edge(c, 'fiscal.test'); },
    'biz.fiscal.docs': function (p, c) {
      return get(c, 'fiscal_docs?select=*&tenant_id=eq.' + c.sid + (p.saleId ? '&sale_id=eq.' + p.saleId : '') + '&order=created_at.desc&limit=500').then(function (r) { return (r || []).map(mapDoc); });
    },
    'biz.fiscal.emit': function (p, c) { return edge(c, 'fiscal.emit', p).then(function (r) { return { ok: true, doc: mapDoc(r.doc), existing: r.existing }; }); },
    'biz.fiscal.status': function (p, c) { return edge(c, 'fiscal.status', p).then(function (r) { return { ok: true, doc: mapDoc(r.doc) }; }); },
    'biz.fiscal.cancel': function (p, c) { return edge(c, 'fiscal.cancel', p).then(function (r) { return { ok: true, doc: mapDoc(r.doc) }; }); }
  };


  /* =================== PDV offline: fila de vendas sem internet ===================
     Produção apenas. Se a conexão cair ao finalizar, a venda vai para uma fila no
     aparelho (localStorage) com o MESMO idempotencyId; o banco (commit_sale) usa
     esse id como chave, então reenviar nunca duplica. A fila é enviada sozinha ao
     voltar a conexão, ao abrir o app e a cada 30 s. */
  var OfflineQueue = {
    KEY: 'lc_offline_sales', FAIL: 'lc_offline_failed', busy: false,
    list: function (k) { try { return JSON.parse(localStorage.getItem(k || this.KEY) || '[]'); } catch (e) { return []; } },
    save: function (l, k) { try { localStorage.setItem(k || this.KEY, JSON.stringify(l)); } catch (e) { } this.banner(); },
    isNetErr: function (e) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
      return !!e && (e.name === 'TypeError' || e.code === 'NETWORK' || /Failed to fetch|NetworkError|Load failed|network|ERR_INTERNET|timeout/i.test(String(e.message || '')));
    },
    enqueue: function (d) {
      var st = Store.state, me = Auth.me() || {};
      var itens = (d.items || []).map(function (it) {
        var p = st.products.filter(function (x) { return x.id === it.productId; })[0] || {};
        var q = Number(it.qtd) || 0; var pr = Number(p.preco != null ? p.preco : it.preco) || 0;
        return { productId: it.productId, nome: p.nome || it.nome, un: p.un || it.un, qtd: q, preco: pr, subtotal: U.round2(pr * q) };
      });
      var sub = U.round2(U.sum(itens, function (i) { return i.subtotal; }));
      var disc = d.discount || { tipo: 'R$', valor: 0 };
      var dv = U.clamp(U.round2(disc.tipo === '%' ? sub * (Number(disc.valor) || 0) / 100 : (Number(disc.valor) || 0)), 0, sub);
      var q = this.list(); q.push({ d: d, at: Date.now() });
      var sale = { id: d.idempotencyId, numero: 'OFFLINE-' + U.pad(q.length, 3), at: Date.now(), userId: me.id, userName: me.nome || '', itens: itens,
        subtotal: sub, desconto: dv, descontoTipo: disc.tipo, total: U.round2(sub - dv), pagamentos: d.payments || [], status: 'concluida', pending: true,
        customerId: d.customerId || null, customerNome: d.customerNome || '' };
      Store.update(function (s) {
        itens.forEach(function (it) { var x = s.products.filter(function (y) { return y.id === it.productId; })[0]; if (x) x.estoque = Math.round((x.estoque - it.qtd) * 1000) / 1000; });
        s.sales.unshift(sale);
      });
      this.save(q);
      return sale;
    },
    flush: function () {
      var self = this;
      if (self.busy || Config.env !== 'production' || !Auth.me()) return Promise.resolve();
      var q = self.list(); if (!q.length) { self.banner(); return Promise.resolve(); }
      self.busy = true;
      var sent = 0;
      var step = function () {
        var cur = self.list(); if (!cur.length) return Promise.resolve();
        var item = cur[0];
        return ApiClient.request('sales.commit', item.d).then(function (r) {
          var sale = r.sale || r;
          Store.update(function (s) {
            /* o adapter acabou de inserir a venda do servidor E baixar o estoque de novo:
               remove a provisória e devolve a baixa duplicada da provisória */
            var prov = s.sales.filter(function (v) { return v.pending && v.id === item.d.idempotencyId; })[0];
            if (prov) {
              prov.itens.forEach(function (it) { var x = s.products.filter(function (y) { return y.id === it.productId; })[0]; if (x) x.estoque = Math.round((x.estoque + it.qtd) * 1000) / 1000; });
              s.sales = s.sales.filter(function (v) { return v !== prov; });
            }
          });
          self.save(self.list().slice(1)); sent++;
          return step();
        }).catch(function (e) {
          if (self.isNetErr(e)) return; // continua sem internet: tenta depois
          /* recusa de regra (ex.: estoque acabou): tira da fila, guarda em "falhas" e avisa */
          var f = self.list(self.FAIL); f.push({ d: item.d, at: item.at, erro: e.message || String(e) }); self.save(f, self.FAIL);
          Store.update(function (s) {
            var prov = s.sales.filter(function (v) { return v.pending && v.id === item.d.idempotencyId; })[0];
            if (prov) {
              prov.itens.forEach(function (it) { var x = s.products.filter(function (y) { return y.id === it.productId; })[0]; if (x) x.estoque = Math.round((x.estoque + it.qtd) * 1000) / 1000; });
              s.sales = s.sales.filter(function (v) { return v !== prov; });
            }
          });
          self.save(self.list().slice(1));
          try { UI.toast('Uma venda feita sem internet foi recusada pelo servidor: ' + (e.message || 'erro') + ' Refaça a venda no PDV.', { type: 'err', timeout: 12000 }); } catch (x) { }
          return step();
        });
      };
      return step().then(function () {
        self.busy = false; self.banner();
        if (sent) { try { UI.toast(sent + ' venda(s) feita(s) sem internet foram enviadas ✔', { type: 'ok' }); Bus.emit('sales:changed'); Bus.emit('store:changed', Store.state); } catch (x) { } }
      }, function () { self.busy = false; self.banner(); });
    },
    banner: function () {
      if (typeof document === 'undefined') return;
      var n = this.list().length, el = document.getElementById('offline-bar');
      if (!n) { if (el) el.remove(); return; }
      if (!el) { el = document.createElement('div'); el.id = 'offline-bar'; el.className = 'offline-bar'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
      el.textContent = (navigator.onLine === false ? 'Sem internet — ' : 'Enviando — ') + n + ' venda(s) aguardando envio ao servidor. Pode continuar vendendo.';
    }
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', function () { OfflineQueue.flush(); });
    window.addEventListener('offline', function () { OfflineQueue.banner(); });
    setInterval(function () { if (OfflineQueue.list().length) OfflineQueue.flush(); }, 30000);
    setTimeout(function () { OfflineQueue.flush(); }, 4000);
  }
  window.OfflineQueue = OfflineQueue;
  window.Plans = Plans; window.Biz = Biz; window.BizLocal = BizLocal; window.BizRemote = BizRemote;
})();
