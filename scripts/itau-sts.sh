#!/usr/bin/env bash
# Passos de rede do wizard do Itaú (scripts/wizard-sdc-itau.sh), separados para poderem ser testados.
# Segredos NUNCA vão em argumento de linha de comando (visíveis em `ps`): entram por variável de ambiente
# e seguem para o curl por stdin (`curl -K -`).
#
#   ITAU_TOKEN_TEMPORARIO=… itau-sts.sh solicitar <sts> <csr> <arquivo-resposta>
#   ITAU_CLIENT_ID=… ITAU_CLIENT_SECRET=… itau-sts.sh token <sts> <cert> <key> <arquivo-corpo>   (imprime o HTTP status)
set -euo pipefail
umask 077

# aspas e barras escapadas para o formato de config do curl
q() { local v=${1//\\/\\\\}; printf '"%s"' "${v//\"/\\\"}"; }

case "${1:-}" in
  solicitar)
    sts=$2 csr=$3 resp=$4
    # A resposta traz o Client Secret UMA vez só e o token temporário é de uso único: nunca sobrescrever.
    if [[ -s "$resp" ]]; then
      echo "resposta já obtida em $resp — reaproveitando, a solicitação NÃO foi reenviada" >&2
      exit 0
    fi
    : "${ITAU_TOKEN_TEMPORARIO:?token temporário ausente}"
    tmp=$(mktemp "$resp.XXXXXX")
    trap 'rm -f "$tmp"' EXIT
    status=$(printf 'header = %s\n' "$(q "Authorization: Bearer $ITAU_TOKEN_TEMPORARIO")" \
      | curl -sS -K - -o "$tmp" -w '%{http_code}' -X POST "$sts/seguranca/v1/certificado/solicitacao" \
          -H 'Content-Type: text/plain' --data-binary "@$csr") || status="erro"
    echo "HTTP $status" >&2
    if [[ "$status" =~ ^2 && -s "$tmp" ]]; then
      chmod 600 "$tmp"; mv -f "$tmp" "$resp"   # atômico: ou a resposta inteira, ou nada
      exit 0
    fi
    recusa="$resp.recusa-$(date +%Y%m%d%H%M%S)"
    chmod 600 "$tmp"; mv -f "$tmp" "$recusa"
    echo "o banco recusou; corpo em $recusa" >&2
    exit 1
    ;;
  token)
    sts=$2 cert=$3 key=$4 corpo=$5
    : "${ITAU_CLIENT_ID:?}" "${ITAU_CLIENT_SECRET:?}"
    printf 'data-urlencode = %s\ndata-urlencode = %s\n' "$(q "client_id=$ITAU_CLIENT_ID")" "$(q "client_secret=$ITAU_CLIENT_SECRET")" \
      | curl -sS -K - -o "$corpo" -w '%{http_code}' -X POST "$sts/api/oauth/token" \
          --cert "$cert" --key "$key" -H 'Content-Type: application/x-www-form-urlencoded' \
          --data-urlencode 'grant_type=client_credentials' || echo "erro"
    ;;
  *) echo "uso: itau-sts.sh solicitar|token …" >&2; exit 2 ;;
esac
