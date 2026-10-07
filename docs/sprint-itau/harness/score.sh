#!/usr/bin/env bash
# Checagens mecânicas dos hard-fails. Não altera nada. Uso: docs/sprint-itau/harness/score.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0; ok(){ printf '  ok   %s\n' "$1"; }; ko(){ printf '  FAIL %s\n' "$1"; fail=1; }
npm run -s typecheck >/dev/null 2>&1 && ok typecheck || ko typecheck
out=$(npx vitest run test/unit test/db --reporter=json 2>/dev/null | tail -1)
pass=$(printf '%s' "$out" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["numPassedTests"])' 2>/dev/null || echo 0)
failed=$(printf '%s' "$out" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["numFailedTests"])' 2>/dev/null || echo 1)
[ "$failed" = 0 ] && ok "testes verdes ($pass)" || ko "testes vermelhos ($failed)"
[ "$pass" -ge 251 ] && ok "contagem >= 251" || ko "contagem caiu: $pass"
git diff origin/main --name-only | grep -qE '^test/(db|unit)/' && { git diff origin/main -U0 -- test/db test/unit | grep -E '^-\s*(expect|it\(|test\()' && ko "assert existente removido" || ok "nenhum assert existente removido"; } || ok "testes antigos intocados"
git grep -nE '\.(only|skip)\(' -- test | grep -v sandbox && ko ".only/.skip em test" || ok "sem .only/.skip"
git diff origin/main -- src | grep -E '^\+.*IDA_ENABLED.*(true|"1")' && ko "IDA_ENABLED default mudou" || ok "IDA_ENABLED intacto"
git ls-files | grep -E '\.(pem|key|crt|p12)$' && ko "segredo versionado" || ok "sem pem/key/crt versionado"
n=$(git grep -il asaas -- src/core | grep -vE 'src/core/(legacy|gateway)' | wc -l | tr -d ' ')
echo "  info arquivos de src/core citando asaas: $n (linha de base 14)"
[ $fail = 0 ] && echo "HARD-FAILS: nenhum" || echo "HARD-FAILS: presentes"; exit $fail
