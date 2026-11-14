/* ==========================================================================
   LojaCerta · Build
   Gera o bundle single-file de produção em release/index.html:
   - inline de CSS (na ordem dos <link>) com remoção de comentários
   - inline de JS (na ordem dos <script>) envolvido em IIFE individual
   - inline de imagens locais (src="img/...") como data-URI
   - cópia de assets públicos (og-cover) + robots.txt + sitemap.xml
   Uso: node tools/build.js
   Zero dependências externas.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'release');
const DEFAULT_SITE = 'https://jrsistemasetecnologiabr-bit.github.io/Projeto-empresa';

/* ---------- modo de build: demo (padrão) | production ---------- */
const args = process.argv.slice(2);
const envFlag = (args.find(a => a.startsWith('--env=')) || '').split('=')[1] || '';
function readDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return {};
  const out = {};
  fs.readFileSync(p, 'utf8').split('\n').forEach(l => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
  return out;
}
const dot = readDotEnv();
/* Fonte única da versão: src/js/services.js (Config.version). O build extrai e
   propaga para o <meta name="app-version"> e para o version.json — ninguém
   precisa duplicar literal de versão em outro lugar (e grep de auditoria tem
   um ponto canônico, sem falso-positivo de comentário histórico). */
const VERSION = (() => {
  const m = read(path.join(SRC, 'js', 'services.js')).match(/version:\s*'([0-9]+\.[0-9]+\.[0-9]+)'/);
  if (!m) { console.error('  ✘ versão não encontrada em src/js/services.js (Config.version)'); process.exit(1); }
  return m[1];
})();
/* CSP connect-src: 'self' + o host do Supabase do projeto (http e wss — o wss
   antecipa o Realtime sem quebrar quando ele chegar). Host derivado do API_BASE
   para nunca divergir do backend de fato. */
const API_HOST = (() => {
  const base = dot.API_BASE || 'https://qmqllssextbxwwphawod.supabase.co';
  try { return new URL(base).host; } catch (e) { console.error('  ✘ API_BASE inválido para CSP: ' + base); process.exit(1); }
})();
const TOKENS = {
  APP_VERSION: VERSION,
  CSP_CONNECT: `'self' https://${API_HOST} wss://${API_HOST}`,
  ENV: envFlag || dot.ENV || 'final',
  API_BASE: dot.API_BASE || '',
  SUPABASE_ANON_KEY: dot.SUPABASE_ANON_KEY || '',
  BILLING_PROVIDER: dot.BILLING_PROVIDER || 'mock',
  STRIPE_PK: dot.STRIPE_PK || '',
  SITE_URL: (dot.SITE_URL || DEFAULT_SITE).replace(/\/+$/, ''),
  /* espelho front-end (modo demo) da guarda anti-abuso do teste grátis —
     a regra real vive no servidor: TRIAL_LIMIT_PER_IP/_DEVICE na Edge Function */
  TRIAL_IP_LIMIT: dot.TRIAL_IP_LIMIT || '1',
  TRIAL_DEVICE_LIMIT: dot.TRIAL_DEVICE_LIMIT || '1'
};
const SITE_URL = TOKENS.SITE_URL;

function read(p) { return fs.readFileSync(p, 'utf8'); }
function log(msg) { console.log('  ' + msg); }

/* ---------- CSS ---------- */
function inlineCss(html) {
  let total = 0;
  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (_, href) => {
    const css = read(path.join(SRC, href))
      .replace(/\/\*[\s\S]*?\*\//g, '')          // comentários
      .replace(/^\s*[\r\n]/gm, '')               // linhas vazias
      .trim();
    total += css.length;
    return '<style>\n' + css + '\n</style>';
  });
  log('CSS inline: ' + (total / 1024).toFixed(1) + ' KB (minificado em whitespace)');
  return html;
}

/* ---------- JS ---------- */
function inlineJs(html) {
  let total = 0, count = 0;
  html = html.replace(/<script src="([^"]+)" defer><\/script>/g, (_, src) => {
    const js = read(path.join(SRC, src)).trim();
    total += js.length; count++;
    return '<script>\n' + js + '\n</script>';
  });
  log('JS inline: ' + count + ' módulos, ' + (total / 1024).toFixed(1) + ' KB');
  return html;
}

