#!/usr/bin/env bash
# Passos de rede do wizard do Itaú (scripts/wizard-sdc-itau.sh), separados para poderem ser testados.
# Segredos NUNCA vão em argumento de linha de comando (visíveis em `ps`): entram por variável de ambiente
# e seguem para o curl por stdin (`curl -K -`).
#
#   ITAU_TOKEN_TEMPORARIO=… itau-sts.sh solicitar <sts> <csr> <arquivo-resposta>
#   ITAU_CLIENT_ID=… ITAU_CLIENT_SECRET=… itau-sts.sh token <sts> <cert> <key> <arquivo-corpo>   (imprime o HTTP status)
#   itau-sts.sh emitido <cert> <key>   (imprime onde está a prova de que o certificado JÁ foi emitido: local | 1password; sai 1 se não há)
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
  emitido)
    # N5: a resposta da solicitação pode ter sido apagada (o próprio wizard oferece) DEPOIS de o certificado ser salvo.
    # O token temporário já foi consumido nessa emissão: quem chama não deve pedi-lo de novo nem refazer o POST.
    # Não faz rede com o banco; só lê o disco e, se houver sessão, pergunta ao 1Password se os itens existem.
    cert=$2 key=$3
    if [[ -s "$cert" && -s "$key" ]]; then
      pub=$(openssl x509 -in "$cert" -noout -pubkey 2>/dev/null) || pub=""
      # certificado legível E da chave que está ao lado: sem as duas coisas não é prova de emissão
      if [[ -n "$pub" && "$pub" == "$(openssl pkey -in "$key" -pubout 2>/dev/null)" ]]; then echo local; exit 0; fi
    fi
    if command -v op >/dev/null 2>&1 && op whoami >/dev/null 2>&1 \
       && op item get "Itaú SDC - certificado" >/dev/null 2>&1 \
       && op item get "Itaú SDC - chave do certificado" >/dev/null 2>&1; then
      echo 1password; exit 0
    fi
    exit 1
    ;;
  *) echo "uso: itau-sts.sh solicitar|token|emitido …" >&2; exit 2 ;;
esac
