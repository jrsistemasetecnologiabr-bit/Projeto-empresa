#!/usr/bin/env node
/* ============================================================================
   LojaCerta · SMOKE TEST de produção (Node 20+, zero dependências)
   ----------------------------------------------------------------------------
   Valida o essencial do ambiente publicado em ~15s, de forma REPRODUZÍVEL:
     1.  Site no ar (GitHub Pages) com o bundle esperado
     2.  Edge Function "api" respondendo (ping)
     3.  RLS: leitura anônima de tickets bloqueada
     4.  RPC do badge exige sessão (support_badge_counts)
     5.  RPC da trilha global é dev-only (admin_audit_list → FORBIDDEN p/ comum)
     6.  Login do usuário de teste (password grant)
     7.  Badge do usuário comum volta com contadores
     8.  billing_refresh_status responde o retrato do próprio tenant
     9.  Isolamento: listagem de tickets só devolve o próprio tenant
     10. Forja de tenant_id em insert é barrada por RLS
     11. Guard de cobrança: PATCH em colunas de plano é FORBIDDEN
     12. Escrita de cobrança via Edge exige papel dev (FORBIDDEN p/ comum)
     13. RPC de venda valida entrada antes de qualquer escrita
     14. CORS estático: headers x-* usados no front ⊆ allowlist da Edge (previne
         a classe de bug da v1.7.1 — header novo no front sem allowlist = preflight
         quebrado em produção; ignora falsos positivos de ícones SVG 'x-circle')
     15. CORS ao vivo: preflight OPTIONS aceita TODOS os headers que o front envia

   Uso:
     node tests/smoke.test.js
   Variáveis (ou arquivo .env na raiz):
     SITE_URL       (default: https://jrsistemasetecnologiabr-bit.github.io/Projeto-empresa)
     SUPABASE_URL   (default: https://qmqllssextbxwwphawod.supabase.co)
     SUPABASE_ANON_KEY
     TEST_EMAIL     (usuário comum de teste)
     TEST_PASSWORD

   Saída: lista ✔/✘ + resumo final; exit code 1 se algo falhar (serve p/ CI).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

function readDotEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return {};
  const out = {};
  fs.readFileSync(p, 'utf8').split('\n').forEach(l => {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  });
  return out;
}
const dot = readDotEnv();
const SITE = (process.env.SITE_URL || dot.SITE_URL || 'https://jrsistemasetecnologiabr-bit.github.io/Projeto-empresa').replace(/\/+$/, '');
const BASE = (process.env.SUPABASE_URL || dot.API_BASE || 'https://qmqllssextbxwwphawod.supabase.co').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || dot.SUPABASE_ANON_KEY || '';
const TEST_EMAIL = process.env.TEST_EMAIL || dot.TEST_EMAIL || '';
const TEST_PASSWORD = process.env.TEST_PASSWORD || dot.TEST_PASSWORD || '';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '✔ PASSOU' : '✘ FALHOU'} · ${name}${detail ? ' → ' + detail : ''}`);
}
async function j(url, opts = {}) {
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch (_e) { /* corpo não-JSON */ }
  return { status: r.status, body };
}
const H = { 'Content-Type': 'application/json', apikey: ANON };

