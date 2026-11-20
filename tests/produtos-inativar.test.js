/* LojaCerta · teste E2E (Playwright) — inativar produto (v2.0.1)
 * Bug: o cadeado inativava sem confirmação; a linha sumia e a de baixo subia
 * para o mesmo lugar, então toques seguidos inativavam todos os produtos.
 *   node tools/build.js --env=demo && node tests/produtos-inativar.test.js
 * Verifica: cadeado pede confirmação (cancelar não inativa); confirmar remove
 * exatamente 1 linha e mostra "1 inativo"; com todos inativos aparece
 * "Mostrar inativos"; reativar não pede confirmação; nenhum erro de JS. */
const path = require('path');
const { chromium } = require('playwright');

const URL = 'file://' + path.resolve(__dirname, '../release/demo/index.html');
let fails = 0;
const check = (ok, msg) => { if (ok) console.log('  ✔ ' + msg); else { fails++; console.log('  ✘ ' + msg); } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  const rows = () => p.locator('tbody tr').count();
  const goProdutos = async () => { await p.goto(URL + '#/app/produtos'); await p.waitForSelector('tbody tr, .empty', { timeout: 5000 }); await p.waitForTimeout(250); };

  await p.goto(URL); await p.evaluate(() => localStorage.clear());
  await p.goto(URL + '#/entrar');
  await p.fill('input[type=email]', 'maria@lojacerta.demo');
  await p.fill('input[type=password]', 'demo123');
  await p.locator('form button[type=submit]').first().click();
  await p.waitForTimeout(600);
  await goProdutos();

  // (a) cadeado abre confirmação; "Voltar" cancela sem inativar
  const n0 = await rows();
  await p.locator('[data-tog]').first().click();
  await p.waitForTimeout(250);
  check(await p.locator('[data-yes]').count() === 1, 'cadeado abre confirmação');
  await p.locator('[data-no]').click(); await p.waitForTimeout(300);
  check(await rows() === n0, 'cancelar não inativa (' + n0 + ' linhas)');
  check(!(await p.content()).includes('1 inativo'), 'nenhum inativo após cancelar');

  // (b) confirmar remove exatamente 1 linha
  await p.locator('[data-tog]').first().click(); await p.waitForTimeout(250);
  await p.locator('[data-yes]').click(); await p.waitForTimeout(500);
  check(await rows() === n0 - 1, 'confirmar remove exatamente 1 linha (' + (await rows()) + ')');
  check((await p.content()).includes('1 inativo'), 'subtítulo mostra "1 inativo"');

  // (c) todos inativos → "Mostrar inativos" lista todos
  const total = await p.evaluate(() => Store.state.products.length);
  await p.evaluate(() => Store.update((s) => { s.products.forEach((x) => { x.ativo = false; }); }));
  await p.goto(URL + '#/app/dashboard'); await p.waitForTimeout(300);
  await goProdutos();
  check(await p.locator('[data-show-off]').count() === 1, 'todos inativos: botão "Mostrar inativos" aparece');
  await p.locator('[data-show-off]').click(); await p.waitForTimeout(300);
  check(await rows() === total, '"Mostrar inativos" lista todos (' + (await rows()) + '/' + total + ')');

  // (d) reativar não pede confirmação
  await p.locator('[data-tog]').first().click(); await p.waitForTimeout(400);
  check(await p.locator('[data-yes]').count() === 0, 'reativar não pede confirmação');
  const ativos = await p.evaluate(() => Store.state.products.filter((x) => x.ativo).length);
  check(ativos === 1, 'reativou 1 produto (' + ativos + ')');

  // (e) sem erros de JS
  check(errs.length === 0, 'sem erros de JS' + (errs.length ? ': ' + errs.join(' | ') : ''));

  await browser.close();
  console.log(fails ? `\n✘ ${fails} falha(s)` : '✔ produtos-inativar: todas as verificações passaram');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
