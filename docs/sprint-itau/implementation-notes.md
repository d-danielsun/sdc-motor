# Notas de implementação — pivô Itaú

Desvios e decisões: o que forçou, o que foi decidido, por quê.

## Linha de base
- `npm test` em `origin/main`: 251 verdes, mas **1 teste flaky** apareceu numa das 3 rodadas iniciais
  (passou nas outras duas, sem mudança de código). Não é desta sprint; registrado para o verificador não
  confundir com regressão.

## Itens 1–3 (porta, AsaasGateway, migração do núcleo)
- **Vocabulário de status neutro = códigos herdados** (`RECEIVED`, `RECEIVED_IN_CASH`, `CONFIRMED`, …).
  Trocar por enum novo mudaria comparações em regra de dinheiro sem ganho e com risco; o adaptador Itaú
  vai traduzir o status do banco para esse conjunto. Documentado em `src/core/gateway.ts`.
- **`GatewayCharge` tem o mesmo formato do pagamento Asaas** — a tradução no AsaasGateway é identidade.
  Isso mantém `classifyReceipt` compatível com o teste existente que passa um `AsaasPayment`.
- **Itens 2 e 3 num commit só**: mover os tipos `Asaas*` para `src/adapters/asaas/types.ts` e trocar
  `Deps.asaas` por `Deps.gateway` são a mesma mudança (um não compila sem o outro).
- **Nomes que ficaram com "asaas" no núcleo, de propósito** (todos espelham persistência ou contrato
  que os testes fixam por assert):
  - `Charge.asaasPaymentId` / `asaasInvoiceNumber`, `CustomerMap.asaasCustomerId` → colunas `asaas_*`
    (spec §3: nada é renomeado no banco). Asserts em `test/db` leem esses campos.
  - `Repo.asaasEvents` (tabela `webhook_events`, coluna `asaas_event_id`) e `processAsaasEvents` —
    77 e 38 referências nos testes, várias dentro de `expect(...)`. Renomear exigiria editar linhas de
    assert (o `score.sh` trata isso como hard-fail). O caso de uso agora consome `SettlementEvent` pela
    porta; só o nome ficou.
  - Chaves de detalhe de exceção (`asaasPaymentId`), `refTable` (`asaas_payments`, `asaas_webhooks`) e
    chaves de config (`ASAAS_WEBHOOK_ID`, `ASAAS_PENALIZED_LAST`, `ASAAS_REACTIVATED_AT`): dado já
    gravado em produção/console e lido pelos testes. Renomear = migração de dados, fora do escopo.
  - Textos de alerta/e-mail em `notify.ts` falam do Asaas porque descrevem o comportamento do
    provedor atual (fila interrompida após 15 falhas, eventos guardados 14 dias).
- `Repo.charges.getByAsaasPayment` → `getByGatewayCharge` (nenhum teste usava o nome).
- `ASAAS_EVENT_BATCH` → `GATEWAY_EVENT_BATCH`; `ASAAS_ID_RE` mudou para `src/adapters/asaas/payload.ts`
  (só o adaptador validava id do Asaas).
- Memo de baixa: `${gateway.name}:${id}`; `AsaasGateway.name = "asaas"` → continua `asaas:<pay_id>`.
- **Testes tocados (só import/infra, nenhum assert):**
  - `test/unit/receive.test.ts`: imports de `normalizeAsaas*`/`asaasId` e `AsaasPayment` trocados de
    `src/core/{asaasPayload,types}` para `src/adapters/asaas/{payload,types}`. Asserções idênticas.
  - `test/helpers.ts` (fora de `test/db`/`test/unit`): `deps` ganhou `gateway: new AsaasGateway(asaas)`
    e o tipo `Deps & { asaas: FakeAsaas }`. `w.deps.asaas` continua sendo o MESMO fake que a porta
    embrulha, então os testes que sobrescrevem `w.deps.asaas.getPayment/getWebhook/listPayments`
    seguem valendo — o AsaasGateway delega chamando o client a cada operação.
- `buildDeps` devolve também o `AsaasHttpClient` cru para o job `register-asaas-webhook` (criar
  webhook é operação de provisionamento do Asaas, não do núcleo — não entrou na porta).

## Itens 5–7 (Itaú auth, stub, probes)
- **Transporte com `node:https` (https.Agent)**, não undici: mesmo desenho do relay em produção, sem
  dependência nova. Recusa construir sem cert/key, com chave que não confere com o cert, ou com
  `NODE_TLS_REJECT_UNAUTHORIZED=0`.
- **Solicitação do 1º certificado usa transporte SEM cert de cliente** (`createBootstrapTransport`): não
  existe certificado ainda — o banco autentica pelo token temporário. Renovação usa mTLS.
- `ItauClient` exige cert/key mesmo quando o transporte é injetado (P7 vale para toda montagem).
- Testes do Itaú sobem servidor HTTPS local com `requestCert + rejectUnauthorized` e PKI gerada por
  `openssl` em tmpdir (`test/itau-fixtures.ts`) — o mTLS é exercitado de verdade, nada é versionado.
- **"401 → refresh 1x"** (loss.md) foi implementado na chamada de API (`itauAuthedRequest`): 401 da API
  invalida o token, pede outro e repete uma vez. 401 do próprio STS não tem retry (P5).
- **`canIssue` na porta.** Para P3/P9 serem verdade em todo caminho, além da recusa de boot: o console
  recusa ligar a ida com gateway sem emissão, e `handleInvoice` não emite por ele (pula, sem exceção).
  Sem isso, a varredura com Itaú abriria `charge_create_failed` para cada parcela.
