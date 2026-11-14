#!/usr/bin/env bash
# ============================================================================
# LojaCerta · Smoke GATE (deploy-pages.yml)
# ----------------------------------------------------------------------------
# Envolve o smoke test com política de retry HONESTA:
#   · falha TRANSIENTE (HTTP 429/5xx, timeout, erro de rede) → repete com
#     backoff (20s, 40s), até 3 tentativas — um rate limit momentâneo do
#     Supabase não pode travar um deploy legítimo por 15 min;
#   · falha REAL de asserção (RLS vazando, CORS quebrado, login 4xx…) →
#     reprova NA HORA, sem retry: bug não se resolve com sorte, e retry
#     só esconderia o problema e queimaria minutos de CI.
# Classificação: uma tentativa é transiente só se TODAS as linhas de falha
# (✘ FALHOU / ERRO FATAL) baterem no padrão transiente. Na dúvida, reprova.
#
# Uso (CI):            bash tools/smoke-gate.sh
# Teste do gate:       SMOKE_CMD='bash /caminho/mock.sh' bash tools/smoke-gate.sh
#   (SMOKE_CMD existe para os testes do próprio gate — não use no CI)
# Exit: 0 = passou (na 1ª ou após retry transiente) · 1 = deploy bloqueado
# ============================================================================
set -u
cd "$(dirname "$0")/.."

MAX_ATTEMPTS="${SMOKE_MAX_ATTEMPTS:-3}"
SMOKE_CMD="${SMOKE_CMD:-node tests/smoke.test.js}"
# base do backoff: no CI espera 20s→40s; nos testes do gate usar SMOKE_BACKOFF_BASE=1
BACKOFF_BASE="${SMOKE_BACKOFF_BASE:-20}"
# sinais de infra momentânea (nunca de bug): status 429/5xx do Supabase/GH Pages
# e erros de rede do undici/Node. 'timeout'/'network' entram como substring
# porque é assim que aparecem nas mensagens do fetch do Node 20.
TRANSIENT_RE='HTTP 429|HTTP 5[0-9][0-9]|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|socket hang up|Service Unavailable|Bad Gateway|Gateway Timeout|timeout|network'

attempt=1
while :; do
  out="$($SMOKE_CMD 2>&1)"; rc=$?
  printf '%s\n' "$out"

  if [ "$rc" -eq 0 ]; then
    echo "SMOKE GATE: PASSOU na tentativa $attempt/$MAX_ATTEMPTS — deploy liberado."
    exit 0
  fi

  # linhas de falha: o passo do teste imprime '✘ FALHOU · <nome> → <detalhe>'
  # na hora e '  ✘ <nome>' no resumo (sem detalhe) — classificamos pelas
  # linhas COM detalhe; fatal é o crash fora dos checks.
  fail_lines="$(printf '%s\n' "$out" | grep -E '^(✘ FALHOU|ERRO FATAL)' || true)"

  if [ -z "$fail_lines" ]; then
    echo "SMOKE GATE: saída rc=$rc SEM linha de falha identificável — trata como falha REAL (conservador). Deploy bloqueado."
    exit 1
  fi

  non_transient="$(printf '%s\n' "$fail_lines" | grep -Ev "$TRANSIENT_RE" || true)"
  if [ -n "$non_transient" ]; then
    echo "SMOKE GATE: falha REAL de asserção (não-transiente) — sem retry. Deploy bloqueado. Falhas:"
    printf '%s\n' "$non_transient" | sed 's/^/    /'
    exit 1
  fi

  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "SMOKE GATE: $MAX_ATTEMPTS tentativas, todas com falha TRANSIENTE (429/5xx/rede) — deploy bloqueado. Investigar saúde do Supabase/GH Pages antes de rerodar."
    exit 1
  fi

  wait_s=$((attempt * BACKOFF_BASE))
  echo "SMOKE GATE: falha TRANSIENTE na tentativa $attempt/$MAX_ATTEMPTS — aguardando ${wait_s}s (backoff) e repetindo…"
  sleep "$wait_s"
  attempt=$((attempt + 1))
done
