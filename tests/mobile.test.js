/* LojaCerta · teste E2E mobile (Playwright) — roda contra o bundle de DEMO
 * (mesmo CSS/JS da produção, dados locais), em larguras reais de celular.
 *   npm run build:demo && npm test
 * Verifica: sem rolagem horizontal em nenhuma rota; menu da landing abre na
 * altura toda, por cima do véu e com Entrar/Começar; menu do app alcança todos
 * os itens; modal não sobrevive à troca de rota; nenhum erro de JS.
 * Requer: npm i -D playwright && npx playwright install chromium (fora do CI). */
const path = require('path');
const { chromium } = require('playwright');

const URL = 'file://' + path.resolve(__dirname, '../release/demo/index.html');
const SIZES = [[320, 568], [360, 740], [390, 844], [414, 896], [768, 1024]];
const PAGES = ['dashboard', 'pdv', 'produtos', 'estoque', 'vendas', 'relatorios', 'suporte', 'assinatura', 'config'];
let fails = 0;
const check = (ok, msg) => { if (!ok) { fails++; console.log('  ✘ ' + msg); } };

(async () => {
  const browser = await chromium.launch();
  for (const [w, h] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 700, hasTouch: true });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    const noHScroll = async (label) => {
      await p.waitForTimeout(250);
      const sw = await p.evaluate(() => document.documentElement.scrollWidth);
      check(sw <= w + 1, `[${w}] ${label}: rolagem horizontal (${sw}px)`);
    };

    await p.goto(URL); await p.evaluate(() => localStorage.clear()); await p.goto(URL + '#/');
    await noHScroll('landing');

    if (w <= 920) { // menu mobile da landing
      await p.click('[data-act="menu-toggle"]'); await p.waitForTimeout(350);
      const m = await p.evaluate(() => {
        const nav = document.getElementById('main-nav'); const r = nav.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 40);
        return { h: r.height, onTop: !!(hit && nav.contains(hit)), cta: nav.querySelectorAll('[data-cta]').length };
      });
      check(m.h > h * 0.6, `[${w}] menu da landing espremido (altura ${Math.round(m.h)}px)`);
      check(m.onTop, `[${w}] menu da landing coberto pelo véu`);
      check(m.cta === 2, `[${w}] menu sem Entrar/Começar`);
      await p.keyboard.press('Escape');
      check(!(await p.evaluate(() => document.body.classList.contains('nav-open'))), `[${w}] Esc não fecha o menu`);
    }

    await p.goto(URL + '#/entrar');
    await p.fill('input[type=email]', 'maria@lojacerta.demo');
    await p.fill('input[type=password]', 'demo123');
    await p.locator('form button[type=submit]').first().click();
    await p.waitForTimeout(600);
    for (const pg of PAGES) { await p.goto(URL + '#/app/' + pg); await noHScroll(pg); }
    if (w === 320) { // celular com fonte do sistema mais larga (Android/Linux sem a fonte do app)
      await p.addStyleTag({ content: '*{font-family:Verdana,"DejaVu Sans",sans-serif!important}' });
      for (const pg of PAGES) { await p.goto(URL + '#/app/' + pg); await noHScroll(pg + ' (fonte larga)'); }
      await p.reload(); await p.waitForTimeout(300);
    }

    if (w < 1024) { // menu do app: todos os itens alcançáveis
      await p.click('.menu-btn'); await p.waitForTimeout(350);
      const last = p.locator('.app-side a[href="#/app/config"]');
      await last.scrollIntoViewIfNeeded();
      const vis = await last.evaluate((el) => {
        const r = el.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + 20, r.top + r.height / 2);
        return !!(hit && el.contains(hit));
      });
      check(vis, `[${w}] menu do app: "Configurações" inalcançável`);
      await last.click(); await p.waitForTimeout(300);
    }

    // modal não sobrevive à troca de rota
    await p.goto(URL + '#/app/vendas'); await p.waitForTimeout(300);
    await p.locator('tr.is-clickable').first().click(); await p.waitForTimeout(250);
    await p.goto(URL + '#/app/dashboard'); await p.waitForTimeout(300);
    check((await p.locator('.modal-overlay').count()) === 0, `[${w}] modal ficou aberto após trocar de página`);

    check(errs.length === 0, `[${w}] erros de JS: ${errs.join(' | ')}`);
    await ctx.close();
  }
  await browser.close();
  console.log(fails ? `\n✘ ${fails} falha(s)` : '✔ mobile: todas as verificações passaram');
  process.exit(fails ? 1 : 0);
})();
