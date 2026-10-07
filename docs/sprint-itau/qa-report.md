# QA-gate — sprint pivô Itaú, ciclo 2 (`sprint/itau-pivo`)

**Veredito: NÃO-SHIP.** Score **92/100** (limiar 90). Nenhum hard-fail da loss. Sobra **1 bloqueador novo** (BLOQ-3), criado pela própria correção 1: um symlink `node_modules` foi commitado. A correção é de uma linha.

Diff avaliado: `origin/main..HEAD`, 16 commits. A correção 1 vai de `c39b960` a `32ccefd`.

## Evidência
- `npm run typecheck`: ok. `npm test`: **299/299 verdes, exit 0**. Rodei o exit code à parte por causa do R5. No ciclo 1 eram 281.
- `harness/score.sh`: todos os checks ok, `HARD-FAILS: nenhum`. `src/core` citando asaas: 12 (linha de base 14).
- `harness/probe.sh`: P1 a P9 listados. Todos estão cobertos por testes verdes (`test/db/gateway-probes.test.ts`, `itau-*.test.ts`, `boot-guard.test.ts`).
- `bash -n` ok nos dois scripts. shellcheck não está instalado neste host.
- Nenhum assert removido. O único `-` em `test/` na correção 1 é uma linha de import que ganhou nomes.
- `codex review --base origin/main` rodou e trouxe 1 P1 e 4 P2. Todos foram conferidos abaixo.
- Não houve UI nova, então a §2 do gate foi a suíte mais os probes. Nenhuma chamada a Itaú, Asaas ou Odoo real.

## Score (loss.md)
| Dimensão | Peso | Nota | Motivo |
|---|---|---|---|
| Invariantes de dinheiro | 35 | 33 | O BLOQ-1 está corrigido e testado: o watermark fica parado e, ao voltar para o Asaas, a fatura é cobrada. Perde 2 pontos por N2 (o runbook não cobre baixa em `exception`) e por N3 (o job diário roda de novo a cada minuto). |
| Desacoplamento | 20 | 18 | Nada mudou desde o ciclo 1. Os textos "no Asaas" continuam no núcleo. |
| Cliente Itaú | 20 | 20 | O R2 está corrigido: `aborted`, `error`, `close` e `!complete` rejeitam como transiente, e o inflight do token é liberado. Tem 3 testes. |
| Honestidade das lacunas | 15 | 15 | Nenhum endpoint ou payload novo inventado. O runbook e a spec registram a decisão de usar um gateway por vez. |
| Operabilidade | 10 | 6 | O BLOQ-2 e o R4 estão corrigidos, e `ENV_FILE` agora é absoluto. Perde pontos pelo BLOQ-3 (symlink commitado), por N4 (o boot guard trava o `console-user` e dá uma mensagem que engana) e por N5 (retomada do wizard). |
| **Total** | 100 | **92** | |

## Status dos itens do ciclo 1
| Item | Status | Verificação |
|---|---|---|
| BLOQ-1 sync consome o watermark com Itaú | **CORRIGIDO** | `syncInvoices.ts:22-28` retorna antes de varrer, com `ok=false` e o watermark intocado. Teste em `gateway-probes`: "BLOQ-1 … ao voltar ao Asaas a fatura é cobrada". Com `GATEWAY=asaas`, `canIssue=true` e o caminho antigo continua idêntico: o retorno antecipado não esconde nenhum erro do Asaas. Com Itaú, o caminho só é alcançável se a ida estiver ligada, e isso já é barrado no boot (`wiring.ts:41,83`) e no console (`console.ts:208`). |
| BLOQ-2 wizard sobrescreve a resposta | **CORRIGIDO** | `itau-sts.sh solicitar` não reenvia se `-s $resp`. A gravação é atômica (mktemp + mv) e a recusa vai para um arquivo à parte. O wizard pula o token quando a resposta já existe. São 4 testes. Resta o N5. |
| R1 watchdog e reconcile lançam com Itaú | **CORRIGIDO** | O watchdog só captura `GatewayNotReady` e os demais alertas seguem (teste com `travadas`). O reconcile pula sem gravar `RECONCILE_LAST`. Isso criou a regressão N3. |
| R2 promise pendente no transporte | **CORRIGIDO** | `transport.ts:28-36`. Testes: conexão cai depois dos headers, corpo trava e o inflight é liberado. |
| R3 runbook de troca | **CORRIGIDO, mas incompleto** | O runbook existe. A pré-condição ignora `exception`, ver N2. |
| R4 segredos em argv | **CORRIGIDO** | Os segredos passam por env e chegam ao `curl -K -` via stdin. O 1Password usa template 600 apagado depois. `ENV_FILE` é ancorado em `SCRIPT_DIR`. Há teste. |
| R5 `score.sh` ignora o exit do vitest | ABERTO, por regra | O harness é proibido nesta sprint. Mitigado: o exit do `npm test` foi conferido à parte e deu 0. O codex reapontou. |
| R6 S0.1 Odoo somente-leitura | ABERTO, por regra | Continua registrado em implementation-notes. |

