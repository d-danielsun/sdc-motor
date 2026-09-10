#!/usr/bin/env bash
# Exige que test, build e gitleaks passem antes de qualquer merge na main.
#
# POR QUE: um workflow que roda mas não bloqueia é decoração — dá pra mergear vermelho.
# Este script é a metade que transforma o CI em gate de verdade. É a única parte da
# issue #11 que não dá pra versionar como código, porque vive na config do repo; então
# fica versionado aqui como script idempotente: rodar duas vezes deixa o mesmo estado.
#
# CUIDADO: o PUT substitui o objeto de proteção INTEIRO. Qualquer ajuste feito depois pela
# interface (exigir review, exigir conversa resolvida) some na próxima execução. Mudou algo
# na interface? Traga a mudança pra cá antes de rodar de novo.
#
# Uso:  ./scripts/branch-protection.sh [--repo owner/nome] [--branch main] [--dry-run]
# Precisa de: gh autenticado com escopo repo (admin no repositório).
set -euo pipefail

REPO="" BRANCH="main" DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo)    REPO="${2:?--repo precisa do owner/nome}"; shift 2 ;;
    --branch)  BRANCH="${2:?--branch precisa do nome}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null || { echo "gh não está instalado: https://cli.github.com" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh não está autenticado — rode: gh auth login" >&2; exit 1; }
[ -n "$REPO" ] || REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"

# Os contexts são os ids dos jobs nos workflows. Mudou job id lá, muda aqui.
#   test, build  -> .github/workflows/ci.yml
#   gitleaks     -> .github/workflows/gitleaks.yml
# Formato `checks` (com app_id opcional) em vez do `contexts` plano, que a API marca como
# depreciado. Confirmado contra os check-runs reais do PR #17: test, build, gitleaks.
CHECKS='[{"context":"test"},{"context":"build"},{"context":"gitleaks"}]'

read -r -d '' PAYLOAD <<JSON || true
{
  "required_status_checks": { "strict": true, "checks": $CHECKS },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

echo "repo:    $REPO"
echo "branch:  $BRANCH"
echo "checks:  $CHECKS (strict: a branch precisa estar atualizada com a base)"
echo "admins:  a regra vale para admin também"

if [ "$DRY" = 1 ]; then
  echo; echo "--dry-run: nada foi alterado. Payload que seria enviado:"; echo "$PAYLOAD"; exit 0
fi

if ! printf '%s' "$PAYLOAD" | gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" --input - >/tmp/bp.$$ 2>/tmp/bp.err.$$; then
  echo "FALHOU ao aplicar a proteção:" >&2
  cat /tmp/bp.err.$$ >&2
  if grep -qi "upgrade\|not available\|403" /tmp/bp.err.$$; then
    echo >&2
    echo "Provável causa: proteção de branch em repositório PRIVADO exige plano pago" >&2
    echo "(GitHub Pro/Team). Rulesets NÃO são saída: estão atrás do mesmo paywall e" >&2
    echo "devolvem o mesmo 403. Saídas reais: deixar o repositório público, ou assinar" >&2
    echo "o plano. Enquanto isso o CI roda e sinaliza, mas não bloqueia o merge." >&2
  fi
  rm -f /tmp/bp.$$ /tmp/bp.err.$$; exit 1
fi

echo
echo "aplicado. Estado atual:"
gh api "repos/$REPO/branches/$BRANCH/protection" \
  --jq '{checks: .required_status_checks.contexts, strict: .required_status_checks.strict, enforce_admins: .enforce_admins.enabled, force_push: .allow_force_pushes.enabled, deletions: .allow_deletions.enabled}'
rm -f /tmp/bp.$$ /tmp/bp.err.$$
