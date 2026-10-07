# QA-gate — sprint/itau-pivo (origin/main..f8e7469)

**Veredito: NÃO-SHIP** — score **85/100** (limiar 90). Nenhum hard-fail mecânico, mas 2 bloqueadores.

Fase 3 (QA) com contexto limpo, 2026-10-07. Sem credencial real: nenhuma chamada a Itaú, Asaas ou Odoo.

## Evidência executada
- `npm test`: **285/285 verdes** (23 arquivos, linha de base 251). `npm run typecheck`: ok.
- `docs/sprint-itau/harness/score.sh`: todos os checks ok, `HARD-FAILS: nenhum`. `src/core` citando asaas: 12 (linha de base 14).
- Probes P1–P9: todos têm teste dedicado e passam (`test/db/gateway-probes.test.ts`, `test/unit/itau-{auth,gateway,certificate}.test.ts`).
- Testes do Itaú sobem servidor HTTPS local com `requestCert + rejectUnauthorized` e PKI gerada em tmpdir: o mTLS roda de verdade. Nenhum teste mocka a função que testa.
- Probes próprios do QA (testes temporários, já apagados): watchdog, reconcile, setConsoleConfig e syncInvoices com `ItauGateway` atrás da porta.
- `codex review --base origin/main`: rodou. 4 achados, 2 confirmados como bloqueadores (abaixo).
- Wizard: `bash -n` ok. A biblioteca é idêntica ao template mattpocock (`mattpocock-skills/1.2.3/.../wizard/template.sh`). Diverge do fork em `operator-skills`, mas a spec pede o mattpocock.
- §2 no browser: não se aplica (backend). A recusa de ligar a ida no console foi testada direto em `setConsoleConfig`: `true` dá `invalid_state`; `"true"`, `1` e `"1"` dão `invalid_input`.

## Score (loss.md)
| Dimensão | Peso | Nota | Motivo |
|---|---|---|---|
| Invariantes de dinheiro | 35 | 28 | A suíte e os probes passam. O memo continua `asaas:<pay_id>`, a parcela é lida por id, o residual é conferido antes e depois e os locks não mudaram. `IDA_ENABLED` e o cutoff ficam antes do `canIssue`. Mas o BLOQ-1 perde faturas em silêncio. |
| Desacoplamento | 20 | 18 | O núcleo não importa nada do Asaas e o boundary test está verde. Os 12 nomes legados estão justificados, mas os textos "no Asaas" seguem no núcleo. |
| Cliente Itaú | 20 | 18 | Token, cache ≤270 s, inflight compartilhado, 401 da API renova uma vez, 401 do STS sem retry. O mTLS é obrigatório: `rejectUnauthorized: true` fixo e recusa com `NODE_TLS_REJECT_UNAUTHORIZED=0`. Risco R2 (promise pendente). |
| Honestidade das lacunas | 15 | 15 | Nenhum endpoint ou payload de Cobrança V2 ou de aviso. Só existem as rotas STS de token e certificado que a spec fixou. 02-SPEC §Itaú lista as lacunas L1–L5. |
| Operabilidade | 10 | 6 | `.env.example`, README e `bash -n` ok. BLOQ-2 no wizard; segredos aparecem em argv (R4). |
| **Total** | 100 | **85** | |

## Hard-fails
Nenhum. Testes e typecheck verdes; contagem 285 ≥ 251; nenhum assert removido; sem `.only`/`.skip`; `IDA_ENABLED` continua default false; nada inventado; nenhum pem/key versionado; nenhuma chamada real.

## Bloqueadores