(async () => {
  if (!ANON) { console.error('SUPABASE_ANON_KEY ausente (.env ou env var).'); process.exit(1); }

  /* 0 · CORS estático: headers customizados do front × allowlist da Edge.
         Regra: todo header 'x-*' enviado pelo front precisa estar na allowlist
         Access-Control-Allow-Headers da Edge Function, senão o preflight do
         browser rejeita e o usuário vê "Failed to fetch". Ícones SVG (ex.:
         'x-circle': '<circle …>') são descartados — não são headers. */
  const frontHeaders = new Set();
  {
    const jsDir = path.join(__dirname, '..', 'src', 'js');
    const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));
    for (const f of files) {
      const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
      for (const m of src.matchAll(/['"](x-[a-z][a-z0-9-]*)['"]\s*:\s*([^,\n}]+)/g)) {
        const val = m[2].trim();
        if (val.startsWith("'<") || val.startsWith('"<')) continue; // ícone SVG
        frontHeaders.add(m[1]);
      }
      for (const m of src.matchAll(/headers[\s\S]{0,160}?['"](x-[a-z][a-z0-9-]*)['"]/g)) frontHeaders.add(m[2]);
    }
    const edgePath = path.join(__dirname, '..', 'supabase', 'functions', 'api', 'index.ts');
    const edge = fs.readFileSync(edgePath, 'utf8');
    const am = edge.match(/Access-Control-Allow-Headers['"]\s*:\s*['"]([^'"]+)['"]/);
    const allow = am ? am[1].split(',').map(s => s.trim()) : [];
    const missing = [...frontHeaders].filter(h => !allow.includes(h));
    check('CORS estático: headers x-* do front na allowlist da Edge',
      frontHeaders.size > 0 && missing.length === 0,
      `front usa ${[...frontHeaders].join(', ') || '—'} · allowlist: ${allow.join(', ') || 'NÃO ACHOU'}${missing.length ? ' · FALTANDO: ' + missing.join(', ') : ''}`);
  }

  /* 1 · site publicado */
  try {
    const r = await fetch(SITE, { redirect: 'follow' });
    const html = await r.text();
    check('Site publicado (GitHub Pages)', r.ok && /LojaCerta/i.test(html), `HTTP ${r.status} · ${SITE}`);
  } catch (e) { check('Site publicado (GitHub Pages)', false, e.message); }

  /* 2 · Edge ping */
  {
    const r = await j(`${BASE}/functions/v1/api`, { method: 'POST', headers: { ...H, Authorization: `Bearer ${ANON}` }, body: JSON.stringify({ op: 'ping' }) });
    check('Edge Function "api" (ping)', r.status === 200 && r.body && r.body.pong === true, `HTTP ${r.status}`);
  }

  /* 2b · CORS ao vivo: preflight OPTIONS com TODOS os headers que o front envia
          (incluindo os x-* detectados no check estático) — o DEPLOY tem que aceitar */
  {
    const reqHeaders = [...frontHeaders, 'authorization', 'apikey', 'content-type'].join(', ');
    const r = await fetch(`${BASE}/functions/v1/api`, {
      method: 'OPTIONS',
      headers: {
        'Origin': SITE,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': reqHeaders,
      },
    });
    const allow = (r.headers.get('access-control-allow-headers') || '').split(',').map(s => s.trim());
    const missing = [...frontHeaders].filter(h => !allow.includes(h));
    check('CORS ao vivo: preflight aceita os headers do front',
      r.status === 200 && missing.length === 0,
      `HTTP ${r.status} · pediu: ${reqHeaders}${missing.length ? ' · FALTANDO: ' + missing.join(', ') : ''}`);
  }

  /* 3 · RLS: anônimo não lê tickets */
  {
    const r = await j(`${BASE}/rest/v1/support_tickets?select=id&limit=5`, { headers: H });
    const empty = Array.isArray(r.body) ? r.body.length === 0 : true;
    check('RLS: leitura anônima de tickets bloqueada', r.status === 401 || (r.status === 200 && empty), `HTTP ${r.status}`);
  }

  /* 4 · RPC do badge exige sessão (anon não tem EXECUTE — PostgREST responde
         400 "permission denied" ou 401; o importante é NÃO executar) */
  {
    const r = await j(`${BASE}/rest/v1/rpc/support_badge_counts`, { method: 'POST', headers: H, body: '{}' });
    const blocked = r.status !== 200 || (r.body && (r.body.message || r.body.hint));
    check('RPC support_badge_counts exige sessão', blocked, `HTTP ${r.status}${r.body && r.body.message ? ' · ' + r.body.message : ''}`);
  }

  /* login do usuário comum de teste */
  if (!TEST_EMAIL || !TEST_PASSWORD) {
    console.log('\n⚠ TEST_EMAIL/TEST_PASSWORD não definidos — pulando testes autenticados.');
    return finish();
  }
  const lg = await j(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { ...H, Authorization: `Bearer ${ANON}` },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD })
  });
  check('Login do usuário de teste', lg.status === 200 && lg.body && lg.body.access_token, `HTTP ${lg.status}`);
  if (!(lg.body && lg.body.access_token)) return finish();
  const T = { ...H, Authorization: `Bearer ${lg.body.access_token}` };
  const me = lg.body.user;

  /* 5 · trilha global é dev-only (comum recebe FORBIDDEN) */
  {
    const r = await j(`${BASE}/rest/v1/rpc/admin_audit_list`, { method: 'POST', headers: T, body: JSON.stringify({ p_limit: 5 }) });
    const forbidden = r.status === 403 || (r.body && String(r.body.message || '').includes('FORBIDDEN'));
    check('RPC admin_audit_list é dev-only', forbidden, `HTTP ${r.status}`);
  }

  /* 6 · badge do usuário comum */
  {
    const r = await j(`${BASE}/rest/v1/rpc/support_badge_counts`, { method: 'POST', headers: T, body: '{}' });
    const ok = r.status === 200 && r.body && typeof r.body.aguardandoCliente === 'number' && typeof r.body.filaEquipe === 'number';
    check('Badge do usuário (support_badge_counts)', ok, r.status === 200 ? `aguardandoCliente=${r.body.aguardandoCliente}` : `HTTP ${r.status}`);
  }

  /* 7 · billing_refresh_status do próprio tenant */
  {
    const r = await j(`${BASE}/rest/v1/rpc/billing_refresh_status`, { method: 'POST', headers: T, body: '{}' });
    check('billing_refresh_status (retrato do tenant)', r.status === 200 && r.body && typeof r.body.status === 'string', r.status === 200 ? `status=${r.body.status}` : `HTTP ${r.status}`);
  }

  /* 8 · isolamento: listagem só devolve o próprio tenant */
  {
    const r = await j(`${BASE}/rest/v1/support_tickets?select=id,tenant_id&limit=200`, { headers: T });
    const rows = Array.isArray(r.body) ? r.body : [];
    const ownRes = await j(`${BASE}/rest/v1/tenants?select=id`, { headers: T });
    const own = Array.isArray(ownRes.body) && ownRes.body[0] ? ownRes.body[0].id : null;
    const foreign = rows.some(t => t.tenant_id !== own);
    check('Isolamento: tickets listados são só do próprio tenant', r.status === 200 && !foreign, `${rows.length} ticket(s)`);
  }

  /* 9 · forja de tenant_id barrada por RLS */
  {
    const r = await j(`${BASE}/rest/v1/support_tickets`, {
      method: 'POST', headers: { ...T, Prefer: 'return=representation' },
      body: JSON.stringify({ tenant_id: '00000000-0000-0000-0000-000000000000', user_id: me.id, numero: 999, assunto: 'FORJA SMOKE TEST', categoria: 'duvida', prioridade: 'media', status: 'aberto', descricao: 'tentativa de escrita em tenant alheio' })
    });
    check('Forja de tenant_id em insert barrada', r.status !== 201, `HTTP ${r.status}`);
  }

  /* 10 · guard de cobrança: PATCH direto é FORBIDDEN */
  {
    const tidRes = await j(`${BASE}/rest/v1/tenants?select=id`, { headers: T });
    const tid = Array.isArray(tidRes.body) && tidRes.body[0] ? tidRes.body[0].id : null;
    if (!tid) { check('Guard: PATCH em colunas de cobrança bloqueado', false, 'tenant não encontrado'); }
    else {
      const r = await j(`${BASE}/rest/v1/tenants?id=eq.${tid}`, {
        method: 'PATCH', headers: Object.assign({}, T, { Prefer: 'return=representation' }),
        body: JSON.stringify({ status: 'active', plan_id: 'premium', plan_expires_at: '2030-01-01' })
      });
      /* admin → trigger de guarda (400/403); não-admin → RLS v16 filtra a linha
         (200 com [] = nada alterado). Os dois são "bloqueado". */
      const nadaAlterado = r.status === 200 && Array.isArray(r.body) && r.body.length === 0;
      check('Guard: PATCH em colunas de cobrança bloqueado', r.status === 400 || r.status === 403 || nadaAlterado, `HTTP ${r.status}`);
    }
  }

  /* 11 · ops de cobrança da Edge exigem papel dev */
  {
    const r = await j(`${BASE}/functions/v1/api`, {
      method: 'POST', headers: T,
      body: JSON.stringify({ op: 'billing.activate_plan', payload: { tenantId: '00000000-0000-0000-0000-000000000000', planId: 'premium', cycle: 'mensal', days: 30 } })
    });
    check('Edge billing.activate_plan é dev-only', r.status === 403 && r.body && r.body.code === 'FORBIDDEN', `HTTP ${r.status} ${r.body ? r.body.code : ''}`);
  }

  /* 12 · RPC de venda valida entrada antes de qualquer escrita */
  {
    const r = await j(`${BASE}/rest/v1/rpc/commit_sale`, {
      method: 'POST', headers: T, body: JSON.stringify({ p: { items: [], payments: [] } })
    });
    check('RPC commit_sale valida entrada (não escreve por engano)', r.status !== 200, `HTTP ${r.status}`);
  }

  finish();
})().catch(e => { console.error('ERRO FATAL:', e.message); process.exit(1); });

function finish() {
  const ok = results.filter(r => r.ok).length;
  console.log(`\n========== SMOKE: ${ok}/${results.length} passaram ==========`);
  if (ok !== results.length) {
    results.filter(r => !r.ok).forEach(r => console.log('  ✘ ' + r.name));
    process.exit(1);
  }
}