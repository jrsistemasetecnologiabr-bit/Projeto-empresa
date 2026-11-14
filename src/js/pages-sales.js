/* ==========================================================================
   LojaCerta · Pages — Vendas (Dashboard, PDV, Vendas)
   + componentes compartilhados (window.C) usados por todas as páginas.
   ========================================================================== */
;(function () {
  'use strict';
  window.Pages = window.Pages || {};

  /* =================== COMPONENTES COMPARTILHADOS =================== */
  var PAY_COLORS = { pix: '#0D9488', credito: '#6366F1', debito: '#F59E0B', dinheiro: '#22C55E' };
  var PAY_LABEL = { pix: 'Pix', credito: 'Crédito', debito: 'Débito', dinheiro: 'Dinheiro' };

  var C = {
    payColors: PAY_COLORS, payLabel: PAY_LABEL,
    pageHead: function (title, sub, actions) {
      return html`<div class="page-head"><div><h2>${title}</h2>${sub ? html`<p class="ph-sub">${sub}</p>` : ''}</div>${actions ? html`<div class="page-actions">${actions}</div>` : ''}</div>`;
    },
    kpi: function (o) {
      return html`<div class="kpi">
        <div class="kpi-top"><span class="kpi-lbl">${o.lbl}</span>
        ${o.icon ? html`<span class="kpi-ico ${o.tone || ''}">${raw(I(o.icon, 17))}</span>` : ''}</div>
        <div class="kpi-val">${o.val}</div>
        ${o.sub ? html`<div class="kpi-sub">${raw(o.sub)}</div>` : ''}
      </div>`;
    },
    panel: function (title, sub, body, actions) {
      return html`<section class="panel">
        <div class="panel-head"><div><h3>${title}</h3>${sub ? html`<span class="panel-sub">${sub}</span>` : ''}</div>
        ${actions ? html`<div class="flex gap-2">${actions}</div>` : ''}</div>
        ${body}
      </section>`;
    },
    empty: function (icon, title, text, actions) {
      return html`<div class="empty"><div class="empty-ico">${raw(I(icon, 26))}</div><h3>${title}</h3><p>${text}</p>${actions || ''}</div>`;
    },
    skeleton: function (kind) {
      if (kind === 'kpis') return raw('<div class="kpi-grid">' + '<div class="sk sk-card"></div>'.repeat(4) + '</div><div class="grid-2w mt-3"><div class="sk" style="height:260px;border-radius:14px"></div><div class="sk" style="height:260px;border-radius:14px"></div></div>');
      if (kind === 'table') return raw('<div class="sk" style="height:48px;border-radius:14px;margin-bottom:14px"></div><div class="sk" style="height:340px;border-radius:14px"></div>');
      return raw('<div class="sk sk-card"></div>');
    },
    errorPanel: function (err, retryAct) {
      return html`<div class="panel" style="border-color:var(--danger-line)">
        ${C.empty('wifi-off', 'Não foi possível carregar', U.esc(err && err.message ? err.message : 'Erro inesperado.'), raw('<button type="button" class="btn btn-primary" data-act="' + (retryAct || 'retry-page') + '">' + I('refresh', 16) + ' Tentar novamente</button>'))}
      </div>`;
    },
    stockBadge: function (p) {
      if (!p.ativo) return raw('<span class="badge badge-mut">inativo</span>');
      if (p.estoque <= 0) return raw('<span class="badge badge-danger">' + U.num(p.estoque) + ' ' + U.esc(p.un) + ' · zerado</span>');
      if (p.estoque <= p.min) return raw('<span class="badge badge-warn">' + U.num(p.estoque) + ' ' + U.esc(p.un) + ' · baixo</span>');
      return raw('<span class="badge badge-mut no-dot">' + U.num(p.estoque) + ' ' + U.esc(p.un) + '</span>');
    },
    payBadges: function (pays) {
      return raw(pays.map(function (p) { return '<span class="badge badge-mut no-dot" style="border-color:' + (PAY_COLORS[p.forma] || '#CBD5E1') + '44;color:' + (PAY_COLORS[p.forma] || '#475569') + '">' + U.esc(PAY_LABEL[p.forma] || p.forma) + (pays.length > 1 ? ' ' + U.money(p.valor) : '') + '</span>'; }).join(' '));
    },
    subBadge: function (info) {
      if (info.plan && info.plan.id === 'dev') return raw('<span class="badge badge-brand no-dot">' + I('headset', 11) + ' Dev · ilimitado</span>');
      if (info.status === 'trialing') return raw('<span class="badge badge-warn">' + I('clock', 11) + ' Trial · ' + (info.daysLeft || 0) + 'd</span>');
      if (info.status === 'active') return raw('<span class="badge badge-ok">' + I('check', 11) + ' ' + U.esc(info.plan ? info.plan.name : 'Ativo') + '</span>');
      if (info.status === 'past_due') return raw('<span class="badge badge-warn">' + I('alert', 11) + ' Pgto pendente</span>');
      return raw('<span class="badge badge-danger">' + I('lock', 11) + ' Suspenso</span>');
    },
    bars: function (days) {
      var max = Math.max.apply(null, days.map(function (d) { return d.total; }).concat([1]));
      return html`<div class="bars" role="img" aria-label="Faturamento dos últimos ${days.length} dias">${days.map(function (d) {
        return html`<div class="bcol" title="${d.label}: ${U.money(d.total)}">
          <span class="bval">${d.total >= 1000 ? (d.total / 1000).toFixed(1).replace('.', ',') + 'k' : (d.total > 0 ? Math.round(d.total) : '')}</span>
          <div class="bar ${d.today ? 'today' : ''}" style="height:${Math.max(2, Math.round((d.total / max) * 100))}%"></div>
          <span class="blbl">${d.label}</span></div>`;
      })}</div>`;
    },
    donut: function (map) {
      var entries = Object.keys(map).map(function (k) { return { k: k, v: map[k] }; }).sort(function (a, b) { return b.v - a.v; });
      var total = U.sum(entries, function (e) { return e.v; });
      if (!total) return html`<p class="muted small">Sem vendas no período.</p>`;
      var R = 54, CIR = 2 * Math.PI * R, acc = 0;
      var segs = entries.map(function (e) {
        var len = (e.v / total) * CIR;
        var s = raw('<circle cx="74" cy="74" r="' + R + '" stroke="' + (PAY_COLORS[e.k] || '#94A3B8') + '" stroke-dasharray="' + len.toFixed(2) + ' ' + (CIR - len).toFixed(2) + '" stroke-dashoffset="' + (-acc).toFixed(2) + '"><title>' + U.esc(PAY_LABEL[e.k] || e.k) + ': ' + U.money(e.v) + '</title></circle>');
        acc += len; return s;
      });
      return html`<div class="donut-wrap">
        <svg class="donut" viewBox="0 0 148 148" role="img" aria-label="Vendas por forma de pagamento">
          <circle cx="74" cy="74" r="${R}" stroke="#EDF1F5" stroke-width="20" fill="none"></circle>
          ${segs}
          <text class="donut-center" x="74" y="70">Total</text>
          <text class="donut-center" x="74" y="88" style="font-size:14px;fill:var(--ink);font-weight:800">${U.money(total)}</text>
        </svg>
        <div class="legend">${entries.map(function (e) {
          return html`<div class="legend-row"><span class="legend-dot" style="background:${PAY_COLORS[e.k] || '#94A3B8'}"></span>
            <span class="lg-name">${PAY_LABEL[e.k] || e.k}</span>
            <span class="lg-val">${U.money(e.v)}</span><span class="lg-pct">${U.pct(e.v, total)}%</span></div>`;
        })}</div></div>`;
    },
    hbar: function (label, val, max, valTxt) {
      return html`<div class="hbar"><div class="hbar-top"><span>${label}</span><b>${valTxt}</b></div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${U.clamp(Math.round((val / (max || 1)) * 100), 2, 100)}%"></div></div></div>`;
    },
    receipt: function (sale) {
      var t = Store.state.tenant, cfg = Store.state.config;
      /* NOTA: aqui retornamos STRING pura (não raw()) — o map().join() abaixo
         concatenaria objetos raw como "[object Object]". Conteúdo já escapado. */
      var linhas = sale.itens.map(function (it) {
        return '<tr><td class="r-item-name">' + U.num(it.qtd) + ' ' + U.esc(it.un) + ' × ' + U.esc(it.nome) + '</td><td style="text-align:right"><b>' + U.money(it.subtotal) + '</b></td></tr>';
      }).join('');
      var pays = sale.pagamentos.map(function (p) {
        return '<tr><td class="r-muted">' + U.esc((PAY_LABEL[p.forma] || p.forma).toUpperCase()) + '</td><td style="text-align:right">' + U.money(p.valor) + '</td></tr>';
      }).join('') + (sale.troco > 0 ? '<tr><td class="r-muted">TROCO</td><td style="text-align:right">' + U.money(sale.troco) + '</td></tr>' : '');
      return raw(
        '<div class="receipt" id="print-area">' +
        '<div class="r-ctr"><b style="font-size:.85rem">' + U.esc(t.nome.toUpperCase()) + '</b><br>' +
        (t.endereco ? '<span class="r-muted">' + U.esc(t.endereco) + '</span><br>' : '') +
        (t.telefone ? '<span class="r-muted">' + U.esc(t.telefone) + '</span>' : '') + '</div>' +
        '<div class="r-sep"></div>' +
        '<div class="r-ctr">' + U.esc(sale.numero) + '<br>' + U.dt(sale.at) + '<br>Operador: ' + U.esc(sale.userName) + '</div>' +
        '<div class="r-sep"></div><table>' + linhas + '</table>' +
        '<div class="r-sep"></div><table>' +
        '<tr><td class="r-muted">Subtotal</td><td style="text-align:right">' + U.money(sale.subtotal) + '</td></tr>' +
        (sale.desconto > 0 ? '<tr><td class="r-muted">Desconto</td><td style="text-align:right">− ' + U.money(sale.desconto) + '</td></tr>' : '') +
        '<tr><td class="r-big">TOTAL</td><td style="text-align:right" class="r-big">' + U.money(sale.total) + '</td></tr>' +
        '</table><div class="r-sep"></div><table>' + pays + '</table>' +
        '<div class="r-sep"></div><div class="r-ctr r-muted">COMPROVANTE NÃO FISCAL<br>' + U.esc(cfg.reciboMsg || '') + '</div></div>'
      );
    },
    receiptModal: function (sale) {
      UI.modal({
        title: false, dismissable: true,
        body: html`<div class="sale-success"><div class="success-ico">${raw(I('check', 30))}</div>
          <h3>Venda ${sale.numero} concluída</h3>
          <p class="ss-sub">${U.money(sale.total)} · ${sale.itens.length} itens · ${U.dt(sale.at)}</p></div>
          ${C.receipt(sale)}`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Fechar</button>' +
          '<button type="button" class="btn btn-primary" data-print>' + I('printer', 16) + ' Imprimir comprovante</button>'),
        onMount: function (panel) {
          panel.querySelector('[data-print]').addEventListener('click', function () { window.print(); });
        }
      });
    },
    periodSelect: function (id, sel) {
      var opts = [[1, 'Hoje'], [7, 'Últimos 7 dias'], [30, 'Últimos 30 dias'], [90, 'Últimos 90 dias']];
      return raw('<select class="select" id="' + id + '" aria-label="Período">' + opts.map(function (o) {
        return '<option value="' + o[0] + '"' + (Number(sel) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select>');
    }
  };
  window.C = C;

  /* =================== DASHBOARD =================== */
  Pages.dashboard = {
    title: 'Dashboard',
    render: function () { return C.skeleton('kpis'); },
    mounted: function (root) {
      var self = this;
      this._t = setTimeout(function () { self.fill(root); }, Config.latency ? 200 : 0);
    },
    unmount: function () { clearTimeout(this._t); },
    fill: function (root) {
      if (Config.simulateFailures) { mount(root, C.errorPanel(ApiError('NETWORK', 'Falha de conexão simulada ao carregar o dashboard.'))); return; }
      try {
        var s = Store.state;
        var sum1 = Reports.summary(1), sum30 = Reports.summary(30);
        var days = Reports.byDay(7);
        var low = Inventory.belowMin();
        var top = Reports.topProducts(30, 5);
        var recent = Sales.list({ days: 7 }).slice(0, 6);
        var user = Auth.me();

        mount(root, html`${C.pageHead('Visão geral', raw(U.esc(s.tenant.nome) + ' · ' + U.date(Date.now()) + (user ? ' · <b>' + U.esc(user.nome.split(' ')[0]) + '</b>' : '')), raw('<a class="btn btn-primary" href="#/app/pdv">' + I('cart', 16) + ' Nova venda</a>'))}
        <div class="kpi-grid">
          ${C.kpi({ lbl: 'Vendido hoje', val: U.money(sum1.total), sub: sum1.count + ' vendas até agora', icon: 'dollar', tone: '' })}
          ${C.kpi({ lbl: 'Faturamento 30d', val: U.money(sum30.total), sub: sum30.count + ' vendas · ticket ' + U.money(sum30.avg), icon: 'trending', tone: 'ok' })}
          ${C.kpi({ lbl: 'Produtos ativos', val: String(s.products.filter(function (p) { return p.ativo; }).length), sub: U.money(Inventory.valuation()) + ' em estoque (custo)', icon: 'package', tone: 'info' })}
          ${C.kpi({ lbl: 'Abaixo do mínimo', val: String(low.length), sub: low.length ? 'repor com urgência' : 'tudo em ordem 🎉', icon: 'alert', tone: low.length ? 'danger' : 'ok' })}
        </div>
        <div class="grid-2w">
          ${C.panel('Faturamento — últimos 7 dias', 'por dia corrido', C.bars(days))}
          ${C.panel('Reposição urgente', low.length + ' produtos abaixo do mínimo', low.length
            ? html`<ul class="mini-list">${low.slice(0, 6).map(function (p) {
              return html`<li class="mini-row is-clickable" data-goto-prod="${p.id}">
                <span class="mr-main"><span class="mr-name">${p.nome}</span><span class="mr-sub">${p.estoque} ${p.un} disponível · mín. ${p.min}</span></span>
                <span class="badge badge-danger">repor</span></li>`;
            })}</ul>`
            : C.empty('check-circle', 'Estoque saudável', 'Nenhum produto abaixo do mínimo.'))}
        </div>
        <div class="grid-2e">
          ${C.panel('Últimas vendas', null, recent.length
            ? html`<ul class="mini-list">${recent.map(function (v) {
              return html`<li class="mini-row is-clickable" data-goto-sale="${v.id}">
                <span class="mr-main"><span class="mr-name mono" style="font-size:.78rem">${v.numero}</span>
                <span class="mr-sub">${U.dt(v.at).split(' ')[0] + ' ' + U.dt(v.at).split(' ')[1]} · ${v.userName.split(' ')[0]}${v.status === 'cancelada' ? ' · <b class="text-danger">cancelada</b>' : ''}</span></span>
                <b class="tabular ${v.status === 'cancelada' ? 'muted' : ''}">${v.status === 'cancelada' ? '—' : U.money(v.total)}</b></li>`;
            })}</ul>`
            : C.empty('receipt', 'Nenhuma venda ainda', 'Registre a primeira venda no PDV.', raw('<a class="btn btn-primary" href="#/app/pdv">Abrir PDV</a>')))}
          ${C.panel('Mais vendidos — 30 dias', 'por quantidade', top.length
            ? html`<ul class="mini-list">${top.map(function (t, i) {
              return html`<li class="mini-row"><span class="mr-main"><span class="mr-name">${i + 1}. ${t.nome}</span><span class="mr-sub">${U.money(t.f)} faturados</span></span><b class="tabular">${U.num(t.q)}</b></li>`;
            })}</ul>`
            : C.empty('reports', 'Sem dados', 'As vendas dos últimos 30 dias aparecem aqui.'))}
        </div>`);

        root.querySelectorAll('[data-goto-sale]').forEach(function (el) {
          el.addEventListener('click', function () { Router.go('/app/vendas?s=' + el.dataset.gotoSale); });
        });
        root.querySelectorAll('[data-goto-prod]').forEach(function (el) {
          el.addEventListener('click', function () { Router.go('/app/estoque?p=' + el.dataset.gotoProd); });
        });
      } catch (e) { console.error(e); mount(root, C.errorPanel(e)); }
    },
    onStoreChanged: function () { if (Router.current && Router.current.path === '/app/dashboard') this.fill(document.getElementById('page-root')); }
  };

  /* =================== PDV =================== */
  var PDV = {
    title: 'PDV — Vender',
    st: null,
    freshState: function () {
      return { cart: [], disc: { tipo: 'R$', valor: 0 }, pays: { pix: 0, debito: 0, credito: 0, dinheiro: 0 }, ac: [], acSel: -1, discApproved: false };
    },
    render: function () {
      this.st = this.st || this.freshState();
      var info = Billing.statusInfo();
      if (info.status === 'read_only') {
        var fimDeTrial = !Store.state.tenant.planId;
        return html`<div class="pdv-lock">
          <div class="lock-ico">${raw(I('lock', 30))}</div>
          <h2>PDV bloqueado</h2>
          <p>${fimDeTrial
            ? 'Seu teste grátis de 14 dias terminou. Para voltar a vender, ative um dos planos — após pagar via Pix, você pode pedir a ativação pelo Suporte e a equipe JR libera em minutos.'
            : 'Sua assinatura está suspensa. Você ainda pode consultar relatórios e exportar seus dados (LGPD). Reative para voltar a vender em segundos.'}</p>
          <div class="flex gap-2" style="justify-content:center;flex-wrap:wrap">
            <a class="btn btn-primary btn-lg" href="#/app/assinatura">${raw(I('billing', 17))} Ver planos e ativar</a>
            <a class="btn btn-lg" href="#/app/suporte?novoticket=1&amp;categoria=faturamento&amp;assunto=Ativa%C3%A7%C3%A3o%20de%20plano">${raw(I('headset', 17))} Pedir ativação</a>
          </div>
        </div>`;
      }
      return html`
      ${info.status === 'past_due' ? html`<div class="sub-status warn mb-4" style="margin-bottom:14px">
        <span class="ss-ico">${raw(I('alert', 20))}</span>
        <span class="ss-body"><h3>Pagamento pendente</h3><p>Regularize até ${U.date(info.nextCharge || Date.now() + 3 * 864e5)} para evitar o bloqueio do PDV.</p></span>
        <span class="ss-act"><a class="btn btn-primary btn-sm" href="#/app/assinatura">Regularizar</a></span></div>` : ''}
      <div class="pdv-grid">
        <div>
          <div class="card pdv-scan">
            <form class="scan-row" id="pdv-form" role="search" aria-label="Adicionar produto à venda">
              <span class="scan-input-wrap">
                ${raw(I('barcode', 20))}
                <input class="input scan-input" id="pdv-code" type="text" autocomplete="off"
                  placeholder="Bipe ou digite o produto…"
                  aria-label="Código de barras ou nome do produto"
                  role="combobox" aria-expanded="false" aria-controls="pdv-ac" aria-autocomplete="list">
              </span>
              <button class="btn btn-dark" type="submit" style="height:50px">${raw(I('plus', 17))} Adicionar</button>
              <div class="autocomplete hidden" id="pdv-ac" role="listbox" aria-label="Sugestões de produtos"></div>
            </form>
            <div class="scan-hint">
              <span><span class="kbd">F2</span> foco no campo</span>
              <span><span class="kbd">Enter</span> adiciona</span>
              <span><span class="kbd">F4</span> finaliza</span>
              <span><span class="kbd">↑↓</span> navega nas sugestões</span>
            </div>
          </div>
          <div class="card cart-wrap" style="padding:0">
            <table class="table cart-table">
              <thead><tr><th style="min-width:180px">Produto</th><th>Qtd</th><th class="num">Unid.</th><th class="num">Subtotal</th><th style="width:44px"></th></tr></thead>
              <tbody id="cart-rows"></tbody>
            </table>
            <div id="cart-empty"></div>
          </div>
        </div>
        <aside class="pay-panel" aria-label="Pagamento e totais">
          <h3>${raw(I('billing', 16))} Pagamento</h3>
          <div class="pay-rows">
            <div class="prow"><span>Subtotal</span><b id="t-sub">R$ 0,00</b></div>
            <div class="disc-row">
              <select class="select" id="disc-tipo" aria-label="Tipo de desconto"><option value="R$">R$</option><option value="%">%</option></select>
              <input class="input" id="disc-val" type="text" inputmode="decimal" value="0" aria-label="Valor do desconto">
              <span class="disc-lbl">desconto</span>
            </div>
            <div class="prow total"><span>TOTAL</span><b id="t-total">R$ 0,00</b></div>
          </div>
          <div class="pay-quick" id="pay-quick">
            <button type="button" data-pay="pix">Pix total</button>
            <button type="button" data-pay="debito">Débito total</button>
            <button type="button" data-pay="credito">Crédito total</button>
            <button type="button" data-pay="dinheiro">Dinheiro total</button>
          </div>
          <div class="pay-methods">
            ${['pix', 'credito', 'debito', 'dinheiro'].map(function (f) {
              return html`<div class="pay-cell"><label for="pay-${f}">${f === 'pix' ? raw(I('pix', 12)) : raw(I('billing', 12))} ${PAY_LABEL[f]}</label>
                <input id="pay-${f}" type="text" inputmode="decimal" value="0" data-payf="${f}" aria-label="Valor pago em ${PAY_LABEL[f]}"></div>`;
            })}
          </div>
          <div class="troco-line hidden" id="troco-line"><span>Troco (dinheiro)</span><b id="troco-val">R$ 0,00</b></div>
          <div class="pay-error-line hidden" id="pay-error"></div>
          <button class="btn btn-primary btn-finalize" id="btn-fin" type="button" disabled>${raw(I('check-circle', 18))} Finalizar venda <span class="kbd" style="background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.25);color:#fff;margin-left:4px">F4</span></button>
          <p class="pay-foot-hint">A baixa de estoque é automática e o comprovante sai na hora.</p>
        </aside>
      </div>
      <div class="pdv-mobile-bar">
        <span class="pmb-total">Total<b id="t-total-m">R$ 0,00</b></span>
        <button class="btn btn-primary" id="btn-fin-m" type="button" disabled>Finalizar ${raw(I('arrow-right', 15))}</button>
      </div>`;
    },
    mounted: function (root) {
      var self = this;
      this.root = root;
      this.el = {
        form: root.querySelector('#pdv-form'), code: root.querySelector('#pdv-code'), ac: root.querySelector('#pdv-ac'),
        rows: root.querySelector('#cart-rows'), emptyBox: root.querySelector('#cart-empty'),
        sub: root.querySelector('#t-sub'), total: root.querySelector('#t-total'), totalM: root.querySelector('#t-total-m'),
        discTipo: root.querySelector('#disc-tipo'), discVal: root.querySelector('#disc-val'),
        troco: root.querySelector('#troco-line'), trocoVal: root.querySelector('#troco-val'),
        err: root.querySelector('#pay-error'), fin: root.querySelector('#btn-fin'), finM: root.querySelector('#btn-fin-m'),
        pays: {}
      };
      ['pix', 'credito', 'debito', 'dinheiro'].forEach(function (f) { self.el.pays[f] = root.querySelector('#pay-' + f); });
      if (!this.el.form) return; // tela bloqueada

      this.el.form.addEventListener('submit', function (e) { e.preventDefault(); self.addByQuery(self.el.code.value); });
      this.el.code.addEventListener('input', function () { self.onType(self.el.code.value); });
      this.el.code.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' && self.st.ac.length) { e.preventDefault(); self.moveAc(1); }
        else if (e.key === 'ArrowUp' && self.st.ac.length) { e.preventDefault(); self.moveAc(-1); }
        else if (e.key === 'Enter') {
          if (self.st.acSel > -1 && self.st.ac[self.st.acSel]) { e.preventDefault(); self.addProduct(self.st.ac[self.st.acSel]); }
          else if (self.st.ac.length === 1) { e.preventDefault(); self.addProduct(self.st.ac[0]); }
        } else if (e.key === 'Escape') { self.closeAc(); }
      });
      this.el.code.addEventListener('focus', function () { if (self.el.code.value) self.onType(self.el.code.value); });
      document.addEventListener('click', function (e) { if (!e.target.closest || !e.target.closest('.pdv-scan')) self.closeAc(); });

      this.el.rows.addEventListener('click', function (e) {
        var b = e.target.closest('[data-q]');
        if (!b) return;
        var i = Number(b.dataset.i), d = b.dataset.q;
        if (d === 'del') { self.st.cart.splice(i, 1); self.renderCart(); }
        else { var it = self.st.cart[i]; it.qtd = U.round2((it.qtd + (d === 'inc' ? 1 : -1)) * 1000) / 1000; if (it.qtd <= 0) self.st.cart.splice(i, 1); self.renderCart(); }
      });
      this.el.rows.addEventListener('change', function (e) {
        var inp = e.target.closest('.qty-in');
        if (!inp) return;
        var i = Number(inp.dataset.i), v = U.parseNum(inp.value);
        if (!isFinite(v) || v <= 0) self.st.cart.splice(i, 1); else self.st.cart[i].qtd = Math.round(v * 1000) / 1000;
        self.renderCart();
      });
      root.querySelector('#pay-quick').addEventListener('click', function (e) {
        var b = e.target.closest('[data-pay]');
        if (!b) return;
        self.payAll(b.dataset.pay);
      });
      Object.keys(this.el.pays).forEach(function (f) {
        self.el.pays[f].addEventListener('input', function () { self.st.pays[f] = Math.max(0, U.parseNum(self.el.pays[f].value) || 0); self.updateTotals(); });
      });
      this.el.discTipo.addEventListener('change', function () { self.st.disc.tipo = self.el.discTipo.value; self.updateTotals(); });
      this.el.discVal.addEventListener('input', function () { self.st.disc.valor = Math.max(0, U.parseNum(self.el.discVal.value) || 0); self.updateTotals(); });
      this.el.fin.addEventListener('click', function () { self.finalize(this); });
      if (this.el.finM) this.el.finM.addEventListener('click', function () { self.finalize(self.el.fin); });

      this.renderCart();
      setTimeout(function () { try { self.el.code.focus(); } catch (e) { } }, 80);
    },
    hotkey: function (e) {
      if (!this.el || !this.el.code) return;
      if (e.key === 'F2') { e.preventDefault(); this.el.code.focus(); this.el.code.select(); }
      if (e.key === 'F4') { e.preventDefault(); this.finalize(this.el.fin); }
    },
    onType: function (q) {
      q = String(q || '').trim();
      if (q.length < 2) { this.closeAc(); return; }
      this.st.ac = Catalog.search(q, 7);
      this.st.acSel = -1;
      this.renderAc(q);
    },
    renderAc: function (q) {
      var self = this, box = this.el.ac;
      if (!this.st.ac.length) { this.closeAc(); return; }
      var low = String(q).toLowerCase();
      box.innerHTML = this.st.ac.map(function (p, i) {
        var nome = U.esc(p.nome).replace(new RegExp('(' + low.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<em>$1</em>');
        return '<button type="button" class="ac-item' + (i === self.st.acSel ? ' sel' : '') + '" role="option" aria-selected="' + (i === self.st.acSel) + '" data-aci="' + i + '">' +
          '<span class="ac-name">' + nome + '</span>' +
          '<span class="ac-meta">' + U.esc(p.codigo) + ' · ' + U.money(p.preco) + ' · ' + U.num(p.estoque) + ' ' + U.esc(p.un) + '</span></button>';
      }).join('');
      box.classList.remove('hidden');
      this.el.code.setAttribute('aria-expanded', 'true');
      box.querySelectorAll('[data-aci]').forEach(function (b) {
        b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // mantém foco no campo
        b.addEventListener('click', function (e) { e.preventDefault(); self.addProduct(self.st.ac[Number(b.dataset.aci)]); });
      });
    },
    moveAc: function (dir) {
      var n = this.st.ac.length;
      this.st.acSel = (this.st.acSel + dir + n) % n;
      this.renderAc(this.el.code.value);
    },
    closeAc: function () {
      this.st.ac = []; this.st.acSel = -1;
      if (this.el && this.el.ac) { this.el.ac.classList.add('hidden'); this.el.ac.innerHTML = ''; this.el.code.setAttribute('aria-expanded', 'false'); }
    },
    addByQuery: function (q) {
      q = String(q || '').trim();
      if (!q) return;
      var p = Catalog.byCodeOrName(q);
      if (!p) { UI.toast('Produto não encontrado: “' + q + '”', { type: 'err' }); return; }
      this.addProduct(p);
    },
    addProduct: function (p) {
      var inCart = this.st.cart.filter(function (it) { return it.productId === p.id; })[0];
      if (inCart) inCart.qtd = U.round2((inCart.qtd + 1) * 1000) / 1000;
      else this.st.cart.push({ productId: p.id, nome: p.nome, un: p.un, preco: p.preco, qtd: 1 });
      this.el.code.value = '';
      this.closeAc();
      this.renderCart();
      if (p.estoque <= p.min) UI.toast('Atenção: ' + p.nome + ' está no estoque mínimo (' + U.num(p.estoque) + ' ' + p.un + ').', { type: 'warn' });
      try { this.el.code.focus(); } catch (e) { }
    },
    renderCart: function () {
      this.el.rows.innerHTML = frag(this.st.cart.map(function (it, i) {
        var p = Catalog.get(it.productId);
        var low = p && p.estoque <= p.min;
        var over = p && it.qtd > p.estoque && !Store.state.config.permiteEstoqueNegativo;
        return html`<tr class="${over ? 'row-danger' : ''}">
          <td><span class="ct-name">${it.nome}</span>${low ? raw('<span class="low-tag">' + I('alert', 10) + ' estoque baixo</span>') : ''}${over ? raw('<span class="low-tag" style="color:var(--danger);background:var(--danger-bg);border-color:var(--danger-line)">só há ' + U.num(p.estoque) + ' ' + U.esc(p.un) + '</span>') : ''}<br><span class="ct-un">${p ? p.codigo : ''}</span></td>
          <td><span class="qty-box"><button type="button" data-q="dec" data-i="${i}" aria-label="Diminuir quantidade">−</button><input class="qty-in" type="text" inputmode="decimal" value="${U.num(it.qtd)}" data-i="${i}" aria-label="Quantidade de ${it.nome}"><button type="button" data-q="inc" data-i="${i}" aria-label="Aumentar quantidade">+</button></span></td>
          <td class="num muted">${it.un}</td>
          <td class="num"><b class="tabular">${U.money(it.preco * it.qtd)}</b><br><span class="ct-un">${U.money(it.preco)} un.</span></td>
          <td><button type="button" class="btn-icon sm on-danger" data-q="del" data-i="${i}" aria-label="Remover ${it.nome}">${raw(I('trash', 15))}</button></td>
        </tr>`;
      }));
      if (!this.st.cart.length) {
        this.el.rows.innerHTML = '';
        mount(this.el.emptyBox, C.empty('barcode', 'Carrinho vazio', 'Bipe um código de barras ou busque pelo nome para começar a venda.', raw('<p class="small muted">Dica: experimente digitar <b>cimento</b> ou bipar <span class="kbd mono">7891000001011</span></p>')));
      } else this.el.emptyBox.innerHTML = '';
      this.updateTotals();
    },
    calc: function () {
      var subtotal = U.round2(U.sum(this.st.cart, function (it) { return it.preco * it.qtd; }));
      var discVal = U.round2(this.st.disc.tipo === '%' ? subtotal * (this.st.disc.valor || 0) / 100 : (this.st.disc.valor || 0));
      discVal = U.clamp(discVal, 0, subtotal);
      var total = U.round2(subtotal - discVal);
      var pago = U.round2(U.sum(Object.keys(this.st.pays), function (f) { return this.st.pays[f]; }.bind(this)));
      var dinheiro = this.st.pays.dinheiro || 0;
      var outros = U.round2(pago - dinheiro);
      var troco = Math.max(0, U.round2(dinheiro - Math.max(0, total - outros)));
      var diff = U.round2(pago - total);
      var user = Auth.me();
      var discPct = subtotal > 0 ? (discVal / subtotal) * 100 : 0;
      var lim = Store.state.config.descontoCaixaPct;
      var discBlocked = !!(user && user.papel === 'caixa' && discPct > lim + 0.001 && !this.st.discApproved);
      return {
        subtotal: subtotal, discVal: discVal, total: total, pago: pago, troco: troco, diff: diff,
        discPct: discPct, discLimit: lim, discBlocked: discBlocked,
        ok: this.st.cart.length > 0 && Math.abs(diff) <= 0.011 && !discBlocked
      };
    },
    updateTotals: function () {
      var c = this.calc(), el = this.el;
      el.sub.textContent = U.money(c.subtotal);
      el.total.textContent = U.money(c.total);
      if (el.totalM) el.totalM.textContent = U.money(c.total);
      el.troco.classList.toggle('hidden', !(c.troco > 0.009));
      el.trocoVal.textContent = U.money(c.troco);
      var errs = [];
      if (c.discBlocked) errs.push('Desconto de ' + c.discPct.toFixed(1).replace('.', ',') + '% excede o limite do caixa (' + c.discLimit + '%).');
      else if (this.st.cart.length && Math.abs(c.diff) > 0.011) errs.push(c.diff < 0 ? 'Faltam ' + U.money(-c.diff) + ' para fechar o total.' : 'Pagamento excede o total em ' + U.money(c.diff) + '.');
      if (errs.length) {
        el.err.innerHTML = I('alert', 14) + '<span>' + U.esc(errs[0]) + (c.discBlocked ? ' <button type="button" class="btn btn-sm btn-danger-ghost" id="btn-approve" style="margin-left:6px">Pedir autorização</button>' : '') + '</span>';
        el.err.classList.remove('hidden');
        var ab = el.err.querySelector('#btn-approve');
        if (ab) { var self = this; ab.addEventListener('click', function () { self.approveDiscount(); }); }
      } else el.err.classList.add('hidden');
      el.fin.disabled = !c.ok;
      if (el.finM) el.finM.disabled = !c.ok;
    },
    payAll: function (forma) {
      var c = this.calc(), self = this;
      Object.keys(this.st.pays).forEach(function (f) { self.st.pays[f] = f === forma ? c.total : 0; self.el.pays[f].value = f === forma ? c.total.toFixed(2) : '0'; });
      this.updateTotals();
    },
    approveDiscount: function () {
      var self = this;
      var chefes = Store.state.users.filter(function (u) { return u.ativo && (u.papel === 'admin' || u.papel === 'gerente'); });
      UI.modal({
        title: 'Autorização de desconto', sub: 'Um gerente ou administrador deve autorizar.',
        body: html`<div class="field"><label for="ap-user">Responsável</label>
          <select class="select" id="ap-user">${chefes.map(function (u) { return html`<option value="${u.id}">${u.nome} — ${u.papel}</option>`; })}</select></div>
          <div class="field"><label for="ap-pass">Senha do responsável</label>
          <input class="input" id="ap-pass" type="password" autocomplete="off" placeholder="Senha (demo: demo123)"></div>
          <p class="field-hint">O desconto liberado valerá apenas para esta venda.</p>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button><button type="button" class="btn btn-primary" data-ok>Autorizar</button>'),
        onMount: function (panel, close) {
          panel.querySelector('[data-ok]').addEventListener('click', function () {
            var uid = panel.querySelector('#ap-user').value, pw = panel.querySelector('#ap-pass').value;
            var u = chefes.filter(function (x) { return x.id === uid; })[0];
            if (u && AuthService.verifyPassword(u.id, pw)) { self.st.discApproved = true; close('ok'); self.updateTotals(); UI.toast('Desconto autorizado por ' + u.nome + ' ✔', { type: 'ok' }); }
            else UI.toast('Senha incorreta. Autorização negada.', { type: 'err' });
          });
        }
      });
    },
    finalize: function (btn) {
      var self = this, c = this.calc();
      if (!this.st.cart.length) { UI.toast('Adicione produtos ao carrinho.', { type: 'warn' }); return; }
      if (!c.ok) { this.updateTotals(); UI.toast('Revise desconto e pagamentos para finalizar.', { type: 'warn' }); return; }
      /* v13 · id de idempotência: gerado UMA vez por ciclo do carrinho e
         reenviado em todas as tentativas da mesma venda — duplo clique ou
         retry de rede nunca grava duas vendas (o banco devolve a primeira). */
      if (!this.st.idem) this.st.idem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      var pays = Object.keys(this.st.pays).filter(function (f) { return self.st.pays[f] > 0.009; }).map(function (f) { return { forma: f, valor: self.st.pays[f] }; });
      UI.modal({
        title: 'Confirmar venda', sub: 'Confira os itens antes de gravar — a baixa no estoque é imediata.',
        body: html`<ul class="mini-list">${this.st.cart.map(function (it) {
          return html`<li class="mini-row"><span class="mr-main"><span class="mr-name">${U.num(it.qtd)} ${it.un} × ${it.nome}</span></span><b class="tabular">${U.money(it.preco * it.qtd)}</b></li>`;
        })}</ul>
        <hr class="divider">
        <ul class="mini-list">
          <li class="mini-row"><span>Subtotal</span><b class="tabular">${U.money(c.subtotal)}</b></li>
          ${c.discVal > 0 ? html`<li class="mini-row"><span>Desconto (${this.st.disc.tipo === '%' ? U.num(this.st.disc.valor) + '%' : U.money(this.st.disc.valor)})</span><b class="tabular text-ok">− ${U.money(c.discVal)}</b></li>` : ''}
          <li class="mini-row" style="font-size:1.05rem"><span><b>Total</b></span><b class="tabular">${U.money(c.total)}</b></li>
          <li class="mini-row"><span>Pagamento</span><span>${C.payBadges(pays)}</span></li>
          ${c.troco > 0 ? html`<li class="mini-row"><span>Troco</span><b class="tabular text-ok">${U.money(c.troco)}</b></li>` : ''}
        </ul>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Voltar (Esc)</button><button type="button" class="btn btn-primary" data-ok>' + I('check', 16) + ' Confirmar e gravar</button>'),
        onMount: function (panel, close) {
          panel.querySelector('[data-ok]').addEventListener('click', function () {
            var okBtn = this;
            UI.busy(okBtn, true);
            Sales.commit({ items: self.st.cart, discount: { tipo: self.st.disc.tipo, valor: self.st.disc.valor }, payments: pays, idempotencyId: self.st.idem })
              .then(function (sale) {
                UI.busy(okBtn, false); close('ok');
                self.st = self.freshState();
                self.renderCart();
                ['pix', 'credito', 'debito', 'dinheiro'].forEach(function (f) { self.el.pays[f].value = '0'; });
                self.el.discVal.value = '0'; self.el.discTipo.value = 'R$';
                C.receiptModal(sale);
                UI.toast('Venda ' + sale.numero + ' registrada: ' + U.money(sale.total), { type: 'ok' });
                try { self.el.code.focus(); } catch (e) { }
              })
              .catch(function (err) {
                UI.busy(okBtn, false);
                UI.toast(err.message || 'Falha ao registrar venda.', { type: 'err', title: err.code === 'NETWORK' ? 'Sem conexão' : 'Não foi possível vender' });
                if (err.code !== 'NETWORK') { close('err'); self.updateTotals(); }
              });
          });
        }
      });
    },
    unmount: function () { }
  };
  Pages.pdv = PDV;

  /* =================== VENDAS =================== */
  Pages.vendas = {
    title: 'Vendas',
    filter: { days: 7 },
    render: function () { return C.skeleton('table'); },
    mounted: function (root, params, query) {
      var self = this;
      this.rerender = function () { self.fill(document.getElementById('page-root')); };
      setTimeout(function () { self.fill(root); if (query && query.s) { var s = Sales.get(query.s); if (s) self.detail(s); } }, Config.latency ? 180 : 0);
    },
    fill: function (root) {
      var self = this;
      var list = Sales.list({ days: this.filter.days });
      var tot = U.round2(U.sum(list.filter(function (s) { return s.status === 'concluida'; }), function (s) { return s.total; }));
      mount(root, html`
        ${C.pageHead('Histórico de vendas', list.length + ' vendas · ' + U.money(tot) + ' no período', raw(
          '<button type="button" class="btn" data-act="exp-vendas">' + I('download', 15) + ' Exportar CSV</button>' +
          '<a class="btn btn-primary" href="#/app/pdv">' + I('cart', 15) + ' Nova venda</a>'))}
        <div class="toolbar">
          ${C.periodSelect('v-period', this.filter.days)}
          <span class="muted small">Clique em uma venda para ver detalhes, reimprimir ou cancelar.</span>
        </div>
        ${list.length ? html`<div class="table-wrap"><table class="table" style="min-width:760px">
          <thead><tr><th>Nº</th><th>Data/hora</th><th>Operador</th><th class="num">Itens</th><th>Pagamento</th><th class="num">Total</th><th>Status</th><th style="width:70px"></th></tr></thead>
          <tbody>${list.map(function (s) {
            return html`<tr class="is-clickable ${s.status === 'cancelada' ? 'row-off' : ''}" data-sale="${s.id}">
              <td class="mono strong nowrap">${s.numero}</td><td class="muted nowrap">${U.dt(s.at)}</td><td>${s.userName}</td>
              <td class="num">${s.itens.length}</td><td>${C.payBadges(s.pagamentos)}</td>
              <td class="num"><b class="tabular">${U.money(s.total)}</b></td>
              <td>${s.status === 'concluida' ? raw('<span class="badge badge-ok">concluída</span>') : raw('<span class="badge badge-danger">cancelada</span>')}</td>
              <td class="right"><button type="button" class="btn btn-sm btn-ghost" data-sale="${s.id}" aria-label="Ver venda ${s.numero}">Ver</button></td></tr>`;
          })}</tbody></table></div>`
        : C.empty('receipt', 'Nenhuma venda no período', 'Ajuste o filtro ou registre uma nova venda no PDV.', raw('<a class="btn btn-primary" href="#/app/pdv">Abrir PDV</a>'))}`);

      root.querySelector('#v-period').addEventListener('change', function () { self.filter.days = Number(this.value); self.fill(root); });
      root.querySelectorAll('[data-sale]').forEach(function (el) {
        el.addEventListener('click', function () { var s = Sales.get(el.dataset.sale); if (s) self.detail(s); });
      });
      var exp = root.querySelector('[data-act="exp-vendas"]');
      if (exp) exp.addEventListener('click', function () {
        if (DataOps.exportCSV('vendas')) UI.toast('vendas.csv exportado ✔', { type: 'ok' });
      });
    },
    detail: function (s) {
      var self = this;
      var canCancel = Perms.can('sales.cancel') && s.status === 'concluida';
      UI.modal({
        title: s.numero, sub: U.dt(s.at) + ' · Operador: ' + s.userName + (s.status === 'cancelada' ? ' · CANCELADA (' + U.esc(s.motivoCancelamento || '') + ')' : ''),
        body: html`<ul class="mini-list">${s.itens.map(function (it) {
          return html`<li class="mini-row"><span class="mr-main"><span class="mr-name">${U.num(it.qtd)} ${it.un} × ${it.nome}</span><span class="mr-sub">${U.money(it.preco)} un.</span></span><b class="tabular">${U.money(it.subtotal)}</b></li>`;
        })}</ul><hr class="divider">
        <ul class="mini-list">
          <li class="mini-row"><span>Subtotal</span><b class="tabular">${U.money(s.subtotal)}</b></li>
          ${s.desconto > 0 ? html`<li class="mini-row"><span>Desconto</span><b class="tabular text-ok">− ${U.money(s.desconto)}</b></li>` : ''}
          <li class="mini-row" style="font-size:1.05rem"><span><b>Total</b></span><b class="tabular">${U.money(s.total)}</b></li>
          ${s.pagamentos.map(function (p) { return html`<li class="mini-row"><span>${C.payLabel[p.forma] || p.forma}</span><b class="tabular">${U.money(p.valor)}</b></li>`; })}
          ${s.troco > 0 ? html`<li class="mini-row"><span>Troco</span><b class="tabular">${U.money(s.troco)}</b></li>` : ''}
        </ul>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Fechar</button>' +
          '<button type="button" class="btn" data-receipt>' + I('printer', 15) + ' Comprovante</button>' +
          (canCancel ? '<button type="button" class="btn btn-danger" data-cancel>' + I('x-circle', 15) + ' Cancelar venda</button>' : '')),
        onMount: function (panel, close) {
          panel.querySelector('[data-receipt]').addEventListener('click', function () { close('r'); C.receiptModal(s); });
          var cb = panel.querySelector('[data-cancel]');
          if (cb) cb.addEventListener('click', function () { close('c'); self.askCancel(s); });
        }
      });
    },
    askCancel: function (s) {
      var self = this;
      UI.modal({
        title: 'Cancelar ' + s.numero + '?', size: 'sm',
        body: html`<p class="small" style="color:var(--ink-2);line-height:1.6">O estoque dos ${s.itens.length} itens será devolvido e o cancelamento ficará registrado na trilha de auditoria. Ação exclusiva de administrador.</p>
          <div class="field mt-3"><label for="canc-mot">Motivo *</label>
          <select class="select" id="canc-mot"><option>Erro de digitação</option><option>Cliente desistiu</option><option>Pagamento não confirmado</option><option>Troca/devolução de mercadoria</option><option>Outro</option></select></div>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Voltar</button><button type="button" class="btn btn-danger" data-ok>Confirmar cancelamento</button>'),
        onMount: function (panel, close) {
          panel.querySelector('[data-ok]').addEventListener('click', function () {
            var btn = this; UI.busy(btn, true);
            Sales.cancel(s.id, panel.querySelector('#canc-mot').value)
              .then(function () { UI.busy(btn, false); close('ok'); UI.toast('Venda ' + s.numero + ' cancelada — estoque devolvido.', { type: 'warn' }); self.rerender && self.rerender(); })
              .catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err' }); });
          });
        }
      });
    },
    onStoreChanged: function () { if (Router.current && Router.current.path === '/app/vendas') this.fill(document.getElementById('page-root')); }
  };
})();