**BLOQ-1 — Com `GATEWAY=itau`, a varredura consome o watermark sem emitir e as faturas se perdem em silêncio.**
`src/core/usecases/handleInvoice.ts:51` (`if (!deps.gateway.canIssue) { out.skipped++; return; }`), junto com `src/core/usecases/syncInvoices.ts:60,72` (o watermark avança) e `src/cli/job.ts:23` (o CLI não chama `assertGatewayBoot`).
Cenário: `app_config.IDA_ENABLED=true` (herdado da era Asaas). Alguém roda `GATEWAY=itau npm run job -- sync-invoices`, ou a flag é ligada por SQL com o servidor no ar. As faturas são contadas como `skipped` e o watermark passa por elas. Ao voltar para um gateway que emite, essas faturas nunca recebem cobrança. Não abre exceção nem alerta.
Teste vermelho (confirmado, falha com `expected 0 to be greater than 0`):
```ts
it("BLOQ-1: sync com Itaú (ida ligada) não pode consumir o watermark", async () => {
  const w = await world(); seedInvoice(w);
  const c = new ItauClient({ clientId: "c", clientSecret: "s", tokenUrl: "https://127.0.0.1:1/t", cert: pki.clientCert, key: pki.clientKey, extraCa: null }, { transport: async () => ({ status: 500, body: "", headers: {} }) });
  await syncInvoices({ ...w.deps, gateway: new ItauGateway(c) });
  await syncInvoices(w.deps); // volta ao Asaas
  expect((await w.pool.query("select count(*)::int as n from charges")).rows[0].n).toBeGreaterThan(0);
});
```
Correção sugerida: em `syncInvoices`, tratar `!gateway.canIssue` como `enabled=false` antes de tocar no watermark, ou lançar um erro. Chamar `assertGatewayBoot` também no `src/cli/job.ts`. Atenção: o probe P3 atual ("ida ligada no banco → nenhuma exceção") fixa o comportamento errado e precisa passar a verificar também que o watermark não andou.

**BLOQ-2 — Ao retomar, o wizard sobrescreve a única cópia do Client Secret.**
`scripts/wizard-sdc-itau.sh:277-280`. O `curl -o "$RESPOSTA"` roda sem checar se o arquivo já existe.
Cenário: a solicitação dá certo (o token temporário é de uso único e a resposta traz o secret uma vez só). O humano interrompe antes do estágio 6 e roda o wizard de novo. O POST repetido recebe recusa e grava por cima de `itau-solicitacao-resposta.txt`. O secret se perde e é preciso pedir um token novo ao banco, o que custa dias.
Correção: se `$RESPOSTA` ou `$CERT` já existem, pular o POST (ou gravar a resposta num arquivo novo, com timestamp, e nunca sobrescrever).

## Riscos não bloqueantes (registrar e corrigir depois)
- **R1** `watchdog.ts:39`: com `GATEWAY=itau` e `ASAAS_WEBHOOK_ID` em `app_config` (o caso de produção), `getEventQueue` lança `GatewayNotReady`. O watchdog morre a cada tick antes de checar heartbeat e exceções travadas. Não é silencioso, porque o scheduler dispara `alertaJobFalhou`. Mesmo assim, perde-se a rede de alertas. O `reconcileDaily` lança do mesmo jeito.
- **R2** `src/adapters/itau/transport.ts:24-28`: a resposta não tem listener de `error`/`aborted`. Se a conexão cair depois dos headers, a promise pode ficar pendente para sempre e travar `ItauTokenProvider.inflight`. Hoje não tem efeito, porque nada chama o Itaú em produção. Precisa de correção antes da Cobrança V2.
- **R3** Cobranças Asaas abertas no momento de trocar para `GATEWAY=itau` deixam de receber baixa automática: os eventos caem em `error` e o reconcile lança. É visível, mas falta um runbook de troca. A spec não cobre.
- **R4** No wizard, o token temporário, o Client Secret (curl `-H`/`--data-urlencode`) e o `op item create "password=…"` passam em argv e ficam visíveis em `ps`. Além disso, `ENV_FILE` é relativo ao cwd.
- **R5** `score.sh` ignora o exit code do vitest (falha em `afterAll` passaria). O harness é proibido de editar nesta sprint. Conferi o `npm test` à parte: exit 0.
- **R6** O item 5 do goal (S0.1 Odoo somente-leitura) não foi executado. Fica pendente, registrado em implementation-notes.

## Decisões do QA
- Sem browser: o produto é backend. A §2 foi executada como suíte mais probes.
- O desvio da biblioteca em relação ao fork do operator-skills foi aceito, porque a spec pede o template mattpocock e o arquivo é idêntico a ele.
- O R1 foi rebaixado de bloqueador: o job falho gera alerta.
- O BLOQ-2 é bloqueador por custo, não por código: o token é de uso único e a correção é trivial.
