/* LojaCerta · permissões do papel "caixa" no banco real (RLS/RPC) — v2.0.2
 * Usa uma conta QA TEMPORÁRIA com papel caixa (crie por convite; apague no fim).
 *   SUPABASE_ANON_KEY=... CAIXA_EMAIL=... CAIXA_PASSWORD=... node tests/prod-permissoes.test.js
 * (em sandbox com proxy: NODE_USE_ENV_PROXY=1)
 * O caixa VENDE, mas não altera produtos, preços, regras da loja, usuários,
 * não cancela venda, não cancela conta do financeiro e não vê a auditoria. */
'use strict';
const fs = require('fs');
const path = require('path');
try { fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }); } catch (e) { /* sem .env */ }
const B = process.env.SUPABASE_URL || 'https://qmqllssextbxwwphawod.supabase.co';
const K = process.env.SUPABASE_ANON_KEY;
const EMAIL = process.env.CAIXA_EMAIL, PASS = process.env.CAIXA_PASSWORD;
if (!K || !EMAIL || !PASS) { console.error('Defina SUPABASE_ANON_KEY, CAIXA_EMAIL e CAIXA_PASSWORD.'); process.exit(2); }
let fails = 0;
const check = (ok, msg) => { if (ok) console.log('  ✔ ' + msg); else { fails++; console.log('  ✘ ' + msg); } };

(async () => {
  const lr = await fetch(B + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: K, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASS }) });
  const tok = (await lr.json()).access_token;
  check(!!tok, 'login do caixa');
  const H = { apikey: K, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
  const rest = (m, pth, body, pref) => fetch(B + '/rest/v1/' + pth, { method: m, headers: Object.assign({}, H, pref ? { Prefer: pref } : {}), body: body ? JSON.stringify(body) : undefined });
  const rpc = async (fn, body) => { const r = await rest('POST', 'rpc/' + fn, body); return { status: r.status, body: await r.json().catch(() => null) }; };

  const me = (await (await rest('GET', 'users?select=id,tenant_id,papel&limit=50')).json()).filter((u) => u.papel === 'caixa')[0];
  check(me && me.papel === 'caixa', 'papel no banco = caixa');
  const prods = await (await rest('GET', 'products?select=id,preco_venda,ativo&ativo=eq.true&limit=1')).json();
  check(Array.isArray(prods) && prods.length === 1, 'caixa LÊ produtos (precisa para o PDV)');
  const pid = prods[0] && prods[0].id;

  const pu = await (await rest('PATCH', 'products?id=eq.' + pid, { preco_venda: 0.01 }, 'return=representation')).json();
  check(Array.isArray(pu) && pu.length === 0, 'caixa NÃO altera preço de produto');
  const pa = await (await rest('PATCH', 'products?id=eq.' + pid, { ativo: false }, 'return=representation')).json();
  check(Array.isArray(pa) && pa.length === 0, 'caixa NÃO inativa produto');
  const tu = await (await rest('PATCH', 'tenants?id=eq.' + me.tenant_id, { nome: 'hack' }, 'return=representation')).json();
  check(Array.isArray(tu) && tu.length === 0, 'caixa NÃO altera dados da loja');
  const uu = await (await rest('PATCH', 'users?id=eq.' + me.id, { papel: 'admin' }, 'return=representation')).json().catch(() => null);
  check(!Array.isArray(uu) || uu.length === 0 || uu[0].papel === 'caixa', 'caixa NÃO se promove a admin');
  const aj = await rpc('stock_adjust', { p: { productId: pid, delta: 1, reason: 'teste' } });
  check(aj.status >= 400, 'caixa NÃO ajusta estoque (' + aj.status + ')');

  const sale = await rpc('commit_sale', { p: { items: [{ productId: pid, qtd: 1 }], discount: { tipo: 'R$', valor: 0 }, payments: [{ forma: 'dinheiro', valor: Number(prods[0].preco_venda) }], idempotencyId: 'qa-caixa-' + Date.now() } });
  check(sale.status === 200 && sale.body && sale.body.id, 'caixa VENDE no PDV' + (sale.status === 200 ? '' : ' → ' + JSON.stringify(sale.body)));
  if (sale.body && sale.body.id) {
    const cc = await rpc('cancel_sale', { p: { id: sale.body.id, reason: 'teste caixa' } });
    check(cc.status >= 400, 'caixa NÃO cancela venda (' + cc.status + ')');
  }
  const au = await (await rest('GET', 'audit_logs?select=id&limit=1')).json();
  check(Array.isArray(au) && au.length === 0, 'caixa NÃO lê a auditoria');

  console.log(fails ? `\n✘ ${fails} falha(s)` : '✔ permissoes: todas as verificações passaram');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
