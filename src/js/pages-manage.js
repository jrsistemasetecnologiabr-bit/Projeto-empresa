/* ==========================================================================
   LojaCerta · Pages — Gestão (Produtos, Estoque, Relatórios, Assinatura,
   Configurações) + Views de Autenticação (Cadastro/Login)
   ========================================================================== */
;(function () {
  'use strict';
  window.Pages = window.Pages || {};
  window.AuthViews = window.AuthViews || {};

  function guardFail(root, msg) { mount(root, C.errorPanel(ApiError('NETWORK', msg))); }

  /* =================== PRODUTOS =================== */
  Pages.produtos = {
    title: 'Produtos',
    filter: { q: '', catId: '', lowOnly: false, inactive: false },
    render: function () { return C.skeleton('table'); },
    mounted: function (root, params, query) {
      var self = this;
      this.rerender = function () { self.fill(document.getElementById('page-root')); };
      if (query && query.low) this.filter.lowOnly = true;
      setTimeout(function () { self.fill(root); }, Config.latency ? 180 : 0);
    },
    fill: function (root) {
      var self = this;
      if (Config.simulateFailures) { guardFail(root, 'Falha de conexão simulada ao carregar produtos.'); return; }
      var list = Catalog.list(this.filter);
      var cats = Catalog.categories();
      var total = Store.state.products.length;
      var canManage = Perms.can('products.manage');
      var canCost = Perms.can('custo.view');

      mount(root, html`
        ${C.pageHead('Produtos', list.length + ' exibidos · ' + total + ' cadastrados', canManage ? raw(
          '<button type="button" class="btn" data-imp>' + I('import', 15) + ' Importar CSV</button>' +
          '<button type="button" class="btn btn-primary" data-new>' + I('plus', 15) + ' Novo produto</button>') : '')}
        <div class="toolbar">
          <span class="search-box">${raw(I('search', 16))}
            <input class="input" id="p-q" type="search" placeholder="Buscar por código ou nome…" value="${this.filter.q}" aria-label="Buscar produto"></span>
          <select class="select" id="p-cat" aria-label="Filtrar por categoria">
            <option value="">Todas as categorias</option>
            ${cats.map(function (c) { return html`<option value="${c.id}" ${self.filter.catId === c.id ? raw('selected') : ''}>${c.nome}</option>`; })}
          </select>
          <label class="chk"><input type="checkbox" id="p-low" ${this.filter.lowOnly ? raw('checked') : ''}> Abaixo do mínimo</label>
          <label class="chk"><input type="checkbox" id="p-off" ${this.filter.inactive ? raw('checked') : ''}> Incluir inativos</label>
          <span class="spacer"></span>
          <span class="stat-inline small"><b>${list.filter(function (p) { return p.estoque <= p.min && p.ativo; }).length}</b> em alerta</span>
        </div>
        ${list.length ? html`
        <div class="table-wrap"><table class="table" style="min-width:880px">
          <thead><tr><th>Código</th><th style="min-width:220px">Produto</th><th>Un.</th>${canCost ? html`<th class="num">Custo</th>` : ''}<th class="num">Preço</th><th class="num">Margem</th><th>Estoque</th><th>Status</th>${canManage ? html`<th style="width:150px"></th>` : ''}</tr></thead>
          <tbody>${list.map(function (p) {
            var low = p.estoque <= p.min && p.ativo;
            var marg = p.custo > 0 ? Math.round((p.preco / p.custo - 1) * 100) : null;
            return html`<tr class="${low ? 'row-danger' : ''} ${p.ativo ? '' : 'row-off'}">
              <td class="mono small">${p.codigo}</td>
              <td><span class="strong ellip">${p.nome}</span><br><span class="small muted">${Catalog.catName(p.catId)}</span></td>
              <td class="muted">${p.un}</td>
              ${canCost ? html`<td class="num muted tabular">${U.money(p.custo)}</td>` : ''}
              <td class="num"><b class="tabular">${U.money(p.preco)}</b></td>
              <td class="num">${marg === null ? raw('<span class="muted">—</span>') : html`<span class="badge ${marg >= 30 ? 'badge-ok' : marg >= 15 ? 'badge-warn' : 'badge-danger'} no-dot">${marg}%</span>`}</td>
              <td>${C.stockBadge(p)}</td>
              <td>${p.ativo ? raw('<span class="badge badge-ok">ativo</span>') : raw('<span class="badge badge-mut">inativo</span>')}</td>
              ${canManage ? html`<td class="right nowrap">
                <button type="button" class="btn-icon sm" data-edit="${p.id}" title="Editar" aria-label="Editar ${p.nome}">${raw(I('edit', 15))}</button>
                <button type="button" class="btn-icon sm" data-dup="${p.id}" title="Duplicar" aria-label="Duplicar ${p.nome}">${raw(I('copy', 15))}</button>
                <button type="button" class="btn-icon sm on-danger" data-tog="${p.id}" title="${p.ativo ? 'Inativar' : 'Reativar'}" aria-label="${p.ativo ? 'Inativar' : 'Reativar'} ${p.nome}">${raw(I(p.ativo ? 'lock' : 'refresh', 15))}</button>
                <button type="button" class="btn-icon sm" data-sell="${p.id}" title="Vender agora" aria-label="Vender ${p.nome}">${raw(I('cart', 15))}</button>
              </td>` : ''}</tr>`;
          })}</tbody></table></div>`
        : (total === 0
          ? C.empty('package', 'Nenhum produto cadastrado', 'Cadastre o primeiro produto ou importe sua planilha — a migração é grátis.', raw('<div class="flex gap-2"><button type="button" class="btn" data-imp>' + I('import', 15) + ' Importar CSV</button><button type="button" class="btn btn-primary" data-new>' + I('plus', 15) + ' Novo produto</button></div>'))
          : C.empty('search', 'Nenhum produto encontrado', 'Ajuste a busca ou os filtros para ver resultados.', raw('<button type="button" class="btn" data-clear>Limpar filtros</button>')))}
      `);

      /* bindings */
      var qEl = root.querySelector('#p-q');
      qEl.addEventListener('input', U.debounce(function () { self.filter.q = qEl.value; self.fill(root); var nq = root.querySelector('#p-q'); if (nq) { nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); } }, 320));
      root.querySelector('#p-cat').addEventListener('change', function () { self.filter.catId = this.value; self.fill(root); });
      root.querySelector('#p-low').addEventListener('change', function () { self.filter.lowOnly = this.checked; self.fill(root); });
      root.querySelector('#p-off').addEventListener('change', function () { self.filter.inactive = this.checked; self.fill(root); });
      var nb = root.querySelector('[data-new]'); if (nb) nb.addEventListener('click', function () { self.form(null); });
      var ib = root.querySelector('[data-imp]'); if (ib) ib.addEventListener('click', function () { self.importModal(); });
      var cb = root.querySelector('[data-clear]'); if (cb) cb.addEventListener('click', function () { self.filter = { q: '', catId: '', lowOnly: false, inactive: false }; self.fill(root); });
      root.querySelectorAll('[data-edit]').forEach(function (b) { b.addEventListener('click', function () { self.form(b.dataset.edit); }); });
      root.querySelectorAll('[data-dup]').forEach(function (b) {
        b.addEventListener('click', function () {
          Catalog.duplicate(b.dataset.dup).then(function () { UI.toast('Produto duplicado — edite o novo item.', { type: 'ok' }); self.rerender(); },
            function (e) { UI.toast(e.message, { type: 'err' }); });
        });
      });
      root.querySelectorAll('[data-tog]').forEach(function (b) {
        b.addEventListener('click', function () {
          Catalog.toggle(b.dataset.tog).then(function (r) { UI.toast(r.ativo ? 'Produto reativado ✔' : 'Produto inativado — histórico preservado.', { type: r.ativo ? 'ok' : 'warn' }); self.rerender(); },
            function (e) { UI.toast(e.message, { type: 'err' }); });
        });
      });
      root.querySelectorAll('[data-sell]').forEach(function (b) {
        b.addEventListener('click', function () {
          var p = Catalog.get(b.dataset.sell);
          Router.go('/app/pdv');
          setTimeout(function () { if (Pages.pdv.el && Pages.pdv.el.code) Pages.pdv.addByQuery(p.codigo); }, 260);
        });
      });
    },
    form: function (id) {
      var self = this;
      var p = id ? Catalog.get(id) : null;
      var cats = Catalog.categories();
      UI.modal({
        title: p ? 'Editar produto' : 'Novo produto', size: 'lg',
        body: html`<form id="prod-form" novalidate>
          <div class="field"><label for="f-nome">Nome / descrição <span class="req">*</span></label>
            <input class="input" id="f-nome" name="nome" value="${p ? p.nome : ''}" placeholder="Ex.: Cimento CP-II 50kg" data-autofocus></div>
          <div class="field-row">
            <div class="field"><label for="f-cat">Categoria</label><select class="select" id="f-cat" name="catId">
              ${cats.map(function (c) { return html`<option value="${c.id}" ${p && p.catId === c.id ? raw('selected') : ''}>${c.nome}</option>`; })}</select></div>
            <div class="field"><label for="f-un">Unidade de medida</label><select class="select" id="f-un" name="un">
              ${UNIDADES.map(function (u) { return html`<option ${p && p.un === u ? raw('selected') : ''}>${u}</option>`; })}</select></div>
          </div>
          <div class="field"><label for="f-cod">Código de barras <span class="muted" style="font-weight:400">(vazio = gera código interno)</span></label>
            <input class="input mono" id="f-cod" name="codigo" value="${p ? p.codigo : ''}" placeholder="${'Bipe com o leitor ou digite o EAN'}"></div>
          <div class="field-row-3">
            <div class="field"><label for="f-custo">Preço de custo</label><input class="input input-money" id="f-custo" name="custo" type="text" inputmode="decimal" value="${p ? U.num(p.custo, 2) : ''}"></div>
            <div class="field"><label for="f-preco">Preço de venda <span class="req">*</span></label><input class="input input-money" id="f-preco" name="preco" type="text" inputmode="decimal" value="${p ? U.num(p.preco, 2) : ''}"></div>
            <div class="field"><label>Margem</label><input class="input" id="f-marg" disabled value="${p && p.custo > 0 ? Math.round((p.preco / p.custo - 1) * 100) + '%' : '—'}"></div>
          </div>
          <div class="field-row">
            <div class="field"><label for="f-est">Estoque ${p ? 'atual' : 'inicial'}</label><input class="input input-money" id="f-est" name="estoque" type="text" inputmode="decimal" value="${p ? U.num(p.estoque) : '0'}"></div>
            <div class="field"><label for="f-min">Estoque mínimo</label><input class="input input-money" id="f-min" name="min" type="text" inputmode="decimal" value="${p ? U.num(p.min) : '0'}"></div>
          </div>
          <div class="field"><label for="f-forn">Fornecedor <span class="muted" style="font-weight:400">(opcional)</span></label>
            <input class="input" id="f-forn" name="fornecedor" value="${p ? p.fornecedor : ''}"></div>
        </form>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>' +
          '<button type="button" class="btn btn-primary" data-save>' + I('save', 16) + ' ' + (p ? 'Salvar alterações' : 'Cadastrar produto') + '</button>'),
        onMount: function (panel, close) {
          var form = panel.querySelector('#prod-form');
          var custo = form.elements.custo, preco = form.elements.preco, marg = panel.querySelector('#f-marg');
          function calcMarg() {
            var c = U.parseNum(custo.value), v = U.parseNum(preco.value);
            marg.value = isFinite(c) && c > 0 && isFinite(v) ? Math.round((v / c - 1) * 100) + '%' : '—';
          }
          custo.addEventListener('input', calcMarg); preco.addEventListener('input', calcMarg);
          panel.querySelector('[data-save]').addEventListener('click', function () {
            var res = Validate.run(form, {
              nome: [['required'], ['min', 2]],
              custo: [['num'], ['gte0']], preco: [['required'], ['num'], ['gt0']],
              estoque: [['num'], ['gte0']], min: [['num'], ['gte0']]
            });
            Validate.paint(form, res.errors);
            if (!res.ok) { UI.toast('Corrija os campos destacados.', { type: 'err' }); return; }
            var btn = this; UI.busy(btn, true);
            var data = res.values; data.custo = U.parseNum(data.custo) || 0; data.preco = U.parseNum(data.preco);
            data.estoque = U.parseNum(data.estoque) || 0; data.min = U.parseNum(data.min) || 0;
            /* campos fora do schema de validação também precisam ir */
            data.codigo = form.elements.codigo.value;
            data.catId = form.elements.catId.value;
            data.un = form.elements.un.value;
            data.fornecedor = form.elements.fornecedor.value;
            var op = p ? Catalog.update(Object.assign({ id: p.id }, data)) : Catalog.create(data);
            op.then(function () {
              UI.busy(btn, false); close('ok');
              UI.toast(p ? 'Produto atualizado ✔' : 'Produto cadastrado ✔', { type: 'ok' });
              self.rerender();
            }).catch(function (e) { UI.busy(btn, false); UI.toast(e.message || 'Erro ao salvar.', { type: 'err' }); });
          });
        }
      });
    },
    importModal: function () {
      var self = this;
      var MODELO = 'codigo;nome;categoria;unidade;custo;preco;estoque;minimo\n789000000;Cimento Exemplo 50kg;Cimento;saco;30,00;39,90;50;20\n;Areia Média;Areia e Pedra;m³;80,00;105,00;5;2';
      UI.modal({
        title: 'Importar produtos (CSV)', size: 'lg',
        sub: 'Aceita vírgula ou ponto-e-vírgula. Colunas reconhecidas: codigo, nome, categoria, unidade, custo, preco, estoque, minimo.',
        body: html`
          <div class="field"><label for="imp-file">Arquivo CSV</label>
            <input class="input" type="file" id="imp-file" accept=".csv,.txt,text/csv"></div>
          <div class="sep-or">ou cole o conteúdo</div>
          <div class="field"><textarea class="textarea mono" id="imp-text" style="min-height:130px;font-size:.78rem" placeholder="${'codigo;nome;categoria;unidade;custo;preco;estoque;minimo\n789...;Cimento CP-II 50kg;Cimento;saco;30,50;38,90;80;30'}"></textarea></div>
          <div id="imp-preview"></div>`,
        foot: raw('<button type="button" class="btn btn-ghost spread" data-modelo>' + I('download', 15) + ' Baixar modelo</button>' +
          '<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button>' +
          '<button type="button" class="btn btn-primary" data-analyze>' + I('filter', 15) + ' Analisar</button>'),
        onMount: function (panel, close) {
          var fileEl = panel.querySelector('#imp-file'), txt = panel.querySelector('#imp-text'), prev = panel.querySelector('#imp-preview');
          panel.querySelector('[data-modelo]').addEventListener('click', function () { U.download('modelo-produtos.csv', MODELO, 'text/csv'); });
          fileEl.addEventListener('change', function () {
            var f = fileEl.files && fileEl.files[0];
            if (!f) return;
            try {
              var fr = new FileReader();
              fr.onload = function () { txt.value = String(fr.result || ''); UI.toast('Arquivo carregado — clique em Analisar.', { type: 'info' }); };
              fr.onerror = function () { UI.toast('Não foi possível ler o arquivo.', { type: 'err' }); };
              fr.readAsText(f, 'utf-8');
            } catch (e) { UI.toast('Leitura de arquivo indisponível neste navegador.', { type: 'warn' }); }
          });
          panel.querySelector('[data-analyze]').addEventListener('click', function () {
            var r = Catalog.parseCSV(txt.value);
            if (r.error) { UI.toast(r.error, { type: 'err' }); return; }
            mount(prev, html`<hr class="divider">
              <p class="small"><b class="text-ok">${r.valid} válidas</b> · <b class="${r.invalid ? 'text-danger' : 'muted'}">${r.invalid} com erro</b> (linhas com erro são ignoradas)</p>
              <div class="table-wrap mt-2" style="max-height:220px;overflow-y:auto"><table class="table">
                <thead><tr><th>Linha</th><th>Produto</th><th class="num">Preço</th><th class="num">Estoque</th><th>Status</th></tr></thead>
                <tbody>${r.preview.slice(0, 30).map(function (row) {
                  return html`<tr class="${row.errors.length ? 'row-danger' : ''}"><td class="mono small">${row.linha}</td>
                    <td>${row.data.nome || raw('<span class="muted">—</span>')}</td>
                    <td class="num tabular">${U.money(U.parseNum(row.data.preco) || 0)}</td>
                    <td class="num tabular">${U.num(U.parseNum(row.data.estoque) || 0)}</td>
                    <td>${row.errors.length ? html`<span class="badge badge-danger">${row.errors.join(', ')}</span>` : raw('<span class="badge badge-ok">ok</span>')}</td></tr>`;
                })}</tbody></table></div>`);
            var footBtn = panel.parentElement.querySelector('[data-import]');
            if (!r.valid) { UI.toast('Nenhuma linha válida para importar.', { type: 'warn' }); return; }
            if (!footBtn) {
              var b = document.createElement('button');
              b.type = 'button'; b.className = 'btn btn-dark'; b.dataset.import = '1';
              b.innerHTML = I('upload', 15) + ' Importar ' + r.valid + ' produtos';
              panel.parentElement.querySelector('.modal-foot').appendChild(b);
              b.addEventListener('click', function () {
                UI.busy(b, true);
                Catalog.commitCSV(r.preview).then(function (res) {
                  UI.busy(b, false); close('ok');
                  UI.toast('Importação concluída: ' + res.ok + ' produtos criados' + (res.fail ? ', ' + res.fail + ' falhas (código duplicado?)' : '') + '.', { type: res.fail ? 'warn' : 'ok' });
                  self.rerender();
                });
              });
            }
          });
        }
      });
    },
    onStoreChanged: function () { if (Router.current && Router.current.path === '/app/produtos') this.fill(document.getElementById('page-root')); }
  };

  /* =================== ESTOQUE =================== */
  Pages.estoque = {
    title: 'Estoque',
    filter: { productId: '', tipo: '', days: 30 },
    render: function () { return C.skeleton('table'); },
    mounted: function (root, params, query) {
      var self = this;
      this.rerender = function () { self.fill(document.getElementById('page-root')); };
      if (query && query.p) this.filter.productId = query.p;
      setTimeout(function () { self.fill(root); }, Config.latency ? 180 : 0);
    },
    fill: function (root) {
      var self = this;
      if (Config.simulateFailures) { guardFail(root, 'Falha de conexão simulada ao carregar o estoque.'); return; }
      var prods = Catalog.list({ inactive: false });
      var low = Inventory.belowMin();
      var movs = Inventory.history({ productId: this.filter.productId || null, tipo: this.filter.tipo || null, from: U.dayStart((this.filter.days >= 9999 ? 3650 : this.filter.days) - 1), limit: 150 });
      var canManage = Perms.can('inventory.manage');
      var TIPO = { entrada: ['badge-ok', 'entrada'], saida: ['badge-danger', 'saída'], ajuste: ['badge-warn', 'ajuste'], venda_cancelada: ['badge-info', 'devolução'] };

      mount(root, html`
        ${C.pageHead('Estoque', 'movimentações, entradas e ajustes', canManage ? raw(
          '<button type="button" class="btn" data-ajuste>' + I('scale', 15) + ' Ajuste manual</button>' +
          '<button type="button" class="btn btn-primary" data-entrada>' + I('plus', 15) + ' Entrada de estoque</button>') : '')}
        <div class="kpi-grid">
          ${C.kpi({ lbl: 'Valor em estoque', val: U.money(Inventory.valuation()), sub: 'a preço de custo', icon: 'database', tone: 'info' })}
          ${C.kpi({ lbl: 'Produtos ativos', val: String(prods.length), sub: prods.filter(function (p) { return p.estoque > 0; }).length + ' com saldo', icon: 'package' })}
          ${C.kpi({ lbl: 'Abaixo do mínimo', val: String(low.length), sub: low.length ? 'clique para ver' : 'tudo em ordem', icon: 'alert', tone: low.length ? 'danger' : 'ok' })}
          ${C.kpi({ lbl: 'Movimentações', val: String(movs.length), sub: 'no período filtrado', icon: 'layers', tone: '' })}
        </div>
        <div class="toolbar">
          <select class="select" id="e-prod" aria-label="Filtrar por produto" style="max-width:280px">
            <option value="">Todos os produtos</option>
            ${prods.map(function (p) { return html`<option value="${p.id}" ${self.filter.productId === p.id ? raw('selected') : ''}>${p.nome}</option>`; })}
          </select>
          <select class="select" id="e-tipo" aria-label="Filtrar por tipo">
            <option value="">Todos os tipos</option><option value="entrada" ${this.filter.tipo === 'entrada' ? raw('selected') : ''}>Entradas</option>
            <option value="saida" ${this.filter.tipo === 'saida' ? raw('selected') : ''}>Saídas (vendas)</option>
            <option value="ajuste" ${this.filter.tipo === 'ajuste' ? raw('selected') : ''}>Ajustes</option>
            <option value="venda_cancelada" ${this.filter.tipo === 'venda_cancelada' ? raw('selected') : ''}>Devoluções</option>
          </select>
          ${C.periodSelect('e-period', this.filter.days)}
          <span class="spacer"></span>
          <button type="button" class="btn btn-sm" data-exp>${raw(I('download', 14))} CSV</button>
        </div>
        ${movs.length ? html`<div class="table-wrap"><table class="table" style="min-width:760px">
          <thead><tr><th>Data/hora</th><th style="min-width:200px">Produto</th><th>Tipo</th><th class="num">Qtd</th><th>Responsável</th><th>Origem / observação</th></tr></thead>
          <tbody>${movs.map(function (m) {
            var p = Catalog.get(m.productId);
            var t = TIPO[m.tipo] || ['badge-mut', m.tipo];
            var sinal = m.tipo === 'saida' ? '−' : (m.qtd < 0 ? '' : '+');
            return html`<tr><td class="muted nowrap small">${U.dt(m.at)}</td>
              <td class="strong">${p ? p.nome : '?'}</td>
              <td><span class="badge ${t[0]}">${t[1]}</span></td>
              <td class="num tabular"><b>${sinal}${U.num(Math.abs(m.qtd))}</b> <span class="muted small">${p ? p.un : ''}</span></td>
              <td>${m.userName}</td>
              <td class="muted small">${m.origem}${m.obs ? ' · ' + m.obs : ''}</td></tr>`;
          })}</tbody></table></div>`
        : C.empty('layers', 'Nenhuma movimentação', 'Entradas, vendas e ajustes aparecem aqui com data, responsável e motivo.')}`);

      root.querySelector('#e-prod').addEventListener('change', function () { self.filter.productId = this.value; self.fill(root); });
      root.querySelector('#e-tipo').addEventListener('change', function () { self.filter.tipo = this.value; self.fill(root); });
      root.querySelector('#e-period').addEventListener('change', function () { self.filter.days = Number(this.value); self.fill(root); });
      root.querySelector('[data-exp]').addEventListener('click', function () { if (DataOps.exportCSV('movimentacoes')) UI.toast('movimentacoes.csv exportado ✔', { type: 'ok' }); });
      var be = root.querySelector('[data-entrada]'); if (be) be.addEventListener('click', function () { self.entryModal(); });
      var ba = root.querySelector('[data-ajuste]'); if (ba) ba.addEventListener('click', function () { self.adjustModal(); });
    },
    prodOptions: function () {
      return Catalog.list({ inactive: false }).map(function (p) {
        return html`<option value="${p.id}">${p.nome} — ${U.num(p.estoque)} ${p.un}</option>`;
      });
    },
    entryModal: function () {
      var self = this;
      UI.modal({
        title: 'Entrada de estoque', sub: 'Reposição ou compra de mercadoria',
        body: html`<form id="ent-form" novalidate>
          <div class="field"><label for="en-prod">Produto <span class="req">*</span></label><select class="select" id="en-prod" name="productId" data-autofocus>${this.prodOptions()}</select></div>
          <div class="field-row">
            <div class="field"><label for="en-qtd">Quantidade <span class="req">*</span></label><input class="input input-money" id="en-qtd" name="qtd" type="text" inputmode="decimal"></div>
            <div class="field"><label for="en-custo">Custo unitário <span class="muted" style="font-weight:400">(atualiza o custo)</span></label><input class="input input-money" id="en-custo" name="custo" type="text" inputmode="decimal"></div>
          </div>
          <div class="field-row">
            <div class="field"><label for="en-forn">Fornecedor</label><input class="input" id="en-forn" name="fornecedor"></div>
            <div class="field"><label for="en-nf">Nº da nota</label><input class="input" id="en-nf" name="nf"></div>
          </div>
          <div class="field"><label for="en-obs">Observação</label><input class="input" id="en-obs" name="note"></div>
        </form>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button><button type="button" class="btn btn-primary" data-ok>' + I('plus', 16) + ' Registrar entrada</button>'),
        onMount: function (panel, close) {
          panel.querySelector('[data-ok]').addEventListener('click', function () {
            var form = panel.querySelector('#ent-form');
            var res = Validate.run(form, { qtd: [['required'], ['num'], ['gt0']], custo: [['num'], ['gte0']] });
            Validate.paint(form, res.errors);
            if (!res.ok) return;
            /* campos fora do schema de validação também precisam ir (idem form de produto) */
            Object.assign(res.values, {
              productId: form.elements.productId.value,
              fornecedor: form.elements.fornecedor.value.trim(),
              nf: form.elements.nf.value.trim(),
              note: form.elements.note.value.trim(),
              qtd: U.parseNum(res.values.qtd),
              custo: U.parseNum(res.values.custo) || 0
            });
            var btn = this; UI.busy(btn, true);
            Inventory.entry(res.values).then(function (r) {
              UI.busy(btn, false); close('ok');
              var p = Catalog.get(res.values.productId);
              UI.toast('Entrada registrada: ' + p.nome + ' agora com ' + U.num(r.estoque) + ' ' + p.un + '.', { type: 'ok' });
              self.rerender();
            }).catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err' }); });
          });
        }
      });
    },
    adjustModal: function () {
      var self = this;
      UI.modal({
        title: 'Ajuste manual de estoque', sub: 'Perdas, quebras ou correção de inventário',
        body: html`<form id="aj-form" novalidate>
          <div class="field"><label for="aj-prod">Produto <span class="req">*</span></label><select class="select" id="aj-prod" name="productId" data-autofocus>${this.prodOptions()}</select></div>
          <div class="field"><label for="aj-qtd">Quantidade (+ aumenta / − diminui) <span class="req">*</span></label>
            <input class="input input-money" id="aj-qtd" name="delta" type="text" inputmode="decimal" placeholder="Ex.: -2 ou 5"></div>
          <div class="field"><label for="aj-mot">Motivo <span class="req">*</span></label><select class="select" id="aj-mot" name="reason">
            <option>Perda / quebra</option><option>Inventário</option><option>Vencimento</option><option>Erro de lançamento</option><option>Outro</option></select></div>
          <div class="field"><label for="aj-obs">Observação</label><input class="input" id="aj-obs" name="note"></div>
        </form>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button><button type="button" class="btn btn-primary" data-ok>' + I('scale', 16) + ' Registrar ajuste</button>'),
        onMount: function (panel, close) {
          panel.querySelector('[data-ok]').addEventListener('click', function () {
            var form = panel.querySelector('#aj-form');
            var res = Validate.run(form, { delta: [['required'], ['num']], reason: [['required']] });
            Validate.paint(form, res.errors);
            if (!res.ok) return;
            if (U.parseNum(res.values.delta) === 0) { UI.toast('A quantidade não pode ser zero.', { type: 'err' }); return; }
            /* campos fora do schema de validação também precisam ir (idem form de produto) */
            Object.assign(res.values, {
              productId: form.elements.productId.value,
              note: form.elements.note.value.trim(),
              delta: U.parseNum(res.values.delta)
            });
            var btn = this; UI.busy(btn, true);
            Inventory.adjust(res.values).then(function (r) {
              UI.busy(btn, false); close('ok');
              var p = Catalog.get(res.values.productId);
              UI.toast('Ajuste registrado: ' + p.nome + ' → ' + U.num(r.estoque) + ' ' + p.un + '.', { type: 'ok' });
              self.rerender();
            }).catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err' }); });
          });
        }
      });
    },
    onStoreChanged: function () { if (Router.current && Router.current.path === '/app/estoque') this.fill(document.getElementById('page-root')); }
  };

  /* =================== RELATÓRIOS =================== */
  Pages.relatorios = {
    title: 'Relatórios',
    filter: { days: 7 },
    render: function () { return C.skeleton('kpis'); },
    mounted: function (root) {
      var self = this;
      this.rerender = function () { self.fill(document.getElementById('page-root')); };
      setTimeout(function () { self.fill(root); }, Config.latency ? 180 : 0);
    },
    fill: function (root) {
      var self = this;
      if (Config.simulateFailures) { guardFail(root, 'Falha de conexão simulada ao carregar relatórios.'); return; }
      var d = this.filter.days;
      var sum = Reports.summary(d);
      var byPay = Reports.byPayment(d);
      var byOp = Reports.byOperator(d);
      var top = Reports.topProducts(d, 10);
      var days = Reports.byDay(Math.min(d, 30));
      var low = Inventory.belowMin();
      var opMax = Math.max.apply(null, Object.keys(byOp).map(function (k) { return byOp[k].t; }).concat([1]));

      mount(root, html`
        ${C.pageHead('Relatórios', 'análise de vendas, pagamentos e produtos', raw(
          '<button type="button" class="btn" data-exp>' + I('download', 15) + ' Exportar CSV</button>' +
          '<button type="button" class="btn" data-print>' + I('printer', 15) + ' Imprimir</button>'))}
        <div class="toolbar">${C.periodSelect('r-period', d)}
          <span class="muted small">Relatórios respeitam as permissões do usuário logado.</span></div>
        <div class="kpi-grid">
          ${C.kpi({ lbl: 'Faturamento', val: U.money(sum.total), sub: 'no período selecionado', icon: 'dollar' })}
          ${C.kpi({ lbl: 'Vendas', val: String(sum.count), sub: sum.itens + ' itens vendidos', icon: 'receipt', tone: 'info' })}
          ${C.kpi({ lbl: 'Ticket médio', val: U.money(sum.avg), sub: 'por venda', icon: 'trending', tone: 'ok' })}
          ${C.kpi({ lbl: 'Reposição', val: String(low.length), sub: 'produtos abaixo do mínimo', icon: 'alert', tone: low.length ? 'danger' : 'ok' })}
        </div>
        <div class="grid-2w">
          ${C.panel('Evolução diária', days.length + ' dias', C.bars(days))}
          ${C.panel('Por forma de pagamento', null, C.donut(byPay))}
        </div>
        <div class="grid-2e">
          ${C.panel('Por operador', null, Object.keys(byOp).length
            ? raw(Object.keys(byOp).sort(function (a, b) { return byOp[b].t - byOp[a].t; }).map(function (k) {
              return frag(C.hbar(k, byOp[k].t, opMax, byOp[k].n + ' vendas · ' + U.money(byOp[k].t)));
            }).map(function (f) { return f.v; }).join(''))
            : html`<p class="muted small">Sem vendas no período.</p>`)}
          ${C.panel('Produtos mais vendidos', 'por quantidade', top.length
            ? html`<div class="table-wrap" style="border:none"><table class="table">
              <thead><tr><th>#</th><th>Produto</th><th class="num">Qtd</th><th class="num">Faturamento</th></tr></thead>
              <tbody>${top.map(function (t, i) {
                return html`<tr><td class="muted">${i + 1}º</td><td class="strong">${t.nome}</td><td class="num tabular">${U.num(t.q)}</td><td class="num tabular"><b>${U.money(t.f)}</b></td></tr>`;
              })}</tbody></table></div>`
            : C.empty('reports', 'Sem dados', 'Nenhum produto vendido no período.'))}
        </div>`);

      root.querySelector('#r-period').addEventListener('change', function () { self.filter.days = Number(this.value); self.fill(root); });
      root.querySelector('[data-exp]').addEventListener('click', function () { if (DataOps.exportCSV('vendas')) UI.toast('vendas.csv exportado ✔', { type: 'ok' }); });
      root.querySelector('[data-print]').addEventListener('click', function () {
        UI.modal({
          title: 'Relatório — ' + Store.state.tenant.nome,
          sub: 'Período: ' + (d >= 9999 ? 'todo' : 'últimos ' + d + ' dias') + ' · gerado em ' + U.dt(Date.now()),
          body: html`
            <ul class="mini-list">
              <li class="mini-row"><span>Faturamento</span><b>${U.money(sum.total)}</b></li>
              <li class="mini-row"><span>Nº de vendas</span><b>${sum.count}</b></li>
              <li class="mini-row"><span>Ticket médio</span><b>${U.money(sum.avg)}</b></li>
            </ul><hr class="divider">
            <h4 class="mb-3">Por forma de pagamento</h4>
            <ul class="mini-list">${Object.keys(byPay).map(function (k) { return html`<li class="mini-row"><span>${C.payLabel[k] || k}</span><b>${U.money(byPay[k])}</b></li>`; })}</ul>
            <hr class="divider">
            <h4 class="mb-3">Por operador</h4>
            <ul class="mini-list">${Object.keys(byOp).map(function (k) { return html`<li class="mini-row"><span>${k} (${byOp[k].n} vendas)</span><b>${U.money(byOp[k].t)}</b></li>`; })}</ul>
            <hr class="divider">
            <h4 class="mb-3">Top produtos</h4>
            <ul class="mini-list">${top.slice(0, 8).map(function (t, i) { return html`<li class="mini-row"><span>${i + 1}. ${t.nome}</span><b>${U.num(t.q)} · ${U.money(t.f)}</b></li>`; })}</ul>`,
          foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Fechar</button><button type="button" class="btn btn-primary" data-p>' + I('printer', 15) + ' Imprimir</button>'),
          onMount: function (panel) { panel.querySelector('[data-p]').addEventListener('click', function () { window.print(); }); }
        });
      });
    },
    onStoreChanged: function () { if (Router.current && Router.current.path === '/app/relatorios') this.fill(document.getElementById('page-root')); }
  };

  /* =================== ASSINATURA =================== */
  Pages.assinatura = {
    title: 'Assinatura',
    cycle: 'mensal',
    render: function () { return C.skeleton('kpis'); },
    mounted: function (root) {
      var self = this;
      this.rerender = function () { self.fill(document.getElementById('page-root')); };
      setTimeout(function () { self.fill(root); }, Config.latency ? 160 : 0);
    },
    fill: function (root) {
      var self = this;
      var info = Billing.statusInfo();
      var t = Store.state.tenant;
      var me = Auth.me() || {};
      var isDevAcc = me.papel === 'dev' || (info.plan && info.plan.id === 'dev');
      var canManage = Perms.can('billing.manage') || me.papel === 'admin' || isDevAcc;

      /* Conta DEV (equipe JR Sistemas): tudo liberado, sem cobrança */
      if (isDevAcc) {
        mount(root, html`
          ${C.pageHead('Assinatura', 'plano, cobranças e preferências')}
          <div class="sub-status ok">
            <span class="ss-ico">${raw(I('headset', 20))}</span>
            <span class="ss-body"><h3>Conta Dev · JR Sistemas — acesso ilimitado</h3>
              <p>Todos os recursos liberados, por tempo indeterminado e sem cobrança. Esta é a conta interna da equipe.</p></span>
          </div>
          <div class="grid-2e mt-4">
            ${C.panel('Como ativar planos para clientes', null, html`
              <ul class="mini-list">
                <li class="mini-row"><span class="mr-main"><span class="mr-name">1 · Cliente pede ativação</span><span class="mr-sub">com o teste vencido, ele vê “Pedir ativação” e abre um ticket de faturamento</span></span>${raw(I('mail', 18))}</li>
                <li class="mini-row"><span class="mr-main"><span class="mr-name">2 · Você atende no Suporte</span><span class="mr-sub">o ticket aparece no seu painel de atendimento (todas as empresas)</span></span>${raw(I('headset', 18))}</li>
                <li class="mini-row"><span class="mr-main"><span class="mr-name">3 · Ativa o plano no próprio ticket</span><span class="mr-sub">após confirmar o pagamento (Pix etc.), use “Ativar plano” na conversa — o cliente é liberado na hora, sem re-login</span></span>${raw(I('check', 18))}</li>
              </ul>
              <p class="small muted mt-3">Clientes também podem assinar sozinhos pelo checkout Asaas (Pix, cartão ou boleto) — a liberação é automática quando o pagamento é confirmado.</p>`)}
            ${C.panel('Sua conta', null, html`
              <ul class="mini-list">
                <li class="mini-row"><span class="mr-main"><span class="mr-name">Plano</span><span class="mr-sub">conta interna da equipe JR Sistemas</span></span><span class="badge badge-brand no-dot">Dev · ilimitado</span></li>
                <li class="mini-row"><span class="mr-main"><span class="mr-name">Cobrança</span><span class="mr-sub">isento — uso interno</span></span><b>—</b></li>
                <li class="mini-row"><span class="mr-main"><span class="mr-name">Recursos</span><span class="mr-sub">todas as páginas + painel de atendimento multiempresa</span></span>${raw(I('check-circle', 18))}</li>
              </ul>`)}
          </div>`);
        return;
      }

      var banner;
      if (info.status === 'trialing') {
        banner = html`<div class="sub-status">
          <span class="ss-ico">${raw(I('clock', 20))}</span>
          <span class="ss-body"><h3>Teste grátis — restam ${info.daysLeft} de 14 dias</h3>
            <p>Todos os recursos estão liberados. O teste é único e não renovável: ao terminar, o acesso fica suspenso (modo leitura) até ativar um plano.</p>
            <span class="trial-track"><span class="trial-fill" style="width:${info.usedPct}%"></span></span></span>
        </div>`;
      } else if (info.status === 'active') {
        /* plano pago com PRAZO (plan_expires_at): o cliente vê quando vence.
           Não existe mais "ativo para sempre" para contas pagas. */
        if (info.planExpiresAt) {
          var few = info.expiring; /* ≤5 dias */
          banner = html`<div class="sub-status ${few ? 'warn' : 'ok'}">
            <span class="ss-ico">${raw(I(few ? 'alert' : 'check-circle', 20))}</span>
            <span class="ss-body"><h3>Plano ${info.plan ? info.plan.name : ''} ativo · expira em ${info.daysLeft} ${info.daysLeft === 1 ? 'dia' : 'dias'} (${U.datetime(info.planExpiresAt)})</h3>
              <p>${few ? 'Seu plano vence em menos de uma semana. Renove para não perder o acesso ao PDV — pagamento confirmado, a equipe JR estende o prazo na hora.' : 'Ao vencer, o acesso entra em modo leitura até a renovação. Renove pelo checkout (Pix, cartão ou boleto) — a liberação é automática ao confirmar o pagamento.'}</p></span>
            ${canManage ? html`<span class="ss-act"><button type="button" class="btn btn-primary btn-sm" data-renew>${raw(I('zap', 14))} Renovar plano</button></span>` : ''}
          </div>`;
        } else {
          banner = html`<div class="sub-status ok">
            <span class="ss-ico">${raw(I('check-circle', 20))}</span>
            <span class="ss-body"><h3>Plano ${info.plan ? info.plan.name : ''} ativo · ${t.planCycle === 'anual' ? 'anual' : 'mensal'}</h3>
              <p>Próxima cobrança em ${U.date(info.nextCharge)} · ${U.money(info.plan ? (t.planCycle === 'anual' ? info.plan.annualTotal : info.plan.monthly) : 0)}</p></span>
            ${canManage ? html`<span class="ss-act"><button type="button" class="btn btn-danger-ghost btn-sm" data-cancel>Cancelar assinatura</button></span>` : ''}
          </div>`;
        }
      } else if (info.status === 'past_due') {
        banner = html`<div class="sub-status warn">
          <span class="ss-ico">${raw(I('alert', 20))}</span>
          <span class="ss-body"><h3>Pagamento pendente</h3>
            <p>Você está no período de carência (3 dias). Após isso, o PDV é bloqueado automaticamente em modo leitura.</p></span>
          ${canManage ? html`<span class="ss-act"><button type="button" class="btn btn-primary btn-sm" data-retry-pay>Regularizar agora</button></span>` : ''}
        </div>`;
      } else {
        banner = html`<div class="sub-status danger">
          <span class="ss-ico">${raw(I('lock', 20))}</span>
          <span class="ss-body"><h3>${info.expiredByPlan
              ? 'Plano ' + (info.plan ? info.plan.name : '') + ' expirou em ' + U.date(info.planExpiresAt) + ' — reative para voltar a vender'
              : 'Acesso suspenso — escolha um plano para voltar a vender'}</h3>
            <p>${info.expiredByPlan
              ? 'O prazo do seu plano terminou e o sistema entrou em modo leitura (relatórios e exportação continuam liberados — LGPD). Renove um plano abaixo: pague via Pix e peça a ativação pelo Suporte — a equipe JR estende o prazo em minutos.'
              : 'Modo leitura ativo: consulte relatórios e exporte seus dados (LGPD). Assine pelo checkout (Pix, cartão ou boleto) e o acesso volta automaticamente — ou peça ativação pelo Suporte.'}</p></span>
          ${canManage ? html`<span class="ss-act"><a class="btn btn-primary btn-sm" href="#/app/suporte?novoticket=1&amp;categoria=faturamento&amp;assunto=Renova%C3%A7%C3%A3o%20de%20plano">${raw(I('headset', 14))} Pedir ativação</a></span>` : ''}
        </div>`;
      }

      mount(root, html`
        ${C.pageHead('Assinatura', 'plano, cobranças e preferências')}
        ${banner}
        <div class="card mb-4" style="display:flex;justify-content:center;padding:14px">
          <span class="seg" role="group" aria-label="Ciclo de cobrança">
            <button type="button" class="seg-btn ${this.cycle === 'mensal' ? 'is-on' : ''}" data-cycle="mensal">Mensal</button>
            <button type="button" class="seg-btn ${this.cycle === 'anual' ? 'is-on' : ''}" data-cycle="anual">Anual <span class="seg-save">−17%</span></button>
          </span>
        </div>
        <div class="plans-grid">
          ${Billing.PLANS.map(function (pl) {
            var isCur = t.planId === pl.id && info.status === 'active';
            var price = self.cycle === 'anual' ? pl.annual : pl.monthly;
            return html`<article class="plan-card ${pl.hot ? 'featured' : ''}">
              ${pl.hot ? raw('<span class="plan-tag">Mais escolhido</span>') : ''}
              <header><h3>${pl.name}</h3><p class="plan-for">${pl.for}</p></header>
              <div class="plan-price"><span class="cur">R$</span><b>${price}</b><span class="per">/mês</span></div>
              ${self.cycle === 'anual' ? html`<p class="plan-annual-note">cobrado ${U.money(pl.annualTotal)}/ano</p>` : ''}
              <ul class="plan-feats">${pl.feat || ''}${pl.features.map(function (f) { return html`<li>${f}</li>`; })}</ul>
              ${isCur
                ? raw('<button class="btn btn-subtle btn-block" disabled>' + I('check-circle', 15) + ' Seu plano atual</button>')
                : (canManage
                  ? html`<button class="btn ${pl.hot ? 'btn-primary' : 'btn-outline'} btn-block" data-sub="${pl.id}">${info.status === 'read_only' || info.status === 'past_due' ? 'Reativar neste plano' : (t.planId ? 'Trocar para este' : 'Assinar agora')}</button>`
                  : raw('<button class="btn btn-outline btn-block" disabled>Somente o admin pode alterar</button>'))}
            </article>`;
          })}
        </div>
        <div class="grid-2e mt-4">
          ${C.panel('Histórico de cobranças', null, t.invoices.length
            ? html`<div class="table-wrap" style="border:none"><table class="table">
              <thead><tr><th>Data</th><th>Plano</th><th>Método</th><th class="num">Valor</th><th>Status</th></tr></thead>
              <tbody>${t.invoices.map(function (inv) {
                return html`<tr><td class="muted small nowrap">${U.date(inv.at)}</td><td class="strong">${inv.planName} <span class="muted small">(${inv.cycle})</span></td>
                  <td>${inv.metodo === 'pix' ? 'Pix Automático' : inv.metodo === 'cartao' ? 'Cartão •••• 4242' : 'Boleto'}</td>
                  <td class="num tabular"><b>${U.money(inv.valor)}</b></td>
                  <td><span class="badge badge-ok">${inv.status}</span></td></tr>`;
              })}</tbody></table></div>`
            : C.empty('billing', 'Nenhuma cobrança ainda', 'Você está no período de teste — a primeira cobrança só acontece quando escolher um plano.'))}
          ${C.panel('Pagamento e segurança', null, html`
            <ul class="mini-list">
              <li class="mini-row"><span class="mr-main"><span class="mr-name">Métodos aceitos</span><span class="mr-sub">Pix Automático · Cartão de crédito · Boleto</span></span>${raw(I('pix', 20))}</li>
              <li class="mini-row"><span class="mr-main"><span class="mr-name">Sem fidelidade</span><span class="mr-sub">Cancele quando quiser; modo leitura garante seus dados</span></span>${raw(I('shield', 20))}</li>
              <li class="mini-row"><span class="mr-main"><span class="mr-name">Cobrança via gateway</span><span class="mr-sub">Stripe/Asaas em produção — nesta demo, simulado</span></span>${raw(I('lock', 20))}</li>
            </ul>
            ${canManage && info.status === 'active' && Config.env === 'demo' ? html`<hr class="divider">
              <button type="button" class="btn btn-sm btn-ghost text-warn" data-sim-past>${raw(I('wifi-off', 14))} Demo: simular pagamento pendente</button>` : ''}`)}
        </div>`);

      root.querySelectorAll('[data-cycle]').forEach(function (b) {
        b.addEventListener('click', function () { self.cycle = b.dataset.cycle; self.fill(root); });
      });
      root.querySelectorAll('[data-sub]').forEach(function (b) { b.addEventListener('click', function () { self.checkout(b.dataset.sub); }); });
      var rn = root.querySelector('[data-renew]'); if (rn) rn.addEventListener('click', function () { self.checkout(t.planId || 'profissional'); });
      var rc = root.querySelector('[data-retry-pay]'); if (rc) rc.addEventListener('click', function () { self.checkout(t.planId || 'profissional'); });
      var cc = root.querySelector('[data-cancel]'); if (cc) cc.addEventListener('click', function () { self.askCancel(); });
      var sp = root.querySelector('[data-sim-past]');
      if (sp) sp.addEventListener('click', function () { Billing.simulatePastDue().then(function () { UI.toast('Status alterado para “pagamento pendente” (simulação).', { type: 'warn' }); self.rerender(); }); });
    },
    checkout: function (planId) {
      var self = this;
      var pl = Billing.planById(planId);
      var valor = this.cycle === 'anual' ? pl.annualTotal : pl.monthly;
      UI.modal({
        title: 'Pagamento — Plano ' + pl.name, sub: (this.cycle === 'anual' ? 'Anual' : 'Mensal') + ' · ' + U.money(valor) + (this.cycle === 'anual' ? '/ano' : '/mês'),
        body: html`
          <div class="pay-method-pick" role="radiogroup" aria-label="Forma de pagamento">
            <label class="pm-opt sel"><input type="radio" name="pm" value="pix" checked><span class="pm-ico">${raw(I('pix', 18))}</span>
              <span><b>Pix</b><span>QR Code a cada vencimento — confirmação em segundos e liberação automática.</span></span><span class="pm-rec">Recomendado</span></label>
            <label class="pm-opt"><input type="radio" name="pm" value="cartao"><span class="pm-ico">${raw(I('billing', 18))}</span>
              <span><b>Cartão de crédito</b><span>Recorrência com tentativa automática em caso de falha.</span></span></label>
            <label class="pm-opt"><input type="radio" name="pm" value="boleto"><span class="pm-ico">${raw(I('receipt', 18))}</span>
              <span><b>Boleto mensal</b><span>Enviado por e-mail e WhatsApp todo mês.</span></span></label>
          </div>
          ${Config.env === 'production'
            ? html`<div class="auth-note mt-3">${raw(I('info', 15))}<span>Pagamento processado pelo <b>Asaas</b> em ambiente seguro. Você será levado à fatura; o plano é liberado automaticamente assim que o pagamento for confirmado. O CNPJ/CPF da loja (Configurações → Loja) é exigido para emitir a cobrança.</span></div>`
            : Config.env === 'demo'
              ? html`<div class="auth-note mt-3">${raw(I('info', 15))}<span>Ambiente de demonstração: <b>nenhuma cobrança real</b> é feita. Em produção, este fluxo usa o Asaas com webhooks de confirmação.</span></div>`
              : html`<div class="auth-note mt-3">${raw(I('info', 15))}<span>Gateway de cobrança ainda não conectado: a ativação é processada pelo motor interno de webhooks e registrada no histórico.</span></div>`}`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Voltar</button>' +
          '<button type="button" class="btn btn-primary" data-pay>' + I('lock', 15) + ' Pagar ' + U.money(valor) + ' e ativar</button>'),
        onMount: function (panel, close) {
          panel.querySelectorAll('.pm-opt').forEach(function (opt) {
            opt.addEventListener('click', function () {
              panel.querySelectorAll('.pm-opt').forEach(function (o) { o.classList.remove('sel'); });
              opt.classList.add('sel'); opt.querySelector('input').checked = true;
            });
          });
          panel.querySelector('[data-pay]').addEventListener('click', function () {
            var btn = this;
            var metodo = (panel.querySelector('input[name="pm"]:checked') || {}).value || 'pix';
            UI.busy(btn, true);
            if (Config.env === 'production') {
              Billing.startCheckout(planId, self.cycle, metodo).then(function (r) {
                UI.busy(btn, false);
                if (r && r.url) { close('ok'); UI.toast('Abrindo checkout seguro do gateway…', { type: 'info' }); window.location.href = r.url; }
              }).catch(function (e) { UI.busy(btn, false); UI.toast(e.message || 'Não foi possível iniciar o checkout.', { type: 'err' }); });
              return;
            }
            setTimeout(function () {
              Billing.subscribe(planId, self.cycle, metodo).then(function () {
                UI.busy(btn, false); close('ok');
                UI.toast('🎉 Assinatura ativa! Bem-vindo ao plano ' + pl.name + '.', { type: 'ok', timeout: 5200 });
                self.rerender();
              }).catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err' }); });
            }, Config.latency ? 900 : 0);
          });
        }
      });
    },
    askCancel: function () {
      var self = this;
      UI.modal({
        title: 'Cancelar assinatura?', size: 'sm',
        body: html`<p class="small" style="color:var(--ink-2);line-height:1.65">Ao cancelar, o PDV é bloqueado imediatamente (modo leitura). Você mantém acesso a relatórios e pode <b>exportar todos os seus dados por 30 dias</b>, conforme a LGPD. Sentiremos sua falta 💔</p>
          <div class="field mt-3"><label for="cn-mot">Motivo do cancelamento</label><select class="select" id="cn-mot">
            <option>Preço</option><option>Falta de uso</option><option>Senti falta de alguma função</option><option>Problemas técnicos</option><option>Outro</option></select></div>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Manter assinatura</button><button type="button" class="btn btn-danger" data-ok>Cancelar assim mesmo</button>'),
        onMount: function (panel, close) {
          panel.querySelector('[data-ok]').addEventListener('click', function () {
            Billing.cancel(panel.querySelector('#cn-mot').value).then(function () {
              close('ok'); UI.toast('Assinatura cancelada. Veja o bloqueio do PDV em ação.', { type: 'warn', timeout: 5200 });
              self.rerender();
            });
          });
        }
      });
    },
    onStoreChanged: function () { }
  };

  /* =================== CONFIGURAÇÕES =================== */
  Pages.config = {
    title: 'Configurações',
    tab: 'loja',
    render: function () { return C.skeleton('table'); },
    mounted: function (root, params, query) {
      var self = this;
      if (query && query.tab && ['loja', 'regras', 'equipe', 'conta', 'dados', 'admin', 'integracoes', 'emails'].indexOf(query.tab) > -1) this.tab = query.tab;
      this.rerender = function () { self.fill(document.getElementById('page-root')); };
      setTimeout(function () { self.fill(root); }, Config.latency ? 150 : 0);
    },
    fill: function (root) {
      var self = this;
      var t = Store.state.tenant, cfg = Store.state.config, user = Auth.me();
      var isAdmin = user && user.papel === 'admin';
      var isDev = user && user.papel === 'dev';
      /* v8 · "Ações do admin": trilha GLOBAL (todas as empresas) — somente dev */
      var TABS = [['loja', 'Loja'], ['regras', 'Regras'], ['equipe', 'Equipe'], ['conta', 'Conta & senha'], ['dados', 'Dados & auditoria'], ['integracoes', 'Integrações']]
        .concat(isDev ? [['admin', 'Ações do admin']] : [])
        .concat(Config.env !== 'production' ? [['emails', 'Emails (dev)']] : []);

      mount(root, html`
        ${C.pageHead('Configurações', 'preferências da loja, equipe e dados')}
        <div class="tabs" role="tablist">${TABS.map(function (tb) {
          return html`<button type="button" class="tab ${self.tab === tb[0] ? 'active' : ''}" role="tab" aria-selected="${self.tab === tb[0]}" data-tab="${tb[0]}">${tb[1]}</button>`;
        })}</div>
        <div id="cfg-body">${this['tab_' + this.tab](t, cfg, user, isAdmin)}</div>`);

      root.querySelectorAll('[data-tab]').forEach(function (b) {
        b.addEventListener('click', function () { self.tab = b.dataset.tab; self.fill(root); });
      });
      this['bind_' + this.tab] && this['bind_' + this.tab](root);
    },
    tab_loja: function (t) {
      return html`<div class="grid-2e">
        <form class="panel" id="form-loja" novalidate>
          <div class="panel-head"><h3>Dados da loja</h3></div>
          <div class="field"><label for="cf-nome">Nome da loja <span class="req">*</span></label><input class="input" id="cf-nome" name="nome" value="${t.nome}"></div>
          <div class="field-row">
            <div class="field"><label for="cf-cnpj">CNPJ</label><input class="input mono" id="cf-cnpj" name="cnpj" value="${t.cnpj}" placeholder="00.000.000/0001-00"></div>
            <div class="field"><label for="cf-tel">Telefone</label><input class="input" id="cf-tel" name="telefone" value="${t.telefone}" placeholder="(11) 3000-0000"></div>
          </div>
          <div class="field"><label for="cf-end">Endereço <span class="muted" style="font-weight:400">(vai no comprovante)</span></label><input class="input" id="cf-end" name="endereco" value="${t.endereco}"></div>
          <div class="field"><label for="cf-msg">Mensagem do comprovante</label><input class="input" id="cf-msg" name="reciboMsg" value="${Store.state.config.reciboMsg}" maxlength="120"></div>
          <button class="btn btn-primary" type="submit">${raw(I('save', 15))} Salvar alterações</button>
        </form>
        <div class="panel">
          <div class="panel-head"><h3>Resumo da conta</h3></div>
          <ul class="mini-list">
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Status</span></span>${C.subBadge(Billing.statusInfo())}</li>
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Conta criada em</span><span class="mr-sub">${t.planId === 'dev' ? 'conta interna da equipe JR Sistemas' : 'trial iniciou ' + U.date(t.trialEndsAt ? new Date(t.trialEndsAt).getTime() - 14 * 864e5 : Date.now())}</span></span>${raw(I('calendar', 18))}</li>
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Produtos / vendas / usuários</span></span><b>${Store.state.products.length} · ${Store.state.sales.length} · ${Store.state.users.length}</b></li>
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Armazenamento</span><span class="mr-sub">${SafeStorage.persistent ? 'localStorage deste navegador · ~' + Math.round(JSON.stringify(Store.state).length / 1024) + ' KB' : 'somente memória (storage bloqueado)'}</span></span>${raw(I('database', 18))}</li>
          </ul>
        </div>
      </div>`;
    },
    bind_loja: function (root) {
      root.querySelector('#form-loja').addEventListener('submit', function (e) {
        e.preventDefault();
        var form = this;
        var res = Validate.run(form, { nome: [['required'], ['min', 2]], cnpj: [['cnpjOpcional']] });
        Validate.paint(form, res.errors);
        if (!res.ok) { UI.toast('Corrija os campos destacados.', { type: 'err' }); return; }
        /* campos fora do schema de validação também precisam ir — sem isso, edits de
           endereço/telefone/mensagem do comprovante eram silenciosamente descartados */
        Object.assign(res.values, {
          endereco: form.elements.endereco.value.trim(),
          telefone: form.elements.telefone.value.trim(),
          reciboMsg: form.elements.reciboMsg.value.slice(0, 120)
        });
        var btn = form.querySelector('button[type=submit]'); UI.busy(btn, true);
        ApiClient.request('tenant.update', Object.assign({}, res.values, {
          descontoCaixaPct: Store.state.config.descontoCaixaPct,
          permiteEstoqueNegativo: Store.state.config.permiteEstoqueNegativo
        })).then(function () {
          Store.update(function () { });
          UI.busy(btn, false);
          UI.toast('Dados da loja salvos ✔', { type: 'ok' });
          Bus.emit('shell:refresh');
        }).catch(function (err) { UI.busy(btn, false); UI.toast(err.message, { type: 'err' }); });
      });
    },
    tab_regras: function (t, cfg) {
      return html`<div class="grid-2e">
        <form class="panel" id="form-regras">
          <div class="panel-head"><h3>Regras de operação</h3></div>
          <div class="field"><label for="rg-desc">Desconto máximo do caixa (%)</label>
            <input class="input input-money" id="rg-desc" name="descontoCaixaPct" type="text" inputmode="numeric" value="${cfg.descontoCaixaPct}">
            <p class="field-hint">Acima disso, o caixa precisa de autorização de gerente/admin no PDV.</p></div>
          <div class="field"><label class="switch"><input type="checkbox" id="rg-neg" name="permiteEstoqueNegativo" ${cfg.permiteEstoqueNegativo ? raw('checked') : ''}><span class="track"></span>
            Permitir venda com estoque negativo</label>
            <p class="field-hint">Alguns depósitos vendem antes de dar entrada na nota. Desligado = venda bloqueada quando o saldo não cobre.</p></div>
          <button class="btn btn-primary" type="submit">${raw(I('save', 15))} Salvar regras</button>
        </form>
        <div class="panel">
          <div class="panel-head"><h3>Como funciona na prática</h3></div>
          <ul class="mini-list">
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Limite de desconto</span><span class="mr-sub">Aplicado por venda, validado também no servidor</span></span><b>${cfg.descontoCaixaPct}%</b></li>
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Estoque negativo</span><span class="mr-sub">Bloqueio padrão protege contra furos</span></span>${cfg.permiteEstoqueNegativo ? raw('<span class="badge badge-warn">permitido</span>') : raw('<span class="badge badge-ok">bloqueado</span>')}</li>
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Cancelamento de venda</span><span class="mr-sub">Exclusivo de admin, com motivo e devolução de estoque</span></span>${raw(I('shield', 18))}</li>
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Trilha de auditoria</span><span class="mr-sub">Toda ação crítica fica registrada</span></span>${raw(I('eye', 18))}</li>
          </ul>
        </div>
      </div>`;
    },
    bind_regras: function (root) {
      root.querySelector('#form-regras').addEventListener('submit', function (e) {
        e.preventDefault();
        var form = this, btn = form.querySelector('button[type=submit]');
        var pct = U.parseNum(form.elements.descontoCaixaPct.value);
        if (!isFinite(pct) || pct < 0 || pct > 100) { UI.toast('Desconto deve ser um número entre 0 e 100.', { type: 'err' }); return; }
        UI.busy(btn, true);
        ApiClient.request('tenant.update', { descontoCaixaPct: Math.round(pct), permiteEstoqueNegativo: form.elements.permiteEstoqueNegativo.checked })
          .then(function () {
            Store.update(function () { }); UI.busy(btn, false);
            UI.toast('Regras salvas ✔', { type: 'ok' });
            Pages.config.fill(document.getElementById('page-root'));
          }).catch(function (err) { UI.busy(btn, false); UI.toast(err.message, { type: 'err' }); });
      });
    },
    tab_equipe: function (t, cfg, user, isAdmin) {
      return html`<div>
        <div class="panel">
        <div class="panel-head"><h3>Equipe (${Store.state.users.length})</h3>
          ${isAdmin ? raw('<button type="button" class="btn btn-primary btn-sm" data-invite>' + I('plus', 14) + ' Convidar usuário</button>') : ''}</div>
        <div class="table-wrap" style="border:none"><table class="table">
          <thead><tr><th>Usuário</th><th>Papel</th><th>Status</th><th>Criado em</th>${isAdmin ? html`<th style="width:190px">Ações</th>` : ''}</tr></thead>
          <tbody>${Store.state.users.map(function (u) {
            return html`<tr class="${u.ativo ? '' : 'row-off'}">
              <td><span class="flex items-center gap-2"><span class="avatar sm ${u.papel === 'admin' ? '' : 'gray'}">${U.initials(u.nome)}</span>
                <span><b>${u.nome}</b>${u.id === user.id ? raw(' <span class="badge badge-brand no-dot">você</span>') : ''}<br><span class="small muted">${u.email}</span></span></span></td>
              <td>${isAdmin && u.id !== user.id
                ? html`<select class="select" data-role="${u.id}" style="width:auto;padding:5px 30px 5px 10px;font-size:.8rem" aria-label="Papel de ${u.nome}">
                    <option value="admin" ${u.papel === 'admin' ? raw('selected') : ''}>admin</option>
                    <option value="gerente" ${u.papel === 'gerente' ? raw('selected') : ''}>gerente</option>
                    <option value="caixa" ${u.papel === 'caixa' ? raw('selected') : ''}>caixa</option></select>`
                : html`<span class="badge badge-info">${u.papel}</span>`}</td>
              <td>${u.ativo ? raw('<span class="badge badge-ok">ativo</span>') : raw('<span class="badge badge-mut">inativo</span>')}${u.convidado ? raw(' <span class="badge badge-warn">convite pendente</span>') : ''}</td>
              <td class="muted small nowrap">${U.date(u.createdAt)}</td>
              ${isAdmin ? html`<td class="right nowrap">
                ${u.id !== user.id ? html`<button type="button" class="btn btn-sm ${u.ativo ? 'btn-ghost' : 'btn-subtle'}" data-act-user="${u.id}">${u.ativo ? 'Desativar' : 'Reativar'}</button>` : html`<span class="muted small">—</span>`}
              </td>` : ''}</tr>`;
          })}</tbody></table></div>
        <p class="field-hint mt-3">Papéis: <b>admin</b> acessa tudo e cancela vendas · <b>gerente</b> vê relatórios, custos e estoque · <b>caixa</b> opera o PDV com desconto limitado.</p>
        </div>
        <div id="invites-box"></div>
      </div>`;
    },
    bind_equipe: function (root) {
      var self = this;
      var inv = root.querySelector('[data-invite]');
      if (inv) inv.addEventListener('click', function () { self.inviteModal(); });
      /* convites pendentes (produção: e-mail real; demo: criados na hora) */
      var invList = root.querySelector('#invites-box');
      if (invList && ApiClient.request) {
        ApiClient.request('users.invites').then(function (list) {
          if (!list || !list.length) { invList.remove(); return; }
          mount(invList, html`
            <div class="panel mt-4">
              <div class="panel-head"><h3>Convites pendentes</h3><span class="panel-sub">aguardando aceitar o e-mail</span></div>
              <div class="table-wrap" style="border:none"><table class="table">
                <thead><tr><th>Convidado</th><th>E-mail</th><th>Papel</th><th>Enviado em</th><th></th></tr></thead>
                <tbody>${list.map(function (i) {
                  return html`<tr><td><b>${i.nome || '—'}</b></td><td class="small">${i.email}</td>
                    <td><span class="badge badge-info">${i.papel}</span></td>
                    <td class="muted small">${U.date(i.created_at ? new Date(i.created_at).getTime() : Date.now())}</td>
                    <td class="right"><button type="button" class="btn btn-sm btn-ghost" data-uninvite="${i.id}">Cancelar</button></td></tr>`;
                })}</tbody></table></div>
            </div>`);
          invList.querySelectorAll('[data-uninvite]').forEach(function (b) {
            b.addEventListener('click', function () {
              ApiClient.request('users.uninvite', { id: b.dataset.uninvite }).then(function () {
                UI.toast('Convite cancelado.', { type: 'warn' });
                self.rerender();
              }).catch(function (e) { UI.toast(e.message, { type: 'err' }); });
            });
          });
        }).catch(function () { if (invList) invList.remove(); });
      }
      root.querySelectorAll('[data-role]').forEach(function (sel) {
        sel.addEventListener('change', function () {
          ApiClient.request('users.update', { id: sel.dataset.role, papel: sel.value })
            .then(function () { Store.update(function () { }); UI.toast('Papel atualizado ✔', { type: 'ok' }); self.rerender(); })
            .catch(function (e) { UI.toast(e.message, { type: 'err' }); self.rerender(); });
        });
      });
      root.querySelectorAll('[data-act-user]').forEach(function (b) {
        b.addEventListener('click', function () {
          var u = Store.state.users.filter(function (x) { return x.id === b.dataset.actUser; })[0];
          ApiClient.request('users.update', { id: u.id, ativo: !u.ativo })
            .then(function () { Store.update(function () { }); UI.toast(u.ativo ? 'Usuário reativado ✔' : 'Usuário desativado.', { type: u.ativo ? 'ok' : 'warn' }); self.rerender(); })
            .catch(function (e) { UI.toast(e.message, { type: 'err' }); self.rerender(); });
        });
      });
    },
    inviteModal: function () {
      var self = this;
      UI.modal({
        title: 'Convidar usuário', size: 'sm',
        body: html`<form id="inv-form" novalidate>
          <div class="field"><label for="iv-nome">Nome <span class="req">*</span></label><input class="input" id="iv-nome" name="nome" data-autofocus></div>
          <div class="field"><label for="iv-email">E-mail <span class="req">*</span></label><input class="input" id="iv-email" name="email" type="email" placeholder="joao@loja.com.br"></div>
          <div class="field"><label for="iv-papel">Papel</label><select class="select" id="iv-papel" name="papel"><option value="caixa">caixa</option><option value="gerente">gerente</option><option value="admin">admin</option></select></div>
          <p class="field-hint">${Config.env === 'production' ? 'A pessoa recebe um e-mail de convite com link para definir a senha e entra direto na equipe da sua loja. Válido por 7 dias.' : 'Na demonstração, o convite cria o usuário na hora (senha provisória: convite123).'}</p>
        </form>`,
        foot: raw('<button type="button" class="btn btn-ghost" data-modal-close>Cancelar</button><button type="button" class="btn btn-primary" data-ok>' + I('mail', 15) + ' Enviar convite</button>'),
        onMount: function (panel, close) {
          panel.querySelector('[data-ok]').addEventListener('click', function () {
            var form = panel.querySelector('#inv-form');
            var res = Validate.run(form, { nome: [['required'], ['min', 2]], email: [['required'], ['email']] });
            Validate.paint(form, res.errors);
            if (!res.ok) return;
            res.values.papel = form.elements.papel.value; /* sem isto todo convite virava "caixa" */
            var btn = this; UI.busy(btn, true);
            ApiClient.request('users.invite', res.values).then(function () {
              Store.update(function () { }); UI.busy(btn, false); close('ok');
              UI.toast(Config.env === 'production'
                ? 'Convite enviado para ' + res.values.email + ' ✉️ A pessoa define a senha pelo link do e-mail.'
                : 'Convite enviado para ' + res.values.email + ' (simulado) ✉️', { type: 'ok', timeout: 5200 });
              self.rerender();
            }).catch(function (e) { UI.busy(btn, false); UI.toast(e.message, { type: 'err' }); });
          });
        }
      });
    },
    tab_dados: function (t, cfg, user, isAdmin) {
      return html`
        <div class="grid-2e">
          <div class="panel">
            <div class="panel-head"><h3>Seus dados (LGPD)</h3></div>
            <p class="small muted mb-3">Exporte ou apague tudo quando quiser — os dados são seus.</p>
            <div class="flex gap-2" style="flex-wrap:wrap">
              <button type="button" class="btn" data-exp="json">${raw(I('database', 15))} Exportar tudo (JSON)</button>
              <button type="button" class="btn" data-exp="produtos">${raw(I('package', 15))} Produtos (CSV)</button>
              <button type="button" class="btn" data-exp="vendas">${raw(I('receipt', 15))} Vendas (CSV)</button>
              <button type="button" class="btn" data-exp="movimentacoes">${raw(I('layers', 15))} Movimentações (CSV)</button>
            </div>
            ${isAdmin ? html`<hr class="divider">
            <div class="danger-zone">
              <h3>Zona de perigo</h3>
              <p>Ações de demonstração que afetam todos os dados deste navegador.</p>
              <div class="flex gap-2" style="flex-wrap:wrap">
                <button type="button" class="btn btn-sm btn-danger" data-wipe>${raw(I('trash', 14))} Apagar meus dados (loja vazia)</button>
                <button type="button" class="btn btn-sm btn-outline" data-reset>${raw(I('refresh', 14))} Restaurar dados de demonstração</button>
              </div>
            </div>` : ''}
          </div>
          <div class="panel">
            <div class="panel-head"><h3>Simulação de infraestrutura</h3><span class="panel-sub">testes de robustez</span></div>
            ${Config.env === 'demo' ? html`
            <label class="switch mb-3"><input type="checkbox" id="sim-fail" ${Config.simulateFailures ? raw('checked') : ''}><span class="track"></span>
              Simular falha de conexão nas páginas</label>
            <p class="field-hint">Liga o modo de erro: cada página mostra estado de falha com botão “Tentar novamente” — como um sistema real sem internet.</p>
            <hr class="divider">
            <label class="switch"><input type="checkbox" id="sim-latency" ${Config.latency > 0 ? raw('checked') : ''}><span class="track"></span>
              Latência de rede simulada (${Config.latency} ms)</label>
            <p class="field-hint">Desligue para navegação instantânea (útil em telas de balcão).</p>`
            : html`<p class="small muted">Controles de simulação de infraestrutura existem apenas no modo demo/homologação.</p>`}
          </div>
        </div>
        <div class="panel mt-4">
          <div class="panel-head"><h3>Trilha de auditoria</h3><span class="panel-sub">ações críticas da sua empresa</span></div>
          <div id="audit-own"><p class="muted small">Carregando…</p></div>
        </div>`;
    },
    bind_dados: function (root) {
      /* v8 · trilha REAL do próprio tenant (produção: audit_logs do banco;
         demo: lista local) — antes esta aba ficava vazia em produção */
      var own = root.querySelector('#audit-own');
      if (own) {
        var paintOwn = function (rows) {
          own.innerHTML = (rows && rows.length)
            ? '<div class="table-wrap" style="border:none;max-height:340px;overflow-y:auto"><table class="table"><thead><tr><th>Data/hora</th><th>Usuário</th><th>Ação</th><th>Detalhes</th></tr></thead><tbody>' +
              rows.map(function (a) {
                return '<tr><td class="muted small nowrap">' + U.dt(a.at) + '</td><td>' + U.esc(a.userName || '—') + '</td>' +
                  '<td><span class="badge badge-info no-dot mono">' + U.esc(a.acao) + '</span></td>' +
                  '<td class="muted small">' + U.esc(a.detalhes || '') + '</td></tr>';
              }).join('') + '</tbody></table></div>'
            : '<p class="muted small">Nenhuma ação registrada ainda.</p>';
        };
        ApiClient.request('audit.list', { limit: 60 }).then(paintOwn).catch(function () {
          paintOwn(Audit.list(60));
        });
      }
      root.querySelectorAll('[data-exp]').forEach(function (b) {
        b.addEventListener('click', function () {
          var k = b.dataset.exp;
          var okk = k === 'json' ? DataOps.exportJSON() : DataOps.exportCSV(k);
          UI.toast(okk ? 'Exportação concluída ✔' : 'Exportação indisponível neste ambiente.', { type: okk ? 'ok' : 'warn' });
        });
      });
      var w = root.querySelector('[data-wipe]');
      if (w) w.addEventListener('click', function () {
        UI.confirm({ title: 'Apagar TODOS os dados?', text: 'Produtos, vendas e movimentações desta loja serão removidos deste navegador. A conta continua ativa, mas vazia. Esta ação não pode ser desfeita.', danger: true, okText: 'Apagar tudo' })
          .then(function (r) { if (r) { DataOps.clearData(); UI.toast('Dados apagados. Loja zerada.', { type: 'warn' }); Bus.emit('shell:refresh'); Router.resolve(); } });
      });
      var rs = root.querySelector('[data-reset]');
      if (rs) rs.addEventListener('click', function () {
        UI.confirm({ title: 'Restaurar demonstração?', text: 'Substitui os dados atuais pelo conjunto de demonstração completo (Depósito São José, 16 produtos, 20 vendas).', danger: false, okText: 'Restaurar demo' })
          .then(function (r) { if (r) { DataOps.resetDemo(); UI.toast('Dados de demonstração restaurados ✔', { type: 'ok' }); Bus.emit('shell:refresh'); Router.resolve(); } });
      });
      var sf = root.querySelector('#sim-fail');
      if (sf) sf.addEventListener('change', function () {
        Config.simulateFailures = sf.checked;
        UI.toast(sf.checked ? 'Falhas de conexão simuladas: LIGADAS — navegue pelas páginas.' : 'Simulação de falhas desligada.', { type: 'info' });
      });
      var sl = root.querySelector('#sim-latency');
      if (sl) sl.addEventListener('change', function () {
        Config.latency = sl.checked ? 110 : 0;
        UI.toast('Latência simulada: ' + Config.latency + ' ms.', { type: 'info' });
      });
    },
    tab_conta: function () { return AccountViews.panel(); },

    /* ============ v8 · AÇÕES DO ADMIN (somente dev) ============
       Trilha GLOBAL com todas as escritas sensíveis de TODAS as empresas —
       ativações/suspensões de plano (Edge), transições por SQL/cron (trigger
       v8 com antes→depois), mudanças de papel e conta. RPC admin_audit_list
       valida o papel dev no banco; o usuário comum nem vê a aba. */
    tab_admin: function () {
      return html`
        <div class="panel">
          <div class="panel-head"><h3>Últimas ações do admin</h3><span class="panel-sub">trilha global · todas as empresas</span></div>
          <div id="audit-admin"><p class="muted small">Carregando…</p></div>
        </div>
        <div class="panel mt-4">
          <div class="panel-head"><h3>O que fica registrado</h3></div>
          <ul class="mini-list">
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Cobrança (plano/prazo/status)</span><span class="mr-sub">toda escrita — via app, Edge Function, pg_cron ou SQL, com antes→depois</span></span>${raw(I('billing', 18))}</li>
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Papéis de usuários</span><span class="mr-sub">promoções/rebaixamentos e ativações de conta</span></span>${raw(I('users', 18))}</li>
            <li class="mini-row"><span class="mr-main"><span class="mr-name">Vendas, estoque e tickets</span><span class="mr-sub">eventos operacionais por empresa</span></span>${raw(I('receipt', 18))}</li>
          </ul>
        </div>`;
    },
    bind_admin: function (root) {
      var box = root.querySelector('#audit-admin');
      if (!box) return;
      ApiClient.request('audit.admin', { limit: 100 }).then(function (rows) {
        box.innerHTML = (rows && rows.length)
          ? '<div class="table-wrap" style="border:none;max-height:520px;overflow-y:auto"><table class="table"><thead><tr><th>Data/hora</th><th>Empresa</th><th>Quem</th><th>Ação</th><th>Detalhes</th></tr></thead><tbody>' +
            rows.map(function (a) {
              return '<tr><td class="muted small nowrap">' + U.dt(a.at) + '</td><td><b>' + U.esc(a.tenantName || '—') + '</b></td>' +
                '<td>' + U.esc(a.userName || '—') + '</td>' +
                '<td><span class="badge badge-info no-dot mono">' + U.esc(a.acao) + '</span></td>' +
                '<td class="muted small">' + U.esc(a.detalhes || '') + '</td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<p class="muted small">Nenhuma ação registrada ainda.</p>';
      }).catch(function (e) {
        box.innerHTML = '<p class="muted small">Não foi possível carregar a trilha: ' + U.esc(e.message) + '</p>';
      });
    },
    bind_conta: function (root) {
      AccountViews.rerender = function () { Pages.config.fill(document.getElementById('page-root')); };
      AccountViews.bindPanel(root);
    },
    tab_emails: function () { return AccountViews.outbox(); },
    bind_emails: function (root) { AccountViews.bindOutbox(root); },
    tab_integracoes: function () {
      return html`
        <div class="panel mb-4">
          <div class="panel-head"><h3>Pontos de integração</h3><span class="panel-sub">arquitetura pronta para produção</span></div>
          <p class="small muted mb-3">Toda comunicação de dados passa por <span class="mono">ApiClient → adapter</span>. Trocar o mock por Supabase/Stripe não altera nenhuma tela. Detalhes técnicos em <span class="mono">INTEGRATIONS.md</span>.</p>
          <div class="int-grid">
            ${Config.integrations.map(function (ig) {
              return html`<div class="int-item"><span class="int-dot ${ig.status === 'ready' ? 'on' : ig.status === 'soon' ? 'soon' : ''}"></span>
                <span><b>${ig.name}</b><span>${ig.desc}</span>
                <span class="badge ${ig.status === 'ready' ? 'badge-ok' : 'badge-warn'} no-dot mt-2">${ig.status === 'ready' ? 'pronto p/ conectar' : 'fase 2'}</span></span></div>`;
            })}
          </div>
        </div>
        <div class="grid-2e">
          <div class="panel">
            <div class="panel-head"><h3>Provedores ativos</h3></div>
            <ul class="mini-list">
              ${Object.keys(Config.providers).map(function (k) {
                return html`<li class="mini-row"><span class="mr-main"><span class="mr-name">${k}</span></span><span class="badge badge-mut no-dot">${Config.providers[k]}</span></li>`;
              })}
            </ul>
          </div>
          <div class="panel">
            <div class="panel-head"><h3>API</h3></div>
            <ul class="mini-list">
              <li class="mini-row"><span class="mr-main"><span class="mr-name">baseUrl</span><span class="mr-sub">definida via variável de ambiente em produção</span></span><span class="mono small muted">${Config.api.baseUrl || '(não configurada)'}</span></li>
              <li class="mini-row"><span class="mr-main"><span class="mr-name">anonKey</span><span class="mr-sub">segredos nunca ficam no frontend</span></span><span class="mono small muted">${Config.api.anonKey ? '••••••' : '(não configurada)'}</span></li>
              <li class="mini-row"><span class="mr-main"><span class="mr-name">Modo</span></span><span class="badge badge-brand no-dot">${Config.env} · v${Config.version}</span></li>
            </ul>
          </div>
        </div>`;
    },
    onStoreChanged: function () { }
  };

  /* =================== AUTH VIEWS =================== */
  function authLogo() {
    return raw('<a class="brand" href="#/" style="pointer-events:auto"><svg class="brand-mark" viewBox="0 0 32 32" width="34" height="34" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0B1220"/><path d="M10 12h12l-1.1 11a2 2 0 0 1-2 1.8h-7.8a2 2 0 0 1-2-1.8L10 12z" fill="#EA580C"/><path d="M13 12v-2a3 3 0 0 1 6 0v2" stroke="#FDBA74" stroke-width="2" fill="none" stroke-linecap="round"/><path d="m12.6 18.4 2.3 2.3 4.5-4.9" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="brand-name">Loja<b>Certa</b></span></a>');
  }

  AuthViews.signup = {
    title: 'Criar conta',
    render: function () {
      return html`<div class="auth-wrap"><div class="auth-card">
        <div class="auth-logo">${authLogo()}</div>
        <h1>Crie sua conta grátis</h1>
        <p class="auth-sub">14 dias completos · sem cartão · cancele quando quiser</p>
        ${Config.env === 'demo' ? html`<div class="auth-note">${raw(I('info', 15))}<span>Demonstração: os dados ficam salvos <b>apenas neste navegador</b> (localStorage). Nada é enviado a servidores.</span></div>` : ''}
        <form id="signup-form" novalidate>
          <div class="field"><label for="sg-loja">Nome da loja <span class="req">*</span></label>
            <input class="input" id="sg-loja" name="storeName" placeholder="Depósito São José" autocomplete="organization" data-autofocus></div>
          <div class="field"><label for="sg-seg">Segmento do negócio</label>
            <select class="select" id="sg-seg" name="segment">${Object.keys(SEGMENTS).map(function (k) { return html`<option value="${k}">${SEGMENTS[k].label}</option>`; })}</select>
            <p class="field-hint">Preparamos categorias padrão e unidades de medida ideais para o seu segmento — tudo editável depois.</p></div>
          <div class="field"><label for="sg-nome">Seu nome <span class="req">*</span></label>
            <input class="input" id="sg-nome" name="name" placeholder="Maria Souza" autocomplete="name"></div>
          <div class="field"><label for="sg-email">E-mail <span class="req">*</span></label>
            <input class="input" id="sg-email" name="email" type="email" placeholder="maria@depositosaojose.com.br" autocomplete="email"></div>
          <div class="field"><label for="sg-senha">Senha <span class="req">*</span></label>
            <input class="input" id="sg-senha" name="password" type="password" placeholder="Mínimo de 8 caracteres, com maiúscula, minúscula e número" autocomplete="new-password">
            <div class="pw-meter" id="pw-meter" data-s="0" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
            <div class="pw-label" id="pw-label">Força da senha: —</div></div>
          <div class="field"><label class="chk" style="font-size:.83rem"><input type="checkbox" id="sg-termos" name="termos" style="width:16px;height:16px;accent-color:var(--brand)">
            Li e aceito os <a href="#" data-act="legal" data-doc="termos">termos de uso</a> e a <a href="#" data-act="legal" data-doc="privacidade">política de privacidade</a></label></div>
          <button class="btn btn-primary btn-block btn-lg" type="submit">Criar conta e começar ${raw(I('arrow-right', 16))}</button>
        </form>
        <p class="auth-foot">Já tem conta? <a href="#/entrar">Entrar</a></p>
      </div></div>`;
    },
    mounted: function (root, params, query) {
      var form = root.querySelector('#signup-form');
      var pw = form.elements.password, meter = root.querySelector('#pw-meter'), lbl = root.querySelector('#pw-label');
      var LBLS = ['—', 'fraca', 'razoável', 'boa', 'excelente'];
      pw.addEventListener('input', function () {
        var s = Validate.passwordStrength(pw.value);
        meter.dataset.s = String(s);
        lbl.textContent = 'Força da senha: ' + (pw.value ? LBLS[s] : '—');
      });
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var res = Validate.run(form, {
          storeName: [['required'], ['min', 2]],
          name: [['required'], ['min', 2]],
          email: [['required'], ['email']],
          password: [['required'], ['min', 8]]
        });
        if (!res.ok && res.errors.password) { res.errors.password = 'Senha: mínimo de 8 caracteres, com maiúscula, minúscula e número.'; }
        var pwIssues = AuthService.passwordIssues(form.elements.password.value);
        if (pwIssues.length) { res.ok = false; res.errors.password = 'Senha fraca — falta: ' + pwIssues.join(', ') + '.'; }
        if (!form.elements.termos.checked) { res.ok = false; UI.toast('Você precisa aceitar os termos para continuar.', { type: 'err' }); }
        Validate.paint(form, res.errors);
        if (!res.ok) { if (form.elements.termos.checked) UI.toast('Corrija os campos destacados.', { type: 'err' }); return; }
        var btn = form.querySelector('button[type=submit]');
        UI.busy(btn, true);
        Auth.signup({ storeName: res.values.storeName, name: res.values.name, email: res.values.email, password: res.values.password, segment: form.elements.segment.value })
          .then(function (u) {
            UI.busy(btn, false);
            if (!u) {
              Router.go('/confirmar-codigo?email=' + encodeURIComponent(res.values.email));
              return;
            }
            UI.toast('🎉 Conta criada! Trial de 14 dias ativado.', { type: 'ok', timeout: 5200 });
            Router.go(query && query.plano ? '/app/assinatura' : '/app');
          })
          .catch(function (err) { UI.busy(btn, false); UI.toast(err.message || 'Não foi possível criar a conta.', { type: 'err' }); });
      });
    }
  };

  AuthViews.login = {
    title: 'Entrar',
    render: function (query) {
      var users = Store.state ? Store.state.users.filter(function (u) { return u.ativo; }) : [];
      return html`<div class="auth-wrap"><div class="auth-card">
        <div class="auth-logo">${authLogo()}</div>
        <h1>Entrar no sistema</h1>
        <p class="auth-sub">Acesse o painel da sua loja</p>
        ${query && query.expired ? html`<div class="auth-note" style="border-color:var(--warn-line);background:var(--warn-bg);color:var(--warn)">${raw(I('clock', 15))}<span>Sua sessão expirou por segurança. Entre novamente para continuar.</span></div>` : ''}
        ${query && query.confirm ? html`<div class="auth-note" style="border-color:var(--info-line);background:var(--info-bg);color:var(--info)">${raw(I('mail', 15))}<span>Enviamos um link de confirmação para o seu e-mail. Confirme e entre aqui.</span></div>` : ''}
        <form id="login-form" novalidate>
          <div class="field"><label for="lg-email">E-mail <span class="req">*</span></label>
            <input class="input" id="lg-email" name="email" type="email" placeholder="voce@loja.com.br" autocomplete="username" data-autofocus></div>
          <div class="field"><label for="lg-senha">Senha <span class="req">*</span></label>
            <input class="input" id="lg-senha" name="password" type="password" placeholder="••••••••" autocomplete="current-password">
            ${Config.env === 'demo' ? html`<p class="field-hint">Demo: a senha de todas as contas é <span class="kbd mono">demo123</span></p>` : ''}</div>
          <button class="btn btn-primary btn-block btn-lg" type="submit">Entrar ${raw(I('arrow-right', 16))}</button>
        </form>
        ${Config.env === 'demo' && users.length ? html`<div class="sep-or">contas de demonstração</div>
        <div class="demo-users">${users.map(function (u) {
          return html`<button type="button" class="demo-user-btn" data-demo="${u.id}">
            <span class="avatar sm ${u.papel === 'admin' ? '' : 'gray'}">${U.initials(u.nome)}</span>
            <span><span class="du-name">${u.nome}</span> <span class="badge badge-info no-dot">${u.papel}</span><br><span class="du-mail">${u.email}</span></span>
            ${raw(I('chevron-right', 16))}</button>`;
        })}</div>` : (users.length === 0 ? html`<div class="auth-note" style="margin-top:18px">${raw(I('info', 15))}<span>Nenhuma conta ainda: a primeira conta criada será a <b>administradora</b> da loja.</span></div>` : '')}
        <p class="auth-foot">Ainda não tem conta? <a href="#/cadastro">Criar conta grátis</a> · <a href="#/recuperar">Esqueci minha senha</a></p>
      </div></div>`;
    },
    mounted: function (root, params, query) {
      var self = this;
      var form = root.querySelector('#login-form');
      function doLogin(email, password, btn) {
        UI.busy(btn, true);
        Auth.login(email, password).then(function (u) {
          UI.busy(btn, false);
          UI.toast('Bem-vindo(a), ' + u.nome.split(' ')[0] + '! 👋', { type: 'ok' });
          Router.go((query && query.next) || '/app');
        }).catch(function (e) {
          UI.busy(btn, false);
          UI.toast(e.message || 'Falha no login.', { type: 'err' });
          /* conta criada mas e-mail não confirmado: manda direto pra tela do código */
          if (e && e.code === 'EMAIL_NOT_CONFIRMED') Router.go('/confirmar-codigo?email=' + encodeURIComponent(email));
        });
      }
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var res = Validate.run(form, { email: [['required'], ['email']], password: [['required']] });
        Validate.paint(form, res.errors);
        if (!res.ok) return;
        doLogin(res.values.email, res.values.password, form.querySelector('button[type=submit]'));
      });
      root.querySelectorAll('[data-demo]').forEach(function (b) {
        b.addEventListener('click', function () {
          var u = Store.state.users.filter(function (x) { return x.id === b.dataset.demo; })[0];
          if (u) doLogin(u.email, 'demo123', b);
        });
      });
    }
  };
})();
