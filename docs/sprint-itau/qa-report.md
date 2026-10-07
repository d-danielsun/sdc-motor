# QA-gate — sprint pivô Itaú, ciclo 3 e último (`sprint/itau-pivo`)

**Veredito: SHIP. Score 93/100, limiar 90. Zero P1 aberto.**

Diff `origin/main..HEAD` até `41f8b6c`: 56 arquivos, +2191/−174. Backend, sem UI nova. A §2 é a suíte mais as probes P1–P9.

## Evidência
- `npm test` (vitest unit + db, Postgres de teste 127.0.0.1:55432): 26 arquivos, **299/299 verdes**. O **exit code foi conferido à parte e deu 0**. As 8 suítes `test/db` rodaram, nenhuma pulada (`gateway-probes` tem 9 testes).
- `npx tsc --noEmit`: exit 0.
- `harness/score.sh`: `HARD-FAILS: nenhum`. Typecheck ok, 299 testes ≥ 251, nenhum assert removido, sem `.only`/`.skip`, `IDA_ENABLED` intacto, nenhum pem/key/crt versionado. O núcleo cita "asaas" em 12 arquivos (a linha de base era 14).
- `harness/probe.sh`: P1–P9 listadas, sem falha. Os testes de `gateway-probes`, `itau-*` e `boot-guard` estão verdes.
- `codex review --base origin/main`: 4 achados P2, todos já conhecidos (N3, N4, N5, R5). Nenhum P1.
- Nenhum serviço real foi chamado.

## BLOQ-3: verificação
- `git ls-files node_modules` volta **vazio**. O commit `41f8b6c` remove o link do índice.
- `.gitignore` tem `node_modules` sem barra, o que cobre symlink e diretório. `git status` está limpo, com o link local presente e ignorado.
- `git ls-files -s` não acha **nenhum** symlink (modo 120000) versionado no repo.
- Fora de `src/`, `test/` e `docs/`, o diff toca só `.env.example`, `.gitignore`, `CLAUDE.md`, `README.md`, `scripts/itau-sts.sh` e `scripts/wizard-sdc-itau.sh`, e todos são esperados. Nenhum segredo literal no diff.

## Score (loss.md)
| Dimensão | Peso | Nota | Motivo |
|---|---|---|---|
| Invariantes de dinheiro | 35 | 33 | BLOQ-1 continua corrigido e testado. O N2 foi fechado: o runbook conta `exception` (status válido do schema, `src/core/charges.ts:3`). Perde 2 pontos pelo N3 (o job diário roda de novo a cada minuto com Itaú). |
| Desacoplamento | 20 | 18 | Igual ao ciclo 2: ainda há textos "no Asaas" no núcleo (12 arquivos). |
| Cliente Itaú | 20 | 20 | Sem regressão. Transporte, token e mTLS seguem testados. |
| Honestidade das lacunas | 15 | 15 | Nenhum endpoint inventado. As lacunas estão registradas. |
| Operabilidade | 10 | 7 | O BLOQ-3 foi resolvido. Restam N4 (boot guard trava o `console-user`) e N5 (retomada do wizard). |
| **Total** | 100 | **93** | |

## Status dos itens antigos
| Item | Status |
|---|---|
| BLOQ-1 sync consome o watermark com Itaú | CORRIGIDO (ciclo 2), sem regressão |
| BLOQ-2 wizard sobrescreve a resposta | CORRIGIDO (ciclo 2), sem regressão |
| BLOQ-3 link `node_modules` versionado | **CORRIGIDO**, verificado acima |
| R1 watchdog e reconcile com Itaú | CORRIGIDO. A regressão N3 virou follow-up |
| R2 promise pendente no transporte | CORRIGIDO |
| R3 runbook de troca | **CORRIGIDO**, agora com o N2 incluído |
| R4 segredos em argv | CORRIGIDO |
| R5 `score.sh` ignora o exit do vitest | **CORRIGIDO** em `fix/itau-followups` (ver implementation-notes) |
| R6 S0.1 Odoo somente-leitura | ABERTO por regra, fora da sprint |
| N2 runbook ignora `exception` | **CORRIGIDO** em `41f8b6c` |
| N3 reconcile-daily roda a cada minuto com Itaú | **CORRIGIDO** em `fix/itau-followups` |
| N4 job.ts recusa `console-user` com Itaú e ida ligada | **CORRIGIDO** em `fix/itau-followups` |
| N5 wizard pede o token já consumido se a resposta for apagada | **CORRIGIDO** em `fix/itau-followups` |

## Achados novos
Nenhum. O codex e a revisão manual não acharam nada fora de N3, N4, N5 e R5. O commit de correção mexe só em `.gitignore`, no runbook e na remoção do link, então não há superfície nova de código.

## Caça-unknowns (§3)
SEM-UNKNOWNS NOVOS. A correção não toca código de produção. As sondas do ciclo 2 continuam válidas: dados legados, troca de gateway com cobrança aberta ou em exceção, inflight concorrente do token, boot com a ida ligada. O que elas acharam virou N2 (fechado) e N3, N4 e N5 (follow-ups).

## Follow-ups P2 (não bloqueantes)
- N3: `reconcileDaily` com Itaú não grava âncora. O scheduler roda de novo a cada minuto depois das 06:00 e repete as purgas. Registrar a execução pulada.
- N4: `job.ts` aplica o boot guard ao `console-user`. Isentar a administração do console.
- N5: o wizard não reconhece cert/key já salvos quando a resposta foi apagada, e pede de novo o token consumido.
- R5: `score.sh` deve tratar exit ≠ 0 do vitest como hard-fail (numa sprint que libere o harness).
- R6: S0.1, validar o Odoo real em somente-leitura.

## Decisões registradas
- D1 (conservadora): o TEST-PLAN.md não foi criado. Este relatório faz o papel das §1–§5, e a ordem era commitar só este arquivo.
- D2 (recommended): R5 fica como follow-up, com a mitigação de conferir o exit do `npm test` à parte.
- D3 (recommended): os 4 P2 do codex foram classificados como já conhecidos. Nenhum é P1, então não bloqueiam.

Deploy: sem SQL. Próximo passo: `/gstack-ship`.
