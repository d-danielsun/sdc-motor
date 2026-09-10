#!/usr/bin/env bash
# Roda um comando com a API key do Odoo exportada do 1Password (nunca grava em disco).
# Uso: scripts/with-op-odoo.sh npm run test:odoo
set -euo pipefail
ITEM="${ODOO_1P_ITEM:-Odoo API Key - SDC}"

if ! op item get "$ITEM" >/dev/null 2>&1; then
  cat >&2 <<EOF
1Password: item "$ITEM" não encontrado.

Como criar a chave (2 min, não precisa ser admin — vale no seu próprio usuário):
  1. Entre em ${ODOO_URL:-https://sdctech.odoo.com}
  2. Canto superior direito → Minhas preferências → aba "Segurança da conta"
  3. "Nova chave de API" → nome: salvei-motor → duração: a máxima → copie
  4. Guarde sem passar pelo chat:
       op item create --category password --title "$ITEM" password="\$(pbpaste)"
EOF
  exit 1
fi

# a chave pode estar como password (LOGIN/PASSWORD) ou credential (API_CREDENTIAL)
ODOO_API_KEY="$(op item get "$ITEM" --fields password --reveal 2>/dev/null || true)"
[ -z "$ODOO_API_KEY" ] && ODOO_API_KEY="$(op item get "$ITEM" --fields credential --reveal)"
export ODOO_API_KEY
export ODOO_URL="${ODOO_URL:-https://sdctech.odoo.com}"
export ODOO_DB="${ODOO_DB:-sdctech}"
exec "$@"
