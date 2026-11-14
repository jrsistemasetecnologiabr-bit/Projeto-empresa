/* ==========================================================================
   LojaCerta · shoot.js — captura de screenshots reais do app (Puppeteer)
   Uso: node tools/shoot.js --hero
   Gera src/img/app-hero.jpg (dashboard logado, 1280×800 @2x) usado na landing.
   Requer: release/index.html já buildado.
   ========================================================================== */
'use strict';
const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');

const RELEASE = path.join(__dirname, '..', 'release');
const OUT = path.join(__dirname, '..', 'src', 'img', 'app-hero.jpg');
const PORT = 8399;

function serve() {
  return new Promise(function (res) {
    const srv = http.createServer(function (req, rep) {
      const f = req.url.split('?')[0];
      if (f === '/favicon.ico') { rep.statusCode = 204; rep.end(); return; }
      const p = path.join(RELEASE, f === '/' ? 'index.html' : f);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const ext = path.extname(p);
        const types = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.xml': 'application/xml', '.txt': 'text/plain' };
        rep.setHeader('Content-Type', types[ext] || 'application/octet-stream');
        rep.end(fs.readFileSync(p));
      } else { rep.statusCode = 404; rep.end('404'); }
    });
    srv.listen(PORT, function () { res(srv); });
  });
}

(async function () {
  if (!fs.existsSync(path.join(RELEASE, 'index.html'))) { console.error('Rode o build antes: node tools/build.js'); process.exit(1); }
  const srv = await serve();
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
    const errs = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));

    await page.goto('http://127.0.0.1:' + PORT + '/#/entrar', { waitUntil: 'networkidle0' });
    await page.waitForSelector('[data-demo="u1"]', { timeout: 5000 });
    await page.click('[data-demo="u1"]');
    await page.waitForSelector('.side-brand', { timeout: 5000 });
    await page.waitForFunction("document.querySelector('#page-root .kpi')", { timeout: 6000, polling: 100 });
    await new Promise(r => setTimeout(r, 1200)); // animações/gráficos assentarem
    // esconde o chip de demo e toasts para a captura de marketing
    await page.evaluate(() => {
      const c = document.getElementById('demo-chip'); if (c) c.style.display = 'none';
      const t = document.getElementById('toast-region'); if (t) t.style.display = 'none';
    });
    await page.screenshot({ path: OUT, type: 'jpeg', quality: 90 });
    console.log('✔ hero capturado →', path.relative(process.cwd(), OUT));
    console.log(errs.length ? '⚠ erros de console: ' + JSON.stringify(errs, null, 1) : '✔ zero erros de console');
    process.exitCode = errs.length ? 1 : 0;
  } finally {
    await browser.close();
    srv.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
