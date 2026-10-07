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
