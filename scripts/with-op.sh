#!/usr/bin/env bash
# Roda um comando com os segredos exportados do 1Password (nunca grava em disco).
# Uso: scripts/with-op.sh npm run test:sandbox
set -euo pipefail

export ASAAS_URL="${ASAAS_URL:-https://api-sandbox.asaas.com/v3}"
export DATABASE_URL="${DATABASE_URL:-postgres://motor:motor@localhost:55432/motor}"

# ATENÇÃO ao `set -e` aqui: `export VAR="$(cmd)"` NÃO aborta quando `cmd` falha — o status que
# conta é o do `export`, que é sempre 0. Era o que acontecia: o `op` falhava, a chave saía vazia,
# e `npm run test:sandbox` PULAVA os 9 testes e terminava com sucesso. Um run que não testou nada
# ficava idêntico a um run que passou. Por isso a atribuição é separada, e há a checagem de vazio.
ITEM="${ASAAS_1P_ITEM:-Sandbox API Key AsaaS - SDC}"
CHAVE=""
if ! CHAVE="$(op item get "$ITEM" --fields credential --reveal 2>&1)"; then
  echo "with-op: não consegui ler \"$ITEM\" do 1Password." >&2
  echo "  $CHAVE" >&2
  echo "" >&2
  echo "  Campo secreto exige aprovação no app do 1Password, e ela só aparece num terminal seu." >&2
  echo "  Entre uma vez com \`eval \$(op signin)\` e rode de novo." >&2
  exit 1
fi
if [ -z "$CHAVE" ]; then
  echo "with-op: \"$ITEM\" existe mas o campo \`credential\` está vazio." >&2
  exit 1
fi
export ASAAS_API_KEY="$CHAVE"

exec "$@"
