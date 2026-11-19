/* ==========================================================================
   LojaCerta · Telas dos recursos dos planos (v2.0)
   Clientes · Orçamentos · Financeiro (pagar/receber) · Nota fiscal · Lojas
   + extensões do PDV (cliente, fiado, orçamento) e bloco fiscal da venda.
   ========================================================================== */
;(function () {
  'use strict';
  window.Pages = window.Pages || {};
  function pageRoot() { return document.getElementById('page-root'); }
  function errBox(root, e) { mount(root, C.errorPanel(e && e.code ? e : ApiError('NETWORK', (e && e.message) || 'Falha ao carregar.'))); }
  function badgeStatus(st, overdue) {
    if (st === 'pago') return raw('<span class="badge badge-ok">pago</span>');
    if (st === 'cancelado') return raw('<span class="badge badge-mut">cancelado</span>');
    if (st === 'convertido') return raw('<span class="badge badge-ok">virou venda</span>');
    if (st === 'autorizado') return raw('<span class="badge badge-ok">autorizada</span>');
    if (st === 'processando') return raw('<span class="badge badge-warn">processando</span>');
    if (st === 'erro') return raw('<span class="badge badge-danger">rejeitada</span>');
    if (overdue) return raw('<span class="badge badge-danger">vencido</span>');
    return raw('<span class="badge badge-warn">em aberto</span>');
  }
  function fmtDoc(d) {
    d = String(d || '').replace(/\D/g, '');
    if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
    if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
    return d;
  }
  function gate(root, feat, desc) {
    if (window.Plans && Plans.has(feat)) return false;
    mount(root, html`${C.pageHead(Plans.FEATURES[feat].label, 'Recurso do plano ' + Plans.planName(feat))}${Plans.upsell(feat, desc)}`);
    return true;
  }
  function money(v) { return U.money(Number(v) || 0); }

  /* =================== CLIENTES =================== */
  Pages.clientes = {
    title: 'Clientes', q: '', showOff: false,
    render: function () { return C.skeleton('table'); },
    mounted: function (root) { var self = this; this.rerender = function () { self.fill(pageRoot()); }; this.fill(root); },
    fill: function (root) {
      var self = this;
      if (gate(root, 'clientes', 'Cadastre seus clientes, venda no fiado com limite de crédito e emita NF-e com os dados completos do comprador.')) return;
      Biz.customers.list().then(function (list) {
        self.list = list;
        var q = self.q.toLowerCase();
        var rows = list.filter(function (c) { return (self.showOff || c.ativo) && (!q || (c.nome + ' ' + c.documento + ' ' + c.telefone).toLowerCase().indexOf(q) > -1); });
        var totalAberto = U.round2(U.sum(list, function (c) { return c.aberto || 0; }));
        mount(root, html`
          ${C.pageHead('Clientes', list.filter(function (c) { return c.ativo; }).length + ' ativos · ' + money(totalAberto) + ' em aberto no fiado',
            raw('<button type="button" class="btn btn-primary" data-new>' + I('plus', 15) + ' Novo cliente</button>'))}
          <div class="toolbar">
            <span class="search-box">${raw(I('search', 16))}<input class="input" id="c-q" type="search" placeholder="Buscar por nome, CPF/CNPJ ou telefone…" value="${self.q}" aria-label="Buscar cliente"></span>
            <label class="chk"><input type="checkbox" id="c-off" ${self.showOff ? raw('checked') : ''}> Incluir inativos</label>
          </div>
          ${rows.length ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th>Cliente</th><th>Contato</th><th class="num">Limite</th><th class="num">Em aberto</th><th>Status</th><th style="width:120px"></th></tr></thead>
            <tbody>${rows.map(function (c) {
              return html`<tr class="${c.ativo ? '' : 'row-off'}">
                <td><span class="strong">${c.nome}</span><br><span class="small muted mono">${fmtDoc(c.documento) || 'sem CPF/CNPJ'}</span></td>
                <td class="small">${c.telefone || '—'}${c.municipio ? html`<br><span class="muted">${c.municipio}/${c.uf}</span>` : ''}</td>
                <td class="num tabular">${c.limite > 0 ? money(c.limite) : raw('<span class="muted">sem limite</span>')}</td>
                <td class="num tabular">${c.aberto > 0 ? html`<b class="text-danger">${money(c.aberto)}</b>` : raw('<span class="muted">—</span>')}</td>
                <td>${c.ativo ? raw('<span class="badge badge-ok">ativo</span>') : raw('<span class="badge badge-mut">inativo</span>')}</td>
                <td class="right nowrap">
                  <button type="button" class="btn-icon sm" data-edit="${c.id}" title="Editar" aria-label="Editar ${c.nome}">${raw(I('edit', 15))}</button>
                  ${c.aberto > 0 && Perms.pageAllowed('financeiro') ? html`<a class="btn-icon sm" href="#/app/financeiro" title="Ver contas a receber" aria-label="Contas de ${c.nome}">${raw(I('dollar', 15))}</a>` : ''}
                  <button type="button" class="btn-icon sm on-danger" data-tog="${c.id}" title="${c.ativo ? 'Inativar' : 'Reativar'}" aria-label="${c.ativo ? 'Inativar' : 'Reativar'} ${c.nome}">${raw(I(c.ativo ? 'lock' : 'refresh', 15))}</button>
                </td></tr>`;
            })}</tbody></table></div>`
          : C.empty('users', list.length ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado', list.length ? 'Ajuste a busca.' : 'Cadastre clientes para vender no fiado, montar orçamentos e emitir NF-e.',
              raw('<button type="button" class="btn btn-primary" data-new>' + I('plus', 15) + ' Cadastrar cliente</button>'))}`);
        var qi = root.querySelector('#c-q');
        qi.addEventListener('input', U.debounce ? U.debounce(function () { self.q = qi.value; self.fill(root); }, 250) : function () { self.q = qi.value; self.fill(root); });
        root.querySelector('#c-off').addEventListener('change', function () { self.showOff = this.checked; self.fill(root); });
        root.querySelectorAll('[data-new]').forEach(function (b) { b.addEventListener('click', function () { self.form(null); }); });
        root.querySelectorAll('[data-edit]').forEach(function (b) { b.addEventListener('click', function () { self.form(self.list.filter(function (c) { return c.id === b.dataset.edit; })[0]); }); });
        root.querySelectorAll('[data-tog]').forEach(function (b) {
          b.addEventListener('click', function () {
            var c = self.list.filter(function (x) { return x.id === b.dataset.tog; })[0];
            Biz.customers.toggle(c.id, !c.ativo).then(function () { UI.toast(c.ativo ? 'Cliente inativado.' : 'Cliente reativado ✔', { type: 'ok' }); self.fill(root); })
              .catch(function (e) { UI.toast(e.message, { type: 'err' }); });
          });
        });
        try { if (document.activeElement !== qi && self.q) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); } } catch (e) { }
      }).catch(function (e) { errBox(root, e); });
    },
    form: function (c, onSaved) {
      var self = this;
      UI.modal({
        title: c ? 'Editar cliente' : 'Novo cliente', size: 'lg',
        body: html`<form id="cli-form" novalidate>
          <div class="field"><label for="cl-nome">Nome / razão social <span class="req">*</span></label><input class="input" id="cl-nome" name="nome" value="${c ? c.nome : ''}" data-autofocus></div>
          <div class="field-row-3">
            <div class="field"><label for="cl-doc">CPF ou CNPJ</label><input class="input mono" id="cl-doc" name="documento" inputmode="numeric" value="${c ? fmtDoc(c.documento) : ''}"></div>
            <div class="field"><label for="cl-ie">Inscrição estadual</label><input class="input mono" id="cl-ie" name="ie" value="${c ? c.ie : ''}" placeholder="se contribuinte"></div>
            <div class="field"><label for="cl-tel">Telefone</label><input class="input" id="cl-tel" name="telefone" inputmode="tel" value="${c ? c.telefone : ''}"></div>
          </div>
          <div class="field-row">
            <div class="field"><label for="cl-mail">E-mail</label><input class="input" id="cl-mail" name="email" type="email" value="${c ? c.email : ''}"></div>
            <div class="field"><label for="cl-lim">Limite de crédito no fiado (R$)</label><input class="input input-money" id="cl-lim" name="limite" inputmode="decimal" value="${c ? U.num(c.limite, 2) : '0'}"><span class="field-hint">0 = sem limite</span></div>
          </div>
          <div class="field-row-3">
            <div class="field" style="grid-column:span 2"><label for="cl-log">Endereço (rua/avenida)</label><input class="input" id="cl-log" name="logradouro" value="${c ? c.logradouro : ''}"></div>
            <div class="field"><label for="cl-num">Número</label><input class="input" id="cl-num" name="numero" value="${c ? c.numero : ''}"></div>
          </div>
          <div class="field-row-3">
            <div class="field"><label for="cl-bai">Bairro</label><input class="input" id="cl-bai" name="bairro" value="${c ? c.bairro : ''}"></div>
            <div class="field"><label for="cl-mun">Município</label><input class="input" id="cl-mun" name="municipio" value="${c ? c.municipio : ''}"></div>
            <div class="field-row" style="gap:8px"><div class="field"><label for="cl-uf">UF</label><input class="input" id="cl-uf" name="uf" maxlength="2" value="${c ? c.uf : ''}"></div>
              <div class="field"><label for="cl-cep">CEP</label><input class="input mono" id="cl-cep" name="cep" inputmode="numeric" maxlength="9" value="${c ? c.cep : ''}"></div></div>
          </div>
          <div class="field"><label for="cl-obs">Observações</label><input class="input" id="cl-obs" name="obs" value="${c ? c.obs : ''}"></div>
          <p class="field-hint">Endereço completo + CPF/CNPJ são exigidos apenas para emitir NF-e (nota modelo 55) para este cliente.</p>
        </form>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button><button type="button" class="btn btn-primary" data-save>' + I('save', 16) + ' Salvar cliente</button>'),
        onMount: function (panel, close) {
          var form = panel.querySelector('#cli-form');
          panel.querySelector('[data-save]').addEventListener('click', function () {
            var f = form.elements, btn = this;
            var doc = f.documento.value.replace(/\D/g, '');
            if (f.nome.value.trim().length < 2) { UI.toast('Informe o nome do cliente.', { type: 'err' }); f.nome.focus(); return; }
            if (doc && doc.length !== 11 && doc.length !== 14) { UI.toast('CPF deve ter 11 dígitos e CNPJ 14.', { type: 'err' }); f.documento.focus(); return; }
            var lim = U.parseNum(f.limite.value); if (!isFinite(lim) || lim < 0) lim = 0;
            UI.busy(btn, true);
            Biz.customers.save({ id: c ? c.id : null, nome: f.nome.value, documento: doc, ie: f.ie.value, telefone: f.telefone.value, email: f.email.value, limite: lim,
              logradouro: f.logradouro.value, numero: f.numero.value, bairro: f.bairro.value, municipio: f.municipio.value, uf: f.uf.value, cep: f.cep.value, obs: f.obs.value })
              .then(function (r) {
                UI.busy(btn, false); close('ok'); UI.toast(c ? 'Cliente atualizado ✔' : 'Cliente cadastrado ✔', { type: 'ok' });
                if (onSaved) onSaved({ id: r.id, nome: f.nome.value.trim() }); else if (self.rerender) self.rerender();
              }).catch(function (e) { UI.busy(btn, false); UI.toast(e.message || 'Erro ao salvar.', { type: 'err' }); });
          });
        }
      });
    }
  };

  /* =================== FINANCEIRO (contas a receber / a pagar) =================== */
  var FORMAS = [['pix', 'Pix'], ['dinheiro', 'Dinheiro'], ['debito', 'Débito'], ['credito', 'Crédito'], ['boleto', 'Boleto'], ['transferencia', 'Transferência']];
  var CATS_PAGAR = ['Fornecedores', 'Aluguel', 'Salários', 'Energia/Água/Internet', 'Impostos', 'Frete', 'Manutenção', 'Outros'];
  Pages.financeiro = {
    title: 'Financeiro', tab: 'receber', status: 'aberto',
    render: function () { return C.skeleton('kpis'); },
    mounted: function (root, params, query) { var self = this; if (query && query.tab) this.tab = query.tab; this.rerender = function () { self.fill(pageRoot()); }; this.fill(root); },
    fill: function (root) {
      var self = this;
      if (gate(root, 'financeiro', 'Controle o que você tem a receber (inclusive o fiado) e a pagar, com vencimentos, baixas parciais e alerta de atraso.')) return;
      Promise.all([Biz.receivables.list(), Biz.payables.list()]).then(function (d) {
        var rec = d[0] || [], pag = d[1] || [];
        var openR = rec.filter(function (r) { return r.status === 'aberto'; }), openP = pag.filter(function (r) { return r.status === 'aberto'; });
        var sum = function (l) { return U.round2(U.sum(l, Biz.saldo)); };
        var hoje = Biz.today(), em7 = Biz.addDays(hoje, 7);
        var list = (self.tab === 'pagar' ? pag : rec).filter(function (r) { return self.status === 'todos' || r.status === self.status; });
        var isAdmin = ['admin', 'dev'].indexOf((Auth.me() || {}).papel) > -1;
        mount(root, html`
          ${C.pageHead('Financeiro', 'Contas a receber e a pagar',
            raw('<button type="button" class="btn btn-primary" data-new>' + I('plus', 15) + (self.tab === 'pagar' ? ' Nova conta a pagar' : ' Nova conta a receber') + '</button>'))}
          <div class="kpi-grid">
            ${C.kpi({ lbl: 'A receber (aberto)', val: money(sum(openR)), icon: 'dollar', tone: 'ok', sub: openR.length + ' conta(s)' })}
            ${C.kpi({ lbl: 'Recebimentos vencidos', val: money(sum(openR.filter(Biz.overdue))), icon: 'alert', tone: 'danger', sub: openR.filter(Biz.overdue).length + ' em atraso' })}
            ${C.kpi({ lbl: 'A pagar (aberto)', val: money(sum(openP)), icon: 'billing', tone: 'warn', sub: openP.filter(function (r) { return r.vencimento <= em7; }).length + ' vencem em 7 dias' })}
            ${C.kpi({ lbl: 'Saldo previsto', val: money(U.round2(sum(openR) - sum(openP))), icon: 'trending', sub: 'a receber − a pagar' })}
          </div>
          <div class="toolbar mt-3">
            <div class="seg" role="tablist" aria-label="Tipo de conta">
              <button type="button" class="seg-btn ${self.tab === 'receber' ? 'is-on' : ''}" data-tab="receber">A receber</button>
              <button type="button" class="seg-btn ${self.tab === 'pagar' ? 'is-on' : ''}" data-tab="pagar">A pagar</button>
            </div>
            <select class="select" id="f-st" aria-label="Situação" style="max-width:180px">
              ${[['aberto', 'Em aberto'], ['pago', 'Pagas'], ['cancelado', 'Canceladas'], ['todos', 'Todas']].map(function (o) { return html`<option value="${o[0]}" ${self.status === o[0] ? raw('selected') : ''}>${o[1]}</option>`; })}
            </select>
          </div>
          ${list.length ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th>Vencimento</th><th>${self.tab === 'pagar' ? 'Fornecedor / descrição' : 'Cliente / descrição'}</th><th class="num">Valor</th><th class="num">Pago</th><th class="num">Saldo</th><th>Situação</th><th style="width:150px"></th></tr></thead>
            <tbody>${list.map(function (r) {
              var od = Biz.overdue(r);
              return html`<tr class="${od ? 'row-danger' : ''} ${r.status === 'cancelado' ? 'row-off' : ''}">
                <td class="nowrap ${od ? 'text-danger strong' : ''}">${Biz.fmtDate(r.vencimento)}</td>
                <td><span class="strong">${self.tab === 'pagar' ? (r.fornecedor || r.categoria) : (r.customerNome || 'Sem cliente')}</span><br><span class="small muted">${r.descricao}</span></td>
                <td class="num tabular">${money(r.valor)}</td>
                <td class="num tabular muted">${r.valorPago > 0 ? money(r.valorPago) : '—'}</td>
                <td class="num tabular"><b>${money(Biz.saldo(r))}</b></td>
                <td>${badgeStatus(r.status, od)}</td>
                <td class="right nowrap">${r.status === 'aberto' ? html`
                  <button type="button" class="btn btn-sm btn-primary" data-pay="${r.id}">${raw(I('check', 14))} ${self.tab === 'pagar' ? 'Pagar' : 'Receber'}</button>
                  ${isAdmin ? html`<button type="button" class="btn-icon sm on-danger" data-cancel="${r.id}" title="Cancelar conta" aria-label="Cancelar conta">${raw(I('x-circle', 15))}</button>` : ''}` : ''}</td></tr>`;
            })}</tbody></table></div>`
          : C.empty('dollar', 'Nenhuma conta ' + (self.status === 'aberto' ? 'em aberto' : 'neste filtro'), self.tab === 'pagar' ? 'Lance aluguel, fornecedores e despesas para nunca perder um vencimento.' : 'As vendas no fiado entram aqui automaticamente. Você também pode lançar contas manualmente.')}`);
        root.querySelectorAll('[data-tab]').forEach(function (b) { b.addEventListener('click', function () { self.tab = b.dataset.tab; self.fill(root); }); });
        root.querySelector('#f-st').addEventListener('change', function () { self.status = this.value; self.fill(root); });
        root.querySelector('[data-new]').addEventListener('click', function () { self.newForm(); });
        root.querySelectorAll('[data-pay]').forEach(function (b) { b.addEventListener('click', function () { self.payForm(list.filter(function (x) { return x.id === b.dataset.pay; })[0]); }); });
        root.querySelectorAll('[data-cancel]').forEach(function (b) {
          b.addEventListener('click', function () {
            UI.confirm({ title: 'Cancelar esta conta?', text: 'Ela deixa de contar nos totais. A ação fica registrada na auditoria.', danger: true, okText: 'Cancelar conta' }).then(function (ok) {
              if (!ok) return;
              (self.tab === 'pagar' ? Biz.payables : Biz.receivables).cancel(b.dataset.cancel).then(function () { UI.toast('Conta cancelada.', { type: 'warn' }); self.fill(root); })
                .catch(function (e) { UI.toast(e.message, { type: 'err' }); });
            });
          });
        });
      }).catch(function (e) { errBox(root, e); });
    },
    payForm: function (r) {
      var self = this, pagar = this.tab === 'pagar';
      UI.modal({
        title: (pagar ? 'Pagar: ' : 'Receber: ') + r.descricao, sub: 'Saldo em aberto ' + money(Biz.saldo(r)) + ' · vence ' + Biz.fmtDate(r.vencimento), size: 'sm',
        body: html`<div class="field"><label for="py-v">Valor ${pagar ? 'pago' : 'recebido'} (R$)</label><input class="input input-money" id="py-v" inputmode="decimal" value="${U.num(Biz.saldo(r), 2)}" data-autofocus>
            <span class="field-hint">Pode ser parcial — o restante continua em aberto.</span></div>
          <div class="field"><label for="py-f">Forma</label><select class="select" id="py-f">${FORMAS.map(function (f) { return html`<option value="${f[0]}">${f[1]}</option>`; })}</select></div>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Voltar</button><button type="button" class="btn btn-primary" data-ok>' + I('check', 15) + ' Confirmar</button>'),
        onMount: function (panel, close) {
          panel.querySelector('[data-ok]').addEventListener('click', function () {
            var v = U.parseNum(panel.querySelector('#py-v').value), btn = this;
            if (!(v > 0)) { UI.toast('Informe um valor maior que zero.', { type: 'err' }); return; }
            UI.busy(btn, true);
            (pagar ? Biz.payables : Biz.receivables).settle(r.id, v, panel.querySelector('#py-f').value).then(function () {
              UI.busy(btn, false); close('ok'); UI.toast((pagar ? 'Pagamento' : 'Recebimento') + ' de ' + money(v) + ' registrado ✔', { type: 'ok' }); self.rerender();
            }).catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err' }); });
          });
        }
      });
    },
    newForm: function () {
      var self = this, pagar = this.tab === 'pagar';
      var go = function (custs) {
        UI.modal({
          title: pagar ? 'Nova conta a pagar' : 'Nova conta a receber',
          body: html`<form id="fin-form" novalidate>
            ${pagar ? html`<div class="field-row"><div class="field"><label for="fn-forn">Fornecedor / favorecido</label><input class="input" id="fn-forn" name="fornecedor" data-autofocus></div>
              <div class="field"><label for="fn-cat">Categoria</label><select class="select" id="fn-cat" name="categoria">${CATS_PAGAR.map(function (c) { return html`<option>${c}</option>`; })}</select></div></div>`
            : html`<div class="field"><label for="fn-cli">Cliente</label><select class="select" id="fn-cli" name="customerId"><option value="">— sem cliente —</option>${custs.filter(function (c) { return c.ativo; }).map(function (c) { return html`<option value="${c.id}">${c.nome}</option>`; })}</select></div>`}
            <div class="field"><label for="fn-desc">Descrição <span class="req">*</span></label><input class="input" id="fn-desc" name="descricao" placeholder="${pagar ? 'Ex.: Compra de cimento NF 1234' : 'Ex.: Serviço de entrega'}"></div>
            <div class="field-row"><div class="field"><label for="fn-val">Valor (R$) <span class="req">*</span></label><input class="input input-money" id="fn-val" name="valor" inputmode="decimal"></div>
              <div class="field"><label for="fn-venc">Vencimento <span class="req">*</span></label><input class="input" type="date" id="fn-venc" name="vencimento" value="${Biz.addDays(Biz.today(), pagar ? 7 : 30)}"></div></div>
          </form>`,
          foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button><button type="button" class="btn btn-primary" data-save>' + I('save', 15) + ' Lançar conta</button>'),
          onMount: function (panel, close) {
            panel.querySelector('[data-save]').addEventListener('click', function () {
              var f = panel.querySelector('#fin-form').elements, btn = this, v = U.parseNum(f.valor.value);
              if (f.descricao.value.trim().length < 2) { UI.toast('Descreva a conta.', { type: 'err' }); return; }
              if (!(v > 0)) { UI.toast('Informe um valor maior que zero.', { type: 'err' }); return; }
              if (!f.vencimento.value) { UI.toast('Informe o vencimento.', { type: 'err' }); return; }
              UI.busy(btn, true);
              var op = pagar ? Biz.payables.create({ fornecedor: f.fornecedor.value, categoria: f.categoria.value, descricao: f.descricao.value, valor: v, vencimento: f.vencimento.value })
                : Biz.receivables.create({ customerId: f.customerId.value || null, descricao: f.descricao.value, valor: v, vencimento: f.vencimento.value });
              op.then(function () { UI.busy(btn, false); close('ok'); UI.toast('Conta lançada ✔', { type: 'ok' }); self.rerender(); })
                .catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err' }); });
            });
          }
        });
      };
      if (pagar) go([]); else Biz.customers.list().then(go).catch(function () { go([]); });
    }
  };

  /* =================== ORÇAMENTOS =================== */
  Pages.orcamentos = {
    title: 'Orçamentos', status: 'aberto',
    render: function () { return C.skeleton('table'); },
    mounted: function (root) { var self = this; this.rerender = function () { self.fill(pageRoot()); }; this.fill(root); },
    fill: function (root) {
      var self = this;
      if (gate(root, 'orcamentos', 'Monte orçamentos com os preços do seu catálogo, imprima para o cliente e transforme em venda com um clique.')) return;
      Biz.quotes.list().then(function (all) {
        self.all = all;
        var hoje = Biz.today();
        var list = all.filter(function (q) { return self.status === 'todos' || q.status === self.status; });
        mount(root, html`
          ${C.pageHead('Orçamentos', all.filter(function (q) { return q.status === 'aberto'; }).length + ' em aberto · ' + all.filter(function (q) { return q.status === 'convertido'; }).length + ' viraram venda',
            raw('<button type="button" class="btn btn-primary" data-new>' + I('plus', 15) + ' Novo orçamento</button>'))}
          <div class="toolbar"><select class="select" id="q-st" aria-label="Situação" style="max-width:200px">
            ${[['aberto', 'Em aberto'], ['convertido', 'Viraram venda'], ['cancelado', 'Cancelados'], ['todos', 'Todos']].map(function (o) { return html`<option value="${o[0]}" ${self.status === o[0] ? raw('selected') : ''}>${o[1]}</option>`; })}
          </select></div>
          ${list.length ? html`<div class="table-wrap"><table class="table">
            <thead><tr><th>Número</th><th>Cliente</th><th>Itens</th><th class="num">Total</th><th>Validade</th><th>Situação</th><th style="width:210px"></th></tr></thead>
            <tbody>${list.map(function (q) {
              var vencido = q.status === 'aberto' && q.validade < hoje;
              return html`<tr class="${q.status !== 'aberto' ? 'row-off' : ''}">
                <td class="mono small">${q.numero}<br><span class="muted">${U.date(q.createdAt)}</span></td>
                <td class="strong">${q.clienteNome || 'Consumidor'}</td>
                <td class="small muted">${q.itens.length} item(ns)</td>
                <td class="num tabular"><b>${money(q.total)}</b></td>
                <td class="${vencido ? 'text-danger strong' : ''}">${Biz.fmtDate(q.validade)}${vencido ? raw(' <span class="badge badge-danger no-dot">vencido</span>') : ''}</td>
                <td>${badgeStatus(q.status)}</td>
                <td class="right nowrap">
                  <button type="button" class="btn-icon sm" data-print="${q.id}" title="Imprimir" aria-label="Imprimir ${q.numero}">${raw(I('printer', 15))}</button>
                  ${q.status === 'aberto' ? html`<button type="button" class="btn btn-sm btn-primary" data-sell="${q.id}">${raw(I('cart', 14))} Virar venda</button>
                  <button type="button" class="btn-icon sm on-danger" data-cancel="${q.id}" title="Cancelar" aria-label="Cancelar ${q.numero}">${raw(I('x-circle', 15))}</button>` : ''}
                </td></tr>`;
            })}</tbody></table></div>`
          : C.empty('tag', 'Nenhum orçamento ' + (self.status === 'aberto' ? 'em aberto' : 'neste filtro'), 'Crie um orçamento, imprima para o cliente e converta em venda quando ele aprovar.',
              raw('<button type="button" class="btn btn-primary" data-new>' + I('plus', 15) + ' Novo orçamento</button>'))}`);
        root.querySelector('#q-st').addEventListener('change', function () { self.status = this.value; self.fill(root); });
        root.querySelectorAll('[data-new]').forEach(function (b) { b.addEventListener('click', function () { self.form(); }); });
        var byId = function (id) { return all.filter(function (q) { return q.id === id; })[0]; };
        root.querySelectorAll('[data-print]').forEach(function (b) { b.addEventListener('click', function () { self.print(byId(b.dataset.print)); }); });
        root.querySelectorAll('[data-sell]').forEach(function (b) { b.addEventListener('click', function () { Pages.pdv.loadQuote(byId(b.dataset.sell)); }); });
        root.querySelectorAll('[data-cancel]').forEach(function (b) {
          b.addEventListener('click', function () {
            UI.confirm({ title: 'Cancelar este orçamento?', text: 'Ele não poderá mais virar venda.', danger: true, okText: 'Cancelar orçamento' }).then(function (ok) {
              if (ok) Biz.quotes.cancel(b.dataset.cancel).then(function () { UI.toast('Orçamento cancelado.', { type: 'warn' }); self.fill(root); }).catch(function (e) { UI.toast(e.message, { type: 'err' }); });
            });
          });
        });
      }).catch(function (e) { errBox(root, e); });
    },
    form: function () {
      var self = this, lines = [];
      var prods = Store.state.products.filter(function (p) { return p.ativo; }).sort(function (a, b) { return a.nome.localeCompare(b.nome); });
      var open = function (custs) {
        UI.modal({
          title: 'Novo orçamento', size: 'lg',
          body: html`<div class="field-row">
              <div class="field"><label for="qo-cli">Cliente cadastrado</label><select class="select" id="qo-cli"><option value="">— consumidor / digitar nome —</option>
                ${custs.filter(function (c) { return c.ativo; }).map(function (c) { return html`<option value="${c.id}">${c.nome}</option>`; })}</select></div>
              <div class="field"><label for="qo-nome">Nome do cliente (se não cadastrado)</label><input class="input" id="qo-nome"></div>
            </div>
            <div class="field-row-3">
              <div class="field" style="grid-column:span 2"><label for="qo-prod">Produto</label><select class="select" id="qo-prod">
                ${prods.map(function (p) { return html`<option value="${p.id}">${p.nome} — ${U.money(p.preco)}/${p.un}</option>`; })}</select></div>
              <div class="field"><label for="qo-qtd">Quantidade</label><div class="flex gap-2"><input class="input" id="qo-qtd" inputmode="decimal" value="1"><button type="button" class="btn btn-dark" id="qo-add">${raw(I('plus', 15))}</button></div></div>
            </div>
            <div id="qo-lines"></div>
            <div class="field-row mt-3">
              <div class="field"><label for="qo-desc">Desconto (R$)</label><input class="input input-money" id="qo-desc" inputmode="decimal" value="0"></div>
              <div class="field"><label for="qo-val">Válido até</label><input class="input" type="date" id="qo-val" value="${Biz.addDays(Biz.today(), 7)}"></div>
            </div>
            <div class="field"><label for="qo-obs">Observações (aparecem na impressão)</label><input class="input" id="qo-obs" placeholder="Ex.: entrega inclusa, pagamento à vista"></div>`,
          foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button><button type="button" class="btn btn-primary" data-save>' + I('save', 15) + ' Salvar orçamento</button>'),
          onMount: function (panel, close) {
            var box = panel.querySelector('#qo-lines');
            var draw = function () {
              var sub = U.round2(U.sum(lines, function (l) { return l.preco * l.qtd; }));
              var desc = Math.min(sub, Math.max(0, U.parseNum(panel.querySelector('#qo-desc').value) || 0));
              box.innerHTML = lines.length ? '<ul class="mini-list">' + lines.map(function (l, i) {
                return '<li class="mini-row"><span class="mr-main"><span class="mr-name">' + U.esc(U.num(l.qtd) + ' ' + l.un + ' × ' + l.nome) + '</span></span><b class="tabular">' + U.money(l.preco * l.qtd) +
                  '</b><button type="button" class="btn-icon sm on-danger" data-rm="' + i + '" aria-label="Remover">' + I('trash', 14) + '</button></li>';
              }).join('') + '<li class="mini-row" style="font-size:1.05rem"><span><b>Total</b></span><b class="tabular">' + U.money(sub - desc) + '</b></li></ul>'
                : '<p class="small muted">Adicione produtos ao orçamento.</p>';
              box.querySelectorAll('[data-rm]').forEach(function (b) { b.addEventListener('click', function () { lines.splice(Number(b.dataset.rm), 1); draw(); }); });
            };
            draw();
            panel.querySelector('#qo-desc').addEventListener('input', draw);
            panel.querySelector('#qo-add').addEventListener('click', function () {
              var p = prods.filter(function (x) { return x.id === panel.querySelector('#qo-prod').value; })[0];
              var q = U.parseNum(panel.querySelector('#qo-qtd').value);
              if (!p || !(q > 0)) { UI.toast('Escolha o produto e uma quantidade maior que zero.', { type: 'err' }); return; }
              var ex = lines.filter(function (l) { return l.productId === p.id; })[0];
              if (ex) ex.qtd = U.round2((ex.qtd + q) * 1000) / 1000; else lines.push({ productId: p.id, nome: p.nome, un: p.un, preco: p.preco, qtd: q });
              panel.querySelector('#qo-qtd').value = '1'; draw();
            });
            panel.querySelector('[data-save]').addEventListener('click', function () {
              if (!lines.length) { UI.toast('Adicione ao menos um produto.', { type: 'err' }); return; }
              var btn = this, cid = panel.querySelector('#qo-cli').value;
              UI.busy(btn, true);
              Biz.quotes.create({ customerId: cid || null, clienteNome: cid ? '' : panel.querySelector('#qo-nome').value.trim(), itens: lines,
                desconto: U.parseNum(panel.querySelector('#qo-desc').value) || 0, validade: panel.querySelector('#qo-val').value, obs: panel.querySelector('#qo-obs').value })
                .then(function (r) { UI.busy(btn, false); close('ok'); UI.toast('Orçamento ' + (r.numero || '') + ' salvo ✔', { type: 'ok' }); self.status = 'aberto'; self.rerender(); })
                .catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err' }); });
            });
          }
        });
      };
      if (!prods.length) { UI.toast('Cadastre produtos antes de montar orçamentos.', { type: 'warn' }); return; }
      Biz.customers.list().then(open).catch(function () { open([]); });
    },
    print: function (q) {
      var t = Store.state.tenant || {};
      var rows = q.itens.map(function (i) { return '<tr><td>' + U.esc(i.nome) + '</td><td style="text-align:right">' + U.esc(U.num(i.qtd) + ' ' + i.un) + '</td><td style="text-align:right">' + U.money(i.preco) + '</td><td style="text-align:right">' + U.money(i.subtotal) + '</td></tr>'; }).join('');
      var doc = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>' + U.esc(q.numero) + '</title><style>body{font-family:Arial,sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 16px}h1{font-size:20px;margin:0}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{border-bottom:1px solid #ddd;padding:8px;font-size:13px;text-align:left}.tot{font-size:18px;text-align:right;margin-top:12px}.muted{color:#666;font-size:12px}</style></head><body>' +
        '<h1>' + U.esc(t.nome || 'Orçamento') + '</h1><div class="muted">' + U.esc([t.cnpj ? 'CNPJ ' + fmtDoc(t.cnpj) : '', t.endereco, t.telefone].filter(Boolean).join(' · ')) + '</div>' +
        '<h2 style="font-size:16px;margin-top:20px">Orçamento ' + U.esc(q.numero) + '</h2><div class="muted">Emitido em ' + U.date(q.createdAt) + ' · válido até ' + Biz.fmtDate(q.validade) + '</div>' +
        '<p><b>Cliente:</b> ' + U.esc(q.clienteNome || 'Consumidor') + '</p>' +
        '<table><thead><tr><th>Produto</th><th style="text-align:right">Qtd</th><th style="text-align:right">Unitário</th><th style="text-align:right">Total</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        (q.desconto > 0 ? '<div class="tot" style="font-size:14px">Desconto: − ' + U.money(q.desconto) + '</div>' : '') +
        '<div class="tot"><b>Total: ' + U.money(q.total) + '</b></div>' + (q.obs ? '<p class="muted">' + U.esc(q.obs) + '</p>' : '') +
        '<p class="muted" style="margin-top:28px">Orçamento sem valor fiscal. Preços sujeitos a alteração após a validade.</p><script>window.print()<\/script></body></html>';
      var w = window.open('', '_blank');
      if (!w) { UI.toast('Permita pop-ups para imprimir o orçamento.', { type: 'warn' }); return; }
      w.document.open(); w.document.write(doc); w.document.close();
    }
  };

  /* =================== NOTA FISCAL (NFC-e / NF-e) =================== */
  Pages.fiscal = {
    title: 'Nota fiscal',
    render: function () { return C.skeleton('table'); },
    mounted: function (root) { var self = this; this.rerender = function () { self.fill(pageRoot()); }; this.fill(root); },
    fill: function (root) {
      var self = this;
      if (gate(root, 'fiscal', 'Emita NFC-e no PDV e NF-e para empresas, com cancelamento e DANFE, integrados a um emissor homologado pela SEFAZ.')) return;
      var isAdmin = ['admin', 'dev'].indexOf((Auth.me() || {}).papel) > -1;
      Promise.all([Biz.fiscal.config(), Biz.fiscal.docs()]).then(function (d) {
        var cfg = d[0] || {}, docs = d[1] || [];
        var sales = {}; Store.state.sales.forEach(function (s) { sales[s.id] = s; });
        mount(root, html`
          ${C.pageHead('Nota fiscal', 'NFC-e (consumidor) e NF-e (empresas) · emissor Focus NFe')}
          <div class="grid-2e">
            ${C.panel('Configuração', cfg.hasToken ? 'Token configurado · ambiente de ' + (cfg.ambiente === 'producao' ? 'PRODUÇÃO' : 'homologação (testes)') : 'Ainda não configurado', isAdmin ? html`
              <form id="fc-form" novalidate>
                <div class="field"><label for="fc-amb">Ambiente</label><select class="select" id="fc-amb" name="ambiente">
                  <option value="homologacao" ${cfg.ambiente !== 'producao' ? raw('selected') : ''}>Homologação (testes, sem valor fiscal)</option>
                  <option value="producao" ${cfg.ambiente === 'producao' ? raw('selected') : ''}>Produção (notas com valor fiscal)</option></select></div>
                <div class="field"><label for="fc-tok">Token da empresa no Focus NFe</label><input class="input mono" id="fc-tok" name="token" type="password" autocomplete="off" placeholder="${cfg.hasToken ? '•••••••• (configurado — preencha só para trocar)' : 'Cole aqui o token do Focus NFe'}"></div>
                <label class="chk"><input type="checkbox" id="fc-auto" ${cfg.autoEmitir ? raw('checked') : ''}> Emitir NFC-e automaticamente ao finalizar cada venda no PDV</label>
                <div class="flex gap-2 mt-3" style="flex-wrap:wrap">
                  <button type="button" class="btn btn-primary" data-save>${raw(I('save', 15))} Salvar</button>
                  <button type="button" class="btn" data-test ${cfg.hasToken ? '' : raw('disabled')}>${raw(I('zap', 15))} Testar conexão</button>
                </div>
              </form>` : html`<p class="small muted">Somente o administrador altera a configuração fiscal.</p>`)}
            ${C.panel('Como ativar (uma vez por loja)', null, html`<ol class="steps-list small">
              <li>Crie a conta da sua empresa no <b>Focus NFe</b> (focusnfe.com.br) — é o emissor homologado que transmite para a SEFAZ.</li>
              <li>No painel do Focus NFe, cadastre a empresa com o <b>certificado digital A1</b> e o <b>CSC</b> da NFC-e (obtido no site da SEFAZ do seu estado).</li>
              <li>Copie o <b>token</b> da empresa e cole ao lado. Teste em <b>homologação</b> e, quando aprovado, mude para <b>produção</b>.</li>
              <li>Em <b>Produtos</b>, preencha o <b>NCM</b> de cada item (seu contador informa). Em <b>Configurações → Loja</b>, confira o <b>CNPJ</b>.</li>
              <li>Pronto: emita pelo detalhe da venda (Vendas) ou deixe a emissão automática ligada.</li></ol>`)}
          </div>
          ${C.panel('Notas emitidas', docs.length + ' documento(s)', docs.length ? html`<div class="table-wrap" style="border:none"><table class="table">
            <thead><tr><th>Data</th><th>Venda</th><th>Modelo</th><th>Número</th><th>Situação</th><th>Mensagem</th><th style="width:170px"></th></tr></thead>
            <tbody>${docs.map(function (x) {
              var s = sales[x.saleId];
              return html`<tr><td class="small nowrap">${U.dt(x.createdAt)}</td><td class="mono small">${s ? s.numero : '—'}</td><td>${x.modelo === 'nfe' ? 'NF-e' : 'NFC-e'}${x.ambiente !== 'producao' ? raw(' <span class="badge badge-mut no-dot">teste</span>') : ''}</td>
                <td class="mono small">${x.numero ? x.numero + '/' + x.serie : '—'}</td><td>${badgeStatus(x.status)}</td><td class="small muted" style="max-width:280px">${x.mensagem}</td>
                <td class="right nowrap">${x.danfeUrl ? raw('<a class="btn btn-sm" href="' + U.esc(x.danfeUrl) + '" target="_blank" rel="noopener">' + I('printer', 14) + ' DANFE</a>') : ''}
                  ${x.status === 'processando' ? html`<button type="button" class="btn btn-sm" data-st="${x.id}">${raw(I('refresh', 14))} Atualizar</button>` : ''}</td></tr>`;
            })}</tbody></table></div>` : C.empty('receipt', 'Nenhuma nota emitida ainda', 'Emita pela tela Vendas (detalhe da venda) ou ligue a emissão automática.'))}`);
        var sv = root.querySelector('[data-save]');
        if (sv) sv.addEventListener('click', function () {
          var btn = this; UI.busy(btn, true);
          Biz.fiscal.saveConfig({ ambiente: root.querySelector('#fc-amb').value, token: root.querySelector('#fc-tok').value.trim(), autoEmitir: root.querySelector('#fc-auto').checked })
            .then(function () { UI.busy(btn, false); FiscalUI.cfg = null; UI.toast('Configuração fiscal salva ✔', { type: 'ok' }); self.fill(root); })
            .catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err' }); });
        });
        var ts = root.querySelector('[data-test]');
        if (ts) ts.addEventListener('click', function () {
          var btn = this; UI.busy(btn, true);
          Biz.fiscal.test().then(function (r) { UI.busy(btn, false); UI.toast(r.message || 'Conexão OK ✔', { type: 'ok', timeout: 6000 }); })
            .catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err', timeout: 8000 }); });
        });
        root.querySelectorAll('[data-st]').forEach(function (b) { b.addEventListener('click', function () { Biz.fiscal.status(b.dataset.st).then(function () { self.fill(root); }); }); });
      }).catch(function (e) { errBox(root, e); });
    }
  };

  var FiscalUI = {
    cfg: null, cfgAt: 0,
    config: function () {
      if (this.cfg && Date.now() - this.cfgAt < 300000) return Promise.resolve(this.cfg);
      var self = this;
      return Biz.fiscal.config().then(function (c) { self.cfg = c; self.cfgAt = Date.now(); return c; });
    },
    /* bloco "Nota fiscal" dentro do detalhe da venda */
    saleBox: function (el, sale) {
      if (!el || !window.Plans || !Plans.has('fiscal') || sale.status !== 'concluida') return;
      var isAdmin = ['admin', 'dev'].indexOf((Auth.me() || {}).papel) > -1;
      var draw = function () {
        el.innerHTML = '<p class="small muted mt-3">Carregando nota fiscal…</p>';
        Biz.fiscal.docs(sale.id).then(function (docs) {
          var ok = docs.filter(function (d) { return d.status === 'autorizado' || d.status === 'processando'; })[0];
          var last = docs[0];
          var h = '<hr class="divider"><div class="fiscal-sale"><b>' + I('receipt', 15) + ' Nota fiscal</b> ';
          if (ok) {
            h += '<span>' + (ok.modelo === 'nfe' ? 'NF-e' : 'NFC-e') + ' nº ' + U.esc(ok.numero || '—') + ' · ' + (ok.status === 'autorizado' ? '<span class="badge badge-ok">autorizada</span>' : '<span class="badge badge-warn">processando</span>') + '</span>' +
              '<div class="flex gap-2 mt-2" style="flex-wrap:wrap">' + (ok.danfeUrl ? '<a class="btn btn-sm" href="' + U.esc(ok.danfeUrl) + '" target="_blank" rel="noopener">' + I('printer', 14) + ' DANFE</a>' : '') +
              (ok.status === 'processando' ? '<button type="button" class="btn btn-sm" data-fst>' + I('refresh', 14) + ' Atualizar</button>' : '') +
              (isAdmin && ok.status === 'autorizado' ? '<button type="button" class="btn btn-sm btn-danger-ghost" data-fcan>' + I('x-circle', 14) + ' Cancelar nota</button>' : '') + '</div>';
          } else {
            if (last && last.status === 'erro') h += '<p class="small text-danger mt-2">Última tentativa rejeitada: ' + U.esc(last.mensagem) + '</p>';
            if (last && last.status === 'cancelado') h += '<p class="small muted mt-2">Nota anterior cancelada.</p>';
            h += '<div class="flex gap-2 mt-2" style="flex-wrap:wrap"><button type="button" class="btn btn-sm btn-primary" data-femit="nfce">' + I('receipt', 14) + ' Emitir NFC-e</button>' +
              (sale.customerId ? '<button type="button" class="btn btn-sm" data-femit="nfe">' + I('receipt', 14) + ' Emitir NF-e</button>' : '') + '</div>';
          }
          el.innerHTML = h + '</div>';
          el.querySelectorAll('[data-femit]').forEach(function (b) {
            b.addEventListener('click', function () {
              UI.busy(b, true);
              Biz.fiscal.emit(sale.id, b.dataset.femit).then(function (r) {
                UI.toast((b.dataset.femit === 'nfe' ? 'NF-e' : 'NFC-e') + (r.doc.status === 'autorizado' ? ' autorizada ✔' : ' enviada — em processamento'), { type: 'ok' });
                if (r.doc.danfeUrl) window.open(r.doc.danfeUrl, '_blank', 'noopener');
                draw();
              }).catch(function (e) { UI.busy(b, false); UI.toast(e.message, { type: 'err', timeout: 9000 }); draw(); });
            });
          });
          var st = el.querySelector('[data-fst]'); if (st) st.addEventListener('click', function () { Biz.fiscal.status(ok.id).then(draw); });
          var cn = el.querySelector('[data-fcan]');
          if (cn) cn.addEventListener('click', function () {
            var j = window.prompt('Justificativa do cancelamento (15 a 255 caracteres). A NFC-e só pode ser cancelada até 30 minutos após a emissão:');
            if (j === null) return;
            Biz.fiscal.cancel(ok.id, j).then(function () { UI.toast('Nota cancelada na SEFAZ ✔', { type: 'warn' }); draw(); }).catch(function (e) { UI.toast(e.message, { type: 'err', timeout: 9000 }); });
          });
        }).catch(function (e) { el.innerHTML = '<p class="small text-danger mt-3">' + U.esc(e.message) + '</p>'; });
      };
      draw();
    }
  };
  window.FiscalUI = FiscalUI;

  /* =================== LOJAS (multi-loja) =================== */
  Pages.lojas = {
    title: 'Lojas',
    render: function () { return C.skeleton('table'); },
    mounted: function (root) { var self = this; this.rerender = function () { self.fill(pageRoot()); }; this.fill(root); },
    fill: function (root) {
      var self = this;
      if (gate(root, 'multiloja', 'Gerencie várias lojas com uma única assinatura: cada loja tem estoque, caixa e equipe próprios, e você acompanha tudo num painel consolidado.')) return;
      var isAdmin = ['admin', 'dev'].indexOf((Auth.me() || {}).papel) > -1;
      Promise.all([Biz.stores.list(), Biz.stores.summary(30)]).then(function (d) {
        var stores = d[0] || [], sum = d[1] || [];
        var tot = { vendas: U.sum(sum, function (x) { return Number(x.vendas) || 0; }), fat: U.round2(U.sum(sum, function (x) { return Number(x.faturamento) || 0; })), rec: U.round2(U.sum(sum, function (x) { return Number(x.receberAberto) || 0; })) };
        mount(root, html`
          ${C.pageHead('Lojas', stores.length + ' loja(s) na sua conta · uma assinatura Premium para todas', isAdmin ? raw('<button type="button" class="btn btn-primary" data-new>' + I('plus', 15) + ' Nova loja</button>') : '')}
          <div class="kpi-grid">
            ${C.kpi({ lbl: 'Lojas', val: String(stores.length), icon: 'store' })}
            ${C.kpi({ lbl: 'Vendas (30 dias)', val: String(tot.vendas), icon: 'receipt', sub: 'todas as lojas' })}
            ${C.kpi({ lbl: 'Faturamento (30 dias)', val: money(tot.fat), icon: 'trending', tone: 'ok', sub: 'consolidado' })}
            ${C.kpi({ lbl: 'A receber em aberto', val: money(tot.rec), icon: 'dollar', tone: 'warn', sub: 'fiado + contas' })}
          </div>
          ${C.panel('Suas lojas', 'Entre em uma loja para operar o PDV, o estoque e a equipe dela', html`<div class="table-wrap" style="border:none"><table class="table">
            <thead><tr><th>Loja</th><th>Seu papel</th><th class="num">Vendas 30d</th><th class="num">Faturamento 30d</th><th class="num">Abaixo do mínimo</th><th style="width:160px"></th></tr></thead>
            <tbody>${stores.map(function (s) {
              var m = sum.filter(function (x) { return x.id === s.id; })[0] || {};
              return html`<tr><td><span class="strong">${s.nome}</span> ${s.principal ? raw('<span class="badge badge-mut no-dot">principal</span>') : ''} ${s.atual ? raw('<span class="badge badge-ok">você está aqui</span>') : ''}</td>
                <td class="small">${s.papel}</td><td class="num tabular">${m.vendas != null ? m.vendas : '—'}</td><td class="num tabular">${m.faturamento != null ? money(m.faturamento) : '—'}</td>
                <td class="num tabular">${m.abaixoMinimo ? html`<span class="badge badge-danger no-dot">${m.abaixoMinimo}</span>` : '0'}</td>
                <td class="right">${s.atual ? '' : html`<button type="button" class="btn btn-sm btn-primary" data-go="${s.id}">${raw(I('arrow-right', 14))} Entrar nesta loja</button>`}</td></tr>`;
            })}</tbody></table></div>`)}
          <p class="small muted mt-3">Cada loja tem produtos, estoque, vendas, caixa e financeiro próprios. Para dar acesso a funcionários, entre na loja e convide em Configurações → Equipe.</p>`);
        var nb = root.querySelector('[data-new]'); if (nb) nb.addEventListener('click', function () { self.form(); });
        root.querySelectorAll('[data-go]').forEach(function (b) {
          b.addEventListener('click', function () {
            UI.busy(b, true);
            Biz.stores.switchTo(b.dataset.go).then(function (r) {
              if (r && r.local) { UI.busy(b, false); UI.toast('Demonstração: troca de loja simulada.', { type: 'info' }); self.fill(root); return; }
              Store.state.session.tenantId = b.dataset.go; Store.persist();
              UI.toast('Abrindo a loja…', { type: 'info' });
              setTimeout(function () { window.location.hash = '#/app/dashboard'; window.location.reload(); }, 300);
            }).catch(function (e) { UI.busy(b, false); UI.toast(e.message, { type: 'err' }); });
          });
        });
      }).catch(function (e) { errBox(root, e); });
    },
    form: function () {
      var self = this;
      UI.modal({
        title: 'Nova loja', sub: 'Ela nasce com o mesmo plano e vencimento da loja principal.',
        body: html`<div class="field"><label for="lj-nome">Nome da loja <span class="req">*</span></label><input class="input" id="lj-nome" placeholder="Ex.: Depósito São José — Filial Centro" data-autofocus></div>
          <div class="field-row"><div class="field"><label for="lj-cnpj">CNPJ</label><input class="input mono" id="lj-cnpj" inputmode="numeric"></div>
          <div class="field"><label for="lj-tel">Telefone</label><input class="input" id="lj-tel"></div></div>
          <div class="field"><label for="lj-end">Endereço</label><input class="input" id="lj-end"></div>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button><button type="button" class="btn btn-primary" data-save>' + I('store', 15) + ' Criar loja</button>'),
        onMount: function (panel, close) {
          panel.querySelector('[data-save]').addEventListener('click', function () {
            var nome = panel.querySelector('#lj-nome').value.trim(), btn = this;
            if (nome.length < 2) { UI.toast('Informe o nome da loja.', { type: 'err' }); return; }
            UI.busy(btn, true);
            Biz.stores.create({ nome: nome, cnpj: panel.querySelector('#lj-cnpj').value.replace(/\D/g, ''), telefone: panel.querySelector('#lj-tel').value, endereco: panel.querySelector('#lj-end').value })
              .then(function () { UI.busy(btn, false); close('ok'); UI.toast('Loja "' + nome + '" criada ✔', { type: 'ok' }); self.rerender(); })
              .catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err' }); });
          });
        }
      });
    }
  };

  /* =================== Extensões do PDV =================== */
  function extendPDV() {
    var P = Pages.pdv;
    if (!P || P.pickCustomer) return;
    P.setCustomer = function (id, nome) {
      this.st.customerId = id || null; this.st.customerNome = nome || '';
      var l = document.getElementById('pdv-cust-lbl'); if (l) l.textContent = nome || 'Identificar cliente (opcional)';
      var b = document.getElementById('pdv-cust'); if (b) b.classList.toggle('is-set', !!id);
    };
    P.pickCustomer = function () {
      var self = this;
      if (!Plans.has('clientes')) { UI.toast('Clientes faz parte do plano Profissional.', { type: 'warn' }); return; }
      Biz.customers.list().then(function (all) {
        var list = all.filter(function (c) { return c.ativo; });
        UI.modal({
          title: 'Cliente da venda', sub: 'Obrigatório para vender no fiado e para NF-e.',
          body: html`<div class="flex gap-2"><span class="search-box" style="flex:1">${raw(I('search', 16))}<input class="input" id="pc-q" type="search" placeholder="Nome, CPF/CNPJ ou telefone" data-autofocus></span>
              <button type="button" class="btn" data-newc>${raw(I('plus', 15))} Novo</button></div>
            <div id="pc-list" class="pick-list mt-3"></div>`,
          foot: raw('<button type="button" class="btn btn-ghost" data-none>Venda sem cliente</button><button type="button" class="btn btn-ghost" data-modal-close>Fechar</button>'),
          onMount: function (panel, close) {
            var box = panel.querySelector('#pc-list'), q = panel.querySelector('#pc-q');
            var draw = function () {
              var t = q.value.toLowerCase().trim();
              var rows = list.filter(function (c) { return !t || (c.nome + ' ' + c.documento + ' ' + c.telefone).toLowerCase().indexOf(t) > -1; }).slice(0, 40);
              box.innerHTML = rows.length ? rows.map(function (c) {
                return '<button type="button" class="pick-item" data-id="' + U.esc(c.id) + '"><span><b>' + U.esc(c.nome) + '</b><br><span class="small muted">' + U.esc(fmtDoc(c.documento) || c.telefone || '') + '</span></span>' +
                  (c.aberto > 0 ? '<span class="small text-danger">deve ' + U.money(c.aberto) + (c.limite > 0 ? ' / limite ' + U.money(c.limite) : '') + '</span>' : (c.limite > 0 ? '<span class="small muted">limite ' + U.money(c.limite) + '</span>' : '')) + '</button>';
              }).join('') : '<p class="small muted">Nenhum cliente encontrado. Use “Novo” para cadastrar.</p>';
              box.querySelectorAll('.pick-item').forEach(function (b) {
                b.addEventListener('click', function () { var c = list.filter(function (x) { return x.id === b.dataset.id; })[0]; self.setCustomer(c.id, c.nome); close('ok'); });
              });
            };
            q.addEventListener('input', draw); draw();
            panel.querySelector('[data-none]').addEventListener('click', function () { self.setCustomer(null, ''); close('ok'); });
            panel.querySelector('[data-newc]').addEventListener('click', function () {
              close('new'); Pages.clientes.form(null, function (c) { self.setCustomer(c.id, c.nome); });
            });
          }
        });
      }).catch(function (e) { UI.toast(e.message, { type: 'err' }); });
    };
    P.loadQuote = function (q) {
      if (!q) return;
      var st = this.freshState();
      q.itens.forEach(function (i) {
        var p = Store.state.products.filter(function (x) { return x.id === i.productId; })[0];
        if (p && p.ativo) st.cart.push({ productId: p.id, nome: p.nome, un: p.un, preco: p.preco, qtd: Number(i.qtd) });
      });
      if (!st.cart.length) { UI.toast('Os produtos deste orçamento não estão mais ativos no catálogo.', { type: 'err' }); return; }
      if (q.desconto > 0) st.disc = { tipo: 'R$', valor: q.desconto };
      st.quoteId = q.id; st.quoteNumero = q.numero;
      if (q.customerId) { st.customerId = q.customerId; st.customerNome = q.clienteNome; }
      this.st = st;
      UI.toast('Orçamento ' + q.numero + ' carregado no PDV — confira o pagamento e finalize.', { type: 'info', timeout: 5000 });
      Router.go('/app/pdv');
    };
    P.afterSale = function (sale) {
      if (!Plans.has('fiscal') || sale.pending) return;
      FiscalUI.config().then(function (cfg) {
        if (!cfg || !cfg.autoEmitir || !cfg.hasToken) return;
        UI.toast('Emitindo NFC-e da ' + sale.numero + '…', { type: 'info' });
        return Biz.fiscal.emit(sale.id, 'nfce').then(function (r) {
          UI.toast('NFC-e nº ' + (r.doc.numero || '') + ' autorizada ✔', { type: 'ok', timeout: 6000 });
          if (r.doc.danfeUrl) window.open(r.doc.danfeUrl, '_blank', 'noopener');
        });
      }).catch(function (e) { UI.toast('A venda foi salva, mas a NFC-e não saiu: ' + e.message + ' Tente de novo em Vendas.', { type: 'warn', timeout: 10000 }); });
    };
    /* o render do PDV recria o rótulo a partir do estado — mantém cliente/orçamento */
    var origRender = P.render;
    P.render = function () { var out = origRender.apply(this, arguments); return out; };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', extendPDV); else extendPDV();
  setTimeout(extendPDV, 0);
})();