/* ---------- IMAGENS ---------- */
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
function inlineImages(html) {
  let n = 0, bytes = 0;
  html = html.replace(/src="(img\/[^"]+)"/g, (m, p) => {
    const file = path.join(SRC, p);
    if (!fs.existsSync(file)) { console.warn('  ⚠ imagem não encontrada (mantida como está): ' + p); return m; }
    const ext = path.extname(file).toLowerCase();
    const b64 = fs.readFileSync(file).toString('base64');
    n++; bytes += b64.length;
    return 'src="data:' + (MIME[ext] || 'application/octet-stream') + ';base64,' + b64 + '"';
  });
  log('Imagens inline: ' + n + ' (' + (bytes / 1024).toFixed(1) + ' KB base64)');
  return html;
}

/* ---------- BUILD ---------- */
function build() {
  console.log('🧱 LojaCerta · build de produção');
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  let html = read(path.join(SRC, 'index.html'));
  html = inlineCss(html);
  html = inlineJs(html);
  html = inlineImages(html);
  html = html.replace(/\{\{(ENV|API_BASE|SUPABASE_ANON_KEY|BILLING_PROVIDER|STRIPE_PK|SITE_URL|TRIAL_IP_LIMIT|TRIAL_DEVICE_LIMIT|APP_VERSION|CSP_CONNECT)\}\}/g, (m, k) => TOKENS[k]);

  /* sanidade: nenhum token {{...}} pode sobreviver ao build (v1.7.3 — evita
     publicar CSP vazia ou versão 'undefined' sem perceber) */
  const unusedTokens = html.match(/\{\{[A-Z_]+\}\}/g);
  if (unusedTokens) { console.warn('  ⚠ tokens não resolvidos: ' + [...new Set(unusedTokens)].join(', ')); process.exitCode = 1; }
  html = html.replace('</head>',
    '<!-- built: ' + new Date().toISOString() + ' · mode: ' + TOKENS.ENV + ' · single-file bundle · src/ → release/ -->\n</head>');

  const outDir = TOKENS.ENV === 'production' ? path.join(OUT, 'producao') : (TOKENS.ENV === 'demo' ? path.join(OUT, 'demo') : OUT);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'index.html');
  fs.writeFileSync(out, html);
  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  log('✔ ' + path.relative(ROOT, out) + ' — ' + kb + ' KB  [modo: ' + TOKENS.ENV + ']');

  /* version.json — sonda de versão para o app (cache-buster no fetch) e para
     operação/auditoria (curl sem cache). Commit vem do GITHUB_SHA quando o build
     roda no CI; local fica null (build local ≠ artefato publicado). */
  const versionJson = JSON.stringify({
    app: 'LojaCerta', version: VERSION, mode: TOKENS.ENV,
    built: new Date().toISOString(), commit: process.env.GITHUB_SHA ? String(process.env.GITHUB_SHA).slice(0, 7) : null
  }, null, 2) + '\n';

  /* assets públicos */
  [OUT, outDir].forEach(dir => {
    const assets = path.join(dir, 'assets');
    if (!fs.existsSync(assets)) fs.mkdirSync(assets, { recursive: true });
    /* version.json só no outDir do modo buildado (producao/demo) — é ele que
       o workflow copia para o Pages; na raiz de release/ ficaria um bundle
       "final" com um version.json de outro modo, confundindo operação */
    if (dir === outDir) fs.writeFileSync(path.join(dir, 'version.json'), versionJson);
    ['og-cover.png'].forEach(f => {
      const srcImg = path.join(SRC, 'img', f);
      if (fs.existsSync(srcImg)) { fs.copyFileSync(srcImg, path.join(assets, f)); }
    });
    fs.writeFileSync(path.join(dir, 'robots.txt'),
      'User-agent: *\nAllow: /\n\nSitemap: ' + SITE_URL + '/sitemap.xml\n');
    fs.writeFileSync(path.join(dir, 'sitemap.xml'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      ['/', '/#recursos', '/#como-funciona', '/#planos', '/#faq'].map(u =>
        '  <url><loc>' + SITE_URL + (u === '/' ? '/' : u) + '</loc><changefreq>weekly</changefreq><priority>' + (u === '/' ? '1.0' : '0.7') + '</priority></url>'
      ).join('\n') + '\n</urlset>\n');
  });
  log('✔ robots.txt + sitemap.xml + version.json (v' + VERSION + ') + assets/');

  /* sanidade: bundle não pode referenciar arquivos locais restantes */
  const leftovers = (html.match(/(href|src)="(?!https?:|data:|mailto:|#|\/|')[^"]+"/g) || []).filter(x => !x.includes("' +"));
  if (leftovers.length) { console.warn('  ⚠ referências locais restantes: ' + leftovers.join(', ')); process.exitCode = 1; }
  else log('✔ nenhuma referência local pendente (bundle 100% autocontido)');
  console.log('✅ Build concluído.');
}

build();