## Bloqueador
**BLOQ-3 — `node_modules` foi commitado como symlink para outro worktree** (`node_modules -> ../sdc-motor-issues/node_modules`, entrou em `2329fb7`). O `.gitignore` tem `node_modules/`, com barra no final, e esse padrão não casa com um symlink. Consequências:
- Depois do merge, todo clone novo de main recebe um link quebrado e o `npm ci`/`npm install` falha ou se comporta mal.
- Num host onde o destino existe, o `npm ci` deste repo segue o link e apaga as dependências do worktree `sdc-motor-issues`.

Cenário: `git clone … && npm ci` num diretório limpo.
Teste vermelho proposto (unit): `expect(execSync("git ls-files node_modules").toString().trim()).toBe("")`.
Correção: `git rm --cached node_modules` e trocar o padrão para `node_modules` (sem barra) no `.gitignore`.

## Achados novos, não bloqueantes (viram issue ou follow-up)
- **N2 [P2]** `runbook-trocar-gateway.md:11-12`: a pré-condição só olha `created`/`confirmed`. Uma cobrança em `exception` (Asaas `RECEIVED` com o `registerPayment` do Odoo falhando) passa pela checagem. Depois da troca, reprocessar dá `GatewayNotReady` e a baixa fica órfã. Correção: incluir `exception`, eventos de webhook pendentes e exceções abertas na consulta. Teste proposto (db): com uma cobrança em `exception`, a consulta da pré-condição tem que voltar não vazia.
- **N3 [P2] regressão do R1** `reconcileDaily.ts:33-36` junto com `scheduler.ts:81-87`: com Itaú, `RECONCILE_LAST` nunca é gravado, então `dailyDue()` fica sempre verdadeiro. Depois das 06:00 BRT o `reconcile-daily` roda **a cada minuto**, inclusive as purgas de audit, eventos e sessões (`scheduler.ts:12-14,30`). As purgas são idempotentes, mas isso gera carga e cerca de 1.000 logs por dia. Antes da correção acontecia o mesmo, só que com alerta de falha. Correção: gravar uma marca separada (`RECONCILE_SKIPPED_AT`) e fazer o `dailyDue` considerá-la, preservando a âncora. Teste proposto: com o scheduler, Itaú e o relógio às 10:00, dois `tick()` seguidos devem rodar o `reconcile-daily` uma vez só.
- **N4 [P2] regressão do BLOQ-1** `cli/job.ts:26`: o `assertGatewayBoot` roda para **todo** job, inclusive o `console-user`, que só mexe no banco. Com `GATEWAY=itau` e a ida ligada, `main.ts` e todos os jobs recusam subir, e a mensagem manda "desligue a ida no console", que também não sobe. Há saída: voltar para `GATEWAY=asaas` (que exige as chaves Asaas) ou fazer um UPDATE manual. `db:migrate` não é afetado, porque usa `cli/migrate.ts`. O runbook evita esse estado, porque a ida é desligada antes da troca, então nada fica travado sem saída. Correção: isentar `console-user` ou, melhor, aplicar o guard só aos jobs que tocam o gateway, e incluir na mensagem o caminho de recuperação. Teste proposto: `console-user --list` com o Itaú e a ida ligada deve sair com 0.
- **N5 [P2]** `wizard-sdc-itau.sh:251-255`: se a pessoa apagar a resposta depois de guardar tudo no 1Password e retomar o wizard, ele pede de novo o token temporário, que já foi consumido, e tenta refazer a solicitação, mesmo com o cert e a chave presentes. Correção: tratar a existência de `$CERT` e `$CERT_KEY` como "já emitido". Não há risco de perder dinheiro nem segredo, porque nada é sobrescrito.
- **R5 e R6** seguem como no ciclo 1.

## Caça-unknowns (§3)
- U1 = BLOQ-3, achado lendo o `--stat` da correção, não o código.
- U2 = N4, a sonda pedida: o guard trava operação necessária? Só no estado proibido, e há saída.
- U3 = N3, a sonda pedida: o early return do R1 interage mal com o agendador.
- Sync com `GATEWAY=asaas`: SEM-UNKNOWNS. O caminho é idêntico e `gatewayCanIssue=true` é só um campo novo no resumo.

## Decisões registradas
- Os achados N2 a N5 foram rebaixados a P2 porque nenhum perde dinheiro em silêncio e todos são evitáveis seguindo o runbook.
- O BLOQ-3 é bloqueador mesmo com score ≥ 90: é um P1 de higiene que vai para main, e o gate exige zero P1.
- Não abri issue no tracker (o ciclo é sem push). Os follow-ups ficam listados aqui.

```
QA-GATE: NÃO-SHIP — pivô Itaú (sprint/itau-pivo)

Roteiro §2:      suíte 299/299 + probes P1–P9 verdes
Caça-unknowns §3:3 achados — 1 bloqueante (BLOQ-3), 2 follow-up (N3, N4)
Review:          1 P1 aberto (BLOQ-3, codex confirmou), 4 P2
Testes:          npm test 299 verdes, exit 0; typecheck ok

Bloqueadores:
- BLOQ-3: git rm --cached node_modules; .gitignore `node_modules` sem barra

Follow-ups: N2 runbook+exception · N3 reconcile por minuto · N4 guard no console-user · N5 retomada do wizard · R5 · R6
Deploy: sem SQL
Próximo passo: corrigir BLOQ-3 e rerodar /qa-gate (rápido)
```
