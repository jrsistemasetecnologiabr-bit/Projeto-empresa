/* LojaCerta · E2E REAL de produção (Playwright + Supabase) — v2.0.2
 * Roda o bundle de PRODUÇÃO (adapter Supabase) logado numa conta QA real e
 * exercita todos os recursos vendidos nos planos, conferindo a auditoria.
 * USE SÓ COM UMA CONTA QA TEMPORÁRIA (cria produtos, vendas, filial etc.) e
 * apague a loja no fim — veja CONTEXTO-PROXIMO-CHAT.txt, seção 6.
 *   node tools/build.js --env=production
 *   (cd release/producao && python3 -m http.server 8765) &
 *   APP_URL=http://localhost:8765/ QA_EMAIL=... QA_PASSWORD=... node tests/prod-e2e.test.js
 * Em sandbox com proxy HTTPS, o Chromium usa HTTPS_PROXY automaticamente. */
const { chromium } = require('playwright');

const URL = process.env.APP_URL || 'http://localhost:8765/';
const EMAIL = process.env.QA_EMAIL, PASS = process.env.QA_PASSWORD;
if (!EMAIL || !PASS) { console.error('Defina QA_EMAIL e QA_PASSWORD (conta QA temporária).'); process.exit(2); }
let fails = 0;
const check = (ok, msg) => { if (ok) console.log('  ✔ ' + msg); else { fails++; console.log('  ✘ ' + msg); } };

