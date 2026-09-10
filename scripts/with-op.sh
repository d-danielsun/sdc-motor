#!/usr/bin/env bash
# Roda um comando com os segredos exportados do 1Password (nunca grava em disco).
# Uso: scripts/with-op.sh npm run test:sandbox
set -euo pipefail
export ASAAS_URL="${ASAAS_URL:-https://api-sandbox.asaas.com/v3}"
export ASAAS_API_KEY="$(op item get "${ASAAS_1P_ITEM:-Sandbox API Key AsaaS - SDC}" --fields credential --reveal)"
export DATABASE_URL="${DATABASE_URL:-postgres://motor:motor@localhost:55432/motor}"
exec "$@"
