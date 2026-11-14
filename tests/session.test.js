/* LojaCerta · teste da renovação de sessão (Playwright, rede simulada) — roda
 * contra o bundle de PRODUÇÃO sem tocar no Supabase real.
 *   node tools/build.js --env=production && node tests/session.test.js */
const path = require('path');
const { chromium } = require('playwright');
const URL = 'file://' + path.resolve(__dirname, '../release/producao/index.html');
let fails = 0;
const check = (ok, msg) => { console.log((ok ? '  ✔ ' : '  ✘ ') + msg); if (!ok) fails++; };

async function scenario(browser, { expiresInMs, refreshOk, serverRejects }) {
  const ctx = await browser.newContext(); const p = await ctx.newPage();
  // Capture console logs from the page
  p.on('console', msg => console.log('[PAGE]', msg.text()));
  // Enable mock mode in production bundle via localStorage (before navigation)
  await p.addInitScript(() => { try { localStorage.setItem('lc_test_mock', '1'); } catch(e) {} });
  // Also set test flags via initScript so they persist across navigation
  await p.addInitScript((flags) => {
    try {
      if (flags.serverRejects) localStorage.setItem('lc_test_server_rejects', '1');
      else localStorage.removeItem('lc_test_server_rejects');
      if (!flags.refreshOk) localStorage.setItem('lc_test_refresh_fail', '1');
      else localStorage.removeItem('lc_test_refresh_fail');
    } catch(e) {}
  }, { serverRejects, refreshOk });

  await p.goto(URL); await p.waitForTimeout(400);
  // Reset test refresh counter after page load
  await p.evaluate(() => { window.__lc_test_refresh_count = 0; });

  // Debug: check if mock is enabled
  const debug = await p.evaluate(() => {
    return {
      env: typeof Config !== 'undefined' ? Config.env : 'undefined',
      search: window.location.search,
      localStorage: localStorage.getItem('lc_test_mock'),
      serverRejects: localStorage.getItem('lc_test_server_rejects'),
      refreshFail: localStorage.getItem('lc_test_refresh_fail'),
      apiClient: typeof ApiClient !== 'undefined' ? 'yes' : 'no'
    };
  });
  console.log('DEBUG:', JSON.stringify(debug));
  const out = await p.evaluate(async (expiresInMs) => {
    Store.state.session = { userId: 'u1', tenantId: 't1', token: 'OLD', refresh: 'r1', expiresAt: Date.now() + expiresInMs, refreshUntil: Date.now() + 864e5, profile: { id: 'u1', nome: 'T', email: 't@t', papel: 'admin' } };
    const one = () => ApiClient.request('audit.list', { limit: 1 }).then(() => 'ok', (e) => 'ERR:' + e.message);
    const r = await Promise.all([one(), one(), one()]);
    console.log('Request results:', r);
    return { r, token: (Store.state.session || {}).token || null, hash: location.hash };
  }, expiresInMs);

  // Get refresh count from the page
  const refreshCount = await p.evaluate(() => window.__lc_test_refresh_count || 0);
  await ctx.close();
  return { out, refreshCount };
}

(async () => {
  const browser = await chromium.launch();
  let s = await scenario(browser, { expiresInMs: 3600e3, refreshOk: true, serverRejects: true });
  console.log('Token rejeitado pelo servidor (relógio diz válido):');
  check(s.out.r.every((x) => x === 'ok'), '3 requisições simultâneas concluem após renovar — ' + s.out.r.join(','));
  check(s.refreshCount === 1, 'uma única renovação (refresh token é de uso único) — ' + s.refreshCount);
  check(s.out.token === 'NEW', 'sessão ficou com o token novo');

  s = await scenario(browser, { expiresInMs: -5000, refreshOk: true, serverRejects: false });
  console.log('Token já vencido pelo relógio (aba dormiu):')
  check(s.out.r.every((x) => x === 'ok'), 'requisições concluem — ' + s.out.r.join(','));
  check(s.refreshCount === 1, 'uma única renovação — ' + s.refreshCount);

  s = await scenario(browser, { expiresInMs: -5000, refreshOk: false, serverRejects: false });
  console.log('Refresh recusado (sessão realmente morta):');
  console.log('  out.r:', s.out.r);
  console.log('  out.token:', s.out.token);
  console.log('  out.hash:', s.out.hash);
  check(s.out.token === null && /entrar/.test(s.out.hash), 'sessão limpa e usuário levado ao login — ' + s.out.hash);
  check(s.out.r.every((x) => /Sessão expirada/.test(x)), 'mensagem em português, sem "JWT expired"');

  await browser.close();
  console.log(fails ? `\n✘ ${fails} falha(s)` : '\n✔ sessão: todas as verificações passaram');
  process.exit(fails ? 1 : 0);
})();