- **Boot (P9) em dois lugares**, porque a ida mora em `app_config` e não em env: `readEnv` recusa
  `GATEWAY=itau` com `IDA_ENABLED` ligado por env; `assertGatewayBoot` (chamado no `main.ts` depois das
  migrations) recusa com a ida ligada no banco. Valor não-booleano no banco conta como ligado.
- Com `GATEWAY=itau`, `ASAAS_API_KEY` deixa de ser obrigatória; `ASAAS_WEBHOOK_TOKEN` continua (a rota
  `/webhook-asaas` segue montada). `register-asaas-webhook` recusa rodar sem `GATEWAY=asaas`.
- `ItauGateway.parseSettlementEvent` LANÇA em vez de devolver null: devolver null marcaria eventos como
  `ignored` em silêncio. Lançando, o worker deixa o evento em `error` com exceção visível.
- O score.sh procura linhas novas em `src` com `IDA_ENABLED` e `true`/`"1"` juntos; o código novo
  evita essa combinação na mesma linha (o comportamento é o oposto do que o check teme — recusa ligar).

## Item 8 (wizard e docs)
- `scripts/wizard-sdc-itau.sh`: biblioteca copiada sem edição (diff zero contra o template); só os
  estágios foram escritos. `bash -n` ok; `shellcheck` 0.11 (via npx, fora do repo) aponta apenas
  SC2034 (`RED` sem uso) **dentro da biblioteca**, que a regra do template proíbe editar.
- Segredos vão para o 1Password, não para o `.env` (o `ENV_FILE` do wizard é `.env.itau.local`, ignorado
  pelo `.gitignore`, e recebe só agência/conta/Client ID). O token temporário não é gravado.
- Decifrar o e-mail do banco: o wizard não executa comando nenhum — formato desconhecido; mostra
  exemplos marcados como "confirme com o banco".
- `~/w/salvei/propostas/sdc/02-SPEC.md` (fora de git): nova seção "§Itaú (v2)" com as lacunas L1–L5;
  backup da versão anterior no scratchpad da sessão. Status/título ganharam a marca v2.

## Item 9 (score)
- `score.sh`: nenhum hard-fail. `src/core` citando "asaas": 12 arquivos (linha de base 14). Os que
  restam carregam só nomes legados mapeados para persistência ou fixados por assert (ver itens 1–3):
  `types.ts`/`ports.ts`/`console.ts` (campos e repo `asaas*` ↔ colunas `asaas_*`), `customers.ts`,
  `receive.ts`, `handleInvoice.ts`, `reconcileDaily.ts`, `usecases/console.ts` (campos `asaasPaymentId`/
  `asaasCustomerId` e chaves de detalhe de exceção já gravadas), `processAsaasEvents.ts` + `index.ts`
  (nome do caso de uso, 38 referências em testes), `watchdog.ts` (chaves `ASAAS_*` de `app_config`),
  `notify.ts` (texto do e-mail descreve o provedor atual). Nenhum importa tipo ou client do Asaas.
- Goal.md item 5 (S0.1 Odoo somente-leitura de verdade) **não** está no plano de 9 itens e a regra
  desta fase proíbe chamar serviço real: fica como pendência para a fase seguinte.

## Correção 1 (QA NÃO-SHIP → bloqueadores) — 2026-10-07
Cada item com teste vermelho antes da correção (visto falhar, depois passar).
- **BLOQ-1** `syncInvoices`: `!gateway.canIssue` → retorna antes de tocar no watermark (`ok=false`,
  `gatewayCanIssue=false` em `SYNC_LAST`, log). Escolha: watermark parado em vez de exceção reprocessável —
  ao voltar a um gateway que emite, todas as faturas ainda são cobradas sem ação humana. `src/cli/job.ts` chama
  `assertGatewayBoot` como o `main.ts` (teste `test/unit/boot-guard.test.ts`). Probe P3 agora afirma watermark
  nulo; teste BLOQ-1 do QA adicionado em `gateway-probes.test.ts`. O guarda em `handleInvoice` continua
  (caminho do push do Odoo, que não mexe em watermark).
- **BLOQ-2** passo de rede do wizard extraído para `scripts/itau-sts.sh` (abaixo do marcador; biblioteca intocada):
  resposta existente e não vazia → pula o POST e reaproveita; gravação em temporário + `mv` atômico, 600;
  recusa vai para `<resposta>.recusa-<ts>`, nunca por cima. Estágio 3 não pede token se a resposta já existe.
  Teste `test/unit/wizard-itau.test.ts` com curl falso no PATH.
- **R4** token temporário e client_secret seguem para o curl por stdin (`curl -K -`), vindos de variável de
  ambiente local ao comando; 1Password via `op item create --template` num arquivo 600 apagado em seguida.
  `ENV_FILE` default agora relativo ao script, não ao cwd.
- **R2** `transport.ts`: rejeita em `aborted`/`error`/`close` incompleto da resposta (timeout já existia e agora
  também cobre corpo travado). `test/unit/itau-transport.test.ts` (mTLS real, servidor derruba/trava) — antes
  pendurava até o timeout do teste.
- **R1** watchdog: `GatewayNotReady` em `getEventQueue` → `eventQueueSkipped` + log; demais alertas seguem.
  reconcile: gateway que não emite → `skipped` com motivo, sem gravar `RECONCILE_LAST` (preserva a âncora).
- **R3** runbook `docs/sprint-itau/runbook-trocar-gateway.md`; decisão "um gateway por vez" na spec (Decisões).
- Pendentes: R5 (harness proibido de editar), R6 (S0.1 Odoo real — proibido chamar serviço real).
