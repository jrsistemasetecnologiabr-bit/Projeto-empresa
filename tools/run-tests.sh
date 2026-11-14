#!/usr/bin/env bash
# ============================================================================
# LojaCerta · RUN-TESTS — suíte reproduzível de verificação (dev machine/CI)
# ----------------------------------------------------------------------------
# O que faz (na ordem):
#   1. Sintaxe: todos os módulos JS de src/js devem parsear (node --check)
#   2. Build:   bundle de produção gera sem erro (node tools/build.js)
#   3. Smoke:   testes de produção contra o site + Supabase publicados
#               (tests/smoke.test.js — 13 checagens: RLS, guard, RPCs, Edge)
#
# Uso:
#   ./tools/run-tests.sh                 # sintaxe + build + smoke (precisa .env)
#   ./tools/run-tests.sh --no-build      # pula o build (mais rápido)
#   ./tools/run-tests.sh --syntax-only   # só a checagem de sintaxe
#
# Requisitos: Node 20+, curl. Credenciais vêm do .env (SITE_URL, API_BASE,
# SUPABASE_ANON_KEY, TEST_EMAIL, TEST_PASSWORD) ou de variáveis de ambiente.
# Exit code != 0 se qualquer etapa falhar.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

VERDE='\033[0;32m'; VERM='\033[0;31m'; CIANO='\033[0;36m'; SEMCOR='\033[0m'
pass=0; fail=0
step() { echo -e "${CIANO}▶ $1${SEMCOR}"; }
ok()   { echo -e "${VERDE}✔ $1${SEMCOR}"; pass=$((pass+1)); }
bad()  { echo -e "${VERM}✘ $1${SEMCOR}"; fail=$((fail+1)); }

# ---------- 1 · sintaxe de todos os módulos ----------
step "1/3 · Sintaxe dos módulos (src/js)"
for f in src/js/*.js; do
  if node --check "$f" >/dev/null 2>&1; then ok "$f"; else bad "$f (erro de sintaxe)"; fi
done
if [ "$fail" -gt 0 ]; then echo "Corrija os erros de sintaxe antes de continuar."; exit 1; fi

if [ "${1:-}" = "--syntax-only" ]; then
  echo; echo -e "Sintaxe: ${pass} ✔, ${fail} ✘"; exit $([ "$fail" -eq 0 ] && echo 0 || echo 1)
fi

# ---------- 2 · build de produção ----------
if [ "${1:-}" != "--no-build" ]; then
  step "2/3 · Build do bundle (produção)"
  if node tools/build.js --env=production >/tmp/lc_build.log 2>&1; then
    ok "bundle gerado em release/producao/index.html ($(du -h release/producao/index.html | cut -f1))"
  else
    bad "build falhou:"; tail -20 /tmp/lc_build.log; exit 1
  fi
else
  step "2/3 · Build (pulado — --no-build)"
fi

# ---------- 3 · smoke de produção ----------
step "3/3 · Smoke test de produção (site + Supabase)"
if node tests/smoke.test.js; then ok "smoke test"; else bad "smoke test (ver saída acima)"; fi

echo
echo -e "========== RESULTADO: ${pass} ✔ · ${fail} ✘ =========="
[ "$fail" -eq 0 ] || exit 1