(async () => {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy, bypass: 'localhost,127.0.0.1' } } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  p.on('dialog', (d) => d.accept());

  await p.goto(URL); await p.evaluate(() => localStorage.clear());
  await p.goto(URL + '#/entrar');
  await p.fill('input[type=email]', EMAIL);
  await p.fill('input[type=password]', PASS);
  await p.locator('form button[type=submit]').first().click();
  await p.waitForFunction(() => location.hash.indexOf('#/app') === 0, null, { timeout: 20000 });
  await p.waitForTimeout(2500);
  check(await p.evaluate(() => Config.env === 'production' || !Config.demo), 'bundle de produção (adapter Supabase)');

  // roda um passo no navegador; devolve {ok, v} ou {ok:false, e}
  const step = (fn, arg) => p.evaluate(async ([src, a]) => {
    try { const v = await (0, eval)('(' + src + ')')(a); return { ok: true, v: v === undefined ? null : JSON.parse(JSON.stringify(v)) }; }
    catch (e) { return { ok: false, e: (e && (e.code ? e.code + ': ' : '') + e.message) || String(e) }; }
  }, [fn.toString(), arg]);
  const must = async (label, fn, arg) => { const r = await step(fn, arg); check(r.ok, label + (r.ok ? '' : ' → ' + r.e)); return r.v; };

  // ---- produtos / CSV / estoque ----
  const pid = (await must('produto: criar', async () => (await Catalog.create({ nome: 'QA E2E Feijão 1kg', catId: Catalog.categories()[0].id, un: 'un', custo: 5, preco: 9.9, estoque: 20, min: 2 })).id));
  await must('produto: editar preço e corrigir estoque (vira ajuste)', async (id) => { const x = Catalog.get(id); await Catalog.update(Object.assign({}, x, { preco: 10.5, estoque: 25 })); }, pid);
  const est = await must('estoque após edição = 25 (ajuste no banco)', async (id) => Catalog.get(id).estoque, pid);
  check(est === 25, 'estoque correto após edição (' + est + ')');
  await must('estoque: entrada', async (id) => Inventory.entry({ productId: id, qtd: 5, custo: 5.2, fornecedor: 'QA', nf: '1' }), pid);
  await must('estoque: ajuste', async (id) => Inventory.adjust({ productId: id, delta: -1, reason: 'Perda/quebra', note: 'QA' }), pid);
  await must('CSV: importar 2 produtos', async () => {
    const cod = 'QA' + Date.now(); // preço com vírgula decimal e milhar (formato brasileiro)
    const r = Catalog.parseCSV('codigo;nome;categoria;unidade;custo;preco;estoque;minimo\n' + cod + '1;QA CSV Arroz;;un;3;6,5;10;1\n' + cod + '2;QA CSV Óleo;;un;4;1.234,50;10;1');
    const c = await Catalog.commitCSV(r.rows || r.preview || r); if (c.ok !== 2) throw new Error('importou ' + c.ok + ' falhou ' + c.fail);
  });
  await must('produto: inativar e reativar', async (id) => { const a = await Catalog.toggle(id); const b = await Catalog.toggle(id); if (a.ativo !== false || b.ativo !== true) throw new Error(JSON.stringify([a, b])); }, pid);

  // ---- PDV / vendas ----
  const sale = await must('PDV: venda em dinheiro', async (id) => Sales.commit({ items: [{ productId: id, qtd: 2, preco: 10.5 }], discount: { tipo: 'R$', valor: 0 }, payments: [{ forma: 'dinheiro', valor: 21 }], idempotencyId: 'qa-' + Date.now() }), pid);
  const sale2 = await must('PDV: venda no Pix (para cancelar)', async (id) => Sales.commit({ items: [{ productId: id, qtd: 1, preco: 10.5 }], discount: { tipo: 'R$', valor: 0 }, payments: [{ forma: 'pix', valor: 10.5 }], idempotencyId: 'qa2-' + Date.now() }), pid);
  if (sale2) await must('vendas: cancelar (admin, devolve estoque)', async (id) => Sales.cancel(id, 'Teste QA automatizado'), sale2.id);

  // ---- clientes / fiado / financeiro ----
  const cid = await must('clientes: cadastrar', async () => (await Biz.customers.save({ nome: 'Cliente QA E2E', documento: '52998224725', limite: 100 })).id);
  await must('fiado: venda no fiado dentro do limite', async (a) => Sales.commit({ items: [{ productId: a.pid, qtd: 1, preco: 10.5 }], discount: { tipo: 'R$', valor: 0 }, payments: [{ forma: 'fiado', valor: 10.5 }], customerId: a.cid, idempotencyId: 'qa3-' + Date.now() }), { pid, cid });
  const lim = await step(async (a) => Sales.commit({ items: [{ productId: a.pid, qtd: 20, preco: 10.5 }], discount: { tipo: 'R$', valor: 0 }, payments: [{ forma: 'fiado', valor: 210 }], customerId: a.cid, idempotencyId: 'qa4-' + Date.now() }), { pid, cid });
  check(!lim.ok && /limite/i.test(lim.e || ''), 'fiado: acima do limite é recusado com mensagem clara (' + (lim.e || 'aceitou!') + ')');
  const recs = await must('financeiro: listar a receber (fiado gerou conta)', async () => Biz.receivables.list());
  const fiadoRec = (recs || []).filter((r) => r.saleId && r.status === 'aberto' && r.valor - r.valorPago >= 5)[0];
  check(!!fiadoRec, 'conta a receber do fiado existe');
  if (fiadoRec) await must('financeiro: baixa parcial do fiado', async (id) => Biz.receivables.settle(id, 5, 'dinheiro'), fiadoRec.id);
  const pay = await must('financeiro: lançar conta a pagar', async () => (await Biz.payables.create({ fornecedor: 'Fornecedor QA', descricao: 'Boleto QA', valor: 50, vencimento: Biz.today() })).id);
  if (pay) await must('financeiro: pagar conta', async (id) => Biz.payables.settle(id, 50, 'pix'), pay);
  const rec2 = await must('financeiro: lançar e cancelar conta a receber', async (c) => { const r = await Biz.receivables.create({ customerId: c, descricao: 'Avulso QA', valor: 30, vencimento: Biz.today() }); await Biz.receivables.cancel(r.id); return r.id; }, cid);
  await must('clientes: inativar e reativar', async (c) => { await Biz.customers.toggle(c, false); await Biz.customers.toggle(c, true); }, cid);

  // ---- orçamentos ----
  const q = await must('orçamento: criar (preço recalculado no servidor)', async (a) => Biz.quotes.create({ customerId: a.cid, clienteNome: 'Cliente QA E2E', itens: [{ productId: a.pid, qtd: 3 }], desconto: 0, validade: Biz.today() }), { pid, cid });
  const q2 = await must('orçamento: criar e cancelar outro', async (a) => { const r = await Biz.quotes.create({ itens: [{ productId: a, qtd: 1 }], validade: Biz.today() }); await Biz.quotes.cancel(r.id); return r; }, pid);
  if (q) await must('orçamento: converter em venda', async (a) => Sales.commit({ items: [{ productId: a.pid, qtd: 3, preco: 10.5 }], discount: { tipo: 'R$', valor: 0 }, payments: [{ forma: 'dinheiro', valor: 31.5 }], quoteId: a.qid, idempotencyId: 'qa5-' + Date.now() }), { pid, qid: q.id });
  const ql = await must('orçamentos: listar', async () => Biz.quotes.list());
  check((ql || []).some((x) => q && x.id === q.id && x.status === 'convertido'), 'orçamento ficou "convertido"');

  // ---- configurações / regras ----
  await must('loja: salvar regras (desconto do caixa)', async () => ApiClient.request('tenant.update', { descontoCaixaPct: 7, reciboMsg: 'Obrigado QA' }));

  // ---- fiscal (sem token da empresa → mensagem clara, sem quebrar) ----
  const fc = await must('fiscal: ler configuração', async () => Biz.fiscal.config());
  check(fc && fc.liberado !== false, 'fiscal liberado no teste grátis');
  const ft = await step(async () => Biz.fiscal.test());
  check(!ft.ok && /token|configur/i.test(ft.e || ''), 'fiscal: testar sem token dá mensagem clara (' + (ft.e || 'ok') + ')');
  if (sale) {
    const fe = await step(async (id) => Biz.fiscal.emit(id, 'nfce', ''), sale.id);
    check(!fe.ok && /token|configur|fiscal/i.test(fe.e || ''), 'fiscal: emitir sem token dá mensagem clara (' + (fe.e || 'emitiu?') + ')');
  }

  // ---- relatórios / exportação ----
  await must('relatórios: carregam', async () => { if (typeof Reports === 'undefined') throw new Error('Reports ausente'); return Object.keys(Reports).length; });
  await must('exportar CSV de vendas', async () => { const ok = DataOps.exportCSV('vendas'); if (!ok) throw new Error('falhou'); });

  // ---- suporte ----
  await must('suporte: abrir ticket', async () => ApiClient.request('tickets.create', { assunto: 'Teste QA automatizado', categoria: 'duvida', prioridade: 'baixa', descricao: 'Ticket criado pelo teste E2E automatizado — pode ignorar.' }));

  // ---- PDV offline: sem internet a venda vai para a fila e sobe ao voltar ----
  await ctx.setOffline(true);
  const off = await step(async (id) => Sales.commit({ items: [{ productId: id, qtd: 1, preco: 10.5 }], discount: { tipo: 'R$', valor: 0 }, payments: [{ forma: 'dinheiro', valor: 10.5 }], idempotencyId: U.uuid() }), pid);
  check(off.ok && off.v && off.v.pending, 'PDV offline: venda vai para a fila' + (off.ok ? '' : ' → ' + off.e));
  check(await p.evaluate(() => OfflineQueue.list().length) === 1, 'fila offline com 1 venda');
  await ctx.setOffline(false);
  // ao voltar a conexão o app envia a fila sozinho (evento "online"); flush() cobre o caso de não disparar
  await must('PDV offline: enviar a fila ao voltar a conexão', async () => OfflineQueue.flush());
  await p.waitForFunction(() => OfflineQueue.list().length === 0, null, { timeout: 20000 }).catch(() => {});
  check(await p.evaluate(() => OfflineQueue.list().length === 0 && OfflineQueue.list(OfflineQueue.FAIL).length === 0), 'fila offline esvaziada e enviada sem falhas');
  const dup = await must('PDV offline: reenviar a mesma venda não duplica (idempotência)', async (id) => {
    const k = U.uuid();
    const r1 = await ApiClient.request('sales.commit', { items: [{ productId: id, qtd: 1 }], discount: { tipo: 'R$', valor: 0 }, payments: [{ forma: 'dinheiro', valor: 10.5 }], idempotencyId: k });
    const r2 = await ApiClient.request('sales.commit', { items: [{ productId: id, qtd: 1 }], discount: { tipo: 'R$', valor: 0 }, payments: [{ forma: 'dinheiro', valor: 10.5 }], idempotencyId: k });
    return [(r1.sale || r1).id, (r2.sale || r2).id];
  }, pid);
  check(dup && dup[0] === dup[1], 'mesma venda (idempotencyId) devolve o mesmo id');

  // ---- multi-loja (por último: troca a loja ativa) ----
  const st = await must('multi-loja: criar filial', async () => Biz.stores.create({ nome: 'QA Filial E2E' }));
  await must('multi-loja: listar lojas', async () => Biz.stores.list());
  await must('multi-loja: painel consolidado', async () => Biz.stores.summary(30));

  // ---- auditoria (o que motivou a v22) ----
  const aud = await must('auditoria: listar', async () => ApiClient.request('audit.list', { limit: 200 }));
  const acoes = new Set((aud || []).map((a) => a.acao));
  ['produto.criado', 'produto.editado', 'produto.inativado', 'produto.reativado', 'estoque.ajuste', 'estoque.entrada', 'venda.concluida', 'venda.cancelada',
    'cliente.criado', 'cliente.inativado', 'financeiro.pagar_criado', 'financeiro.receber_criado', 'orcamento.criado', 'orcamento.cancelado', 'config.atualizada', 'loja.criada']
    .forEach((a) => check(acoes.has(a), 'auditoria registra ' + a));

  // ---- todas as telas abrem sem erro ----
  for (const pg of ['dashboard', 'pdv', 'produtos', 'estoque', 'vendas', 'relatorios', 'clientes', 'orcamentos', 'financeiro', 'fiscal', 'lojas', 'suporte', 'assinatura', 'config']) {
    await p.goto(URL + '#/app/' + pg); await p.waitForTimeout(1200);
    const bad = await p.evaluate(() => { const t = document.getElementById('page-root'); return t ? /Falha ao carregar|Erro HTTP|is not a function|undefined is not|FORBIDDEN|em breve/i.test(t.innerText) : true; });
    check(!bad, 'tela ' + pg + ' abre sem erro');
  }

  check(errs.length === 0, 'sem erros de JS' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await browser.close();
  console.log(fails ? `\n✘ ${fails} falha(s)` : '✔ prod-e2e: todas as verificações passaram');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
