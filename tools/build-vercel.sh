#!/usr/bin/env bash
# LojaCerta · build da Vercel (alojacerta.vercel.app) = MESMO pacote de produção
# do GitHub Pages, ligado ao Supabase. Os valores são públicos por design (a anon
# key só dá o que o RLS permite); a fonte é o workflow de deploy, para não divergir.
set -euo pipefail
cd "$(dirname "$0")/.."
ANON=$(grep -oP 'SUPABASE_ANON_KEY: \K\S+' .github/workflows/deploy-pages.yml)
SITE="https://${VERCEL_PROJECT_PRODUCTION_URL:-alojacerta.vercel.app}"
{
  echo "ENV=production"
  echo "SITE_URL=$SITE"
  echo "API_BASE=https://qmqllssextbxwwphawod.supabase.co"
  echo "SUPABASE_ANON_KEY=$ANON"
  echo "BILLING_PROVIDER=asaas"
} > .env
node tools/build.js --env=production
cp release/producao/index.html release/producao/404.html
echo "✔ Vercel: release/producao pronto (SITE_URL=$SITE)"
