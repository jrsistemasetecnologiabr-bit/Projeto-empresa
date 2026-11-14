/* Otimiza imagens do projeto (roda antes do build):
   node tools/optimize-images.js
   - loja.jpg   → máx 1280px, JPEG q72, progressivo
   - og-cover.png → 1200x630, PNG comprimido (nível 9)
   - app-hero.png → máx 1280px, JPEG q78 (captura do app, se existir) */
'use strict';
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const IMG = path.join(__dirname, '..', 'src', 'img');

async function opt(file, fn) {
  const p = path.join(IMG, file);
  if (!fs.existsSync(p)) { console.log('  – ' + file + ' (não existe, pulando)'); return; }
  const before = fs.statSync(p).size;
  await fn(sharp(p)).toFile(p + '.tmp');
  fs.renameSync(p + '.tmp', p);
  const after = fs.statSync(p).size;
  console.log('  ✔ ' + file + ': ' + (before / 1024).toFixed(0) + ' KB → ' + (after / 1024).toFixed(0) + ' KB');
}

(async () => {
  console.log('🖼  Otimizando imagens:');
  await opt('loja.jpg', s => s.resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 72, progressive: true, mozjpeg: true }));
  await opt('og-cover.png', s => s.resize(1200, 630, { fit: 'cover' }).png({ compressionLevel: 9 }));
  await opt('app-hero.jpg', s => s.resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 80, progressive: true }));
  console.log('✅ Imagens otimizadas.');
})().catch(e => { console.error(e); process.exit(1); });
