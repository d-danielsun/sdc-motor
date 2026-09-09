#!/usr/bin/env bash
# Roda um comando com os segredos exportados do 1Password (nunca grava em disco).
# Uso: scripts/with-op.sh npm run test:sandbox
set -euo pipefail
export ASAAS_URL="${ASAAS_URL:-https://api-sandbox.asaas.com/v3}"
export ASAAS_API_KEY="$(op item get veh6rk2s46irol6pddmcyobe3u --fields credential --reveal)"   # "Sandbox API Key AsaaS - SDC"
export DATABASE_URL="${DATABASE_URL:-postgres://motor:motor@localhost:55432/motor}"
exec "$@"
