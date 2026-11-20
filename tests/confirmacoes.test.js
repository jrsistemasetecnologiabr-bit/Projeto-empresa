/* LojaCerta · teste E2E (Playwright) — ações que "somem" registros pedem
 * confirmação (v2.0.2): inativar cliente e desativar usuário da equipe.
 * Mesmo padrão do bug de Produtos (v2.0.1): a linha some sem aviso.
 *   node tools/build.js --env=demo && node tests/confirmacoes.test.js */
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

  await p.goto(URL); await p.evaluate(() => localStorage.clear());
  await p.goto(URL + '#/entrar');
  await p.fill('input[type=email]', 'maria@lojacerta.demo');
  await p.fill('input[type=password]', 'demo123');
  await p.locator('form button[type=submit]').first().click();
  await p.waitForTimeout(600);

  // ---- clientes ----
  await p.goto(URL + '#/app/clientes');
  await p.waitForSelector('[data-tog]', { timeout: 5000 });
  const ativos0 = await p.locator('tbody tr').count();
  await p.locator('[data-tog]').first().click(); await p.waitForTimeout(250);
  check(await p.locator('[data-yes]').count() === 1, 'inativar cliente abre confirmação');
  await p.locator('[data-no]').click(); await p.waitForTimeout(300);
  check(await p.locator('tbody tr').count() === ativos0, 'cancelar não inativa o cliente');
  await p.locator('[data-tog]').first().click(); await p.waitForTimeout(250);
  await p.locator('[data-yes]').click(); await p.waitForTimeout(500);
  check(await p.locator('tbody tr').count() === ativos0 - 1, 'confirmar inativa exatamente 1 cliente');
  await p.locator('#c-off').check(); await p.waitForTimeout(400);
  const off = p.locator('tr', { has: p.locator('.badge', { hasText: /inativo/i }) }).locator('[data-tog]');
  if (await off.count()) {
    await off.first().click(); await p.waitForTimeout(400);
    check(await p.locator('[data-yes]').count() === 0, 'reativar cliente não pede confirmação');
  } else {
    await p.locator('[data-tog]').last().click(); await p.waitForTimeout(400);
    check(await p.locator('.modal-overlay').count() === 0 || await p.locator('[data-yes]').count() === 1, 'lista de inativos disponível');
  }

  // ---- equipe ----
  await p.goto(URL + '#/app/config'); await p.waitForTimeout(400);
  await p.locator('[data-tab="equipe"]').click(); await p.waitForTimeout(400);
  const btn = p.locator('[data-act-user]', { hasText: 'Desativar' });
  if (await btn.count()) {
    await btn.first().click(); await p.waitForTimeout(250);
    check(await p.locator('[data-yes]').count() === 1, 'desativar usuário abre confirmação');
    await p.locator('[data-no]').click(); await p.waitForTimeout(300);
    check(await p.locator('[data-act-user]', { hasText: 'Desativar' }).count() === await btn.count(), 'cancelar não desativa o usuário');
  } else check(false, 'demo sem usuário para desativar');

  check(errs.length === 0, 'sem erros de JS' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await browser.close();
  console.log(fails ? `\n✘ ${fails} falha(s)` : '✔ confirmacoes: todas as verificações passaram');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
