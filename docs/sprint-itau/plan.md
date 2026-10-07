# Plano — pivô Itaú

1. **Porta** `src/core/gateway.ts` (tipos neutros + `ChargeGateway` + `GatewayNotReady`). Prova: typecheck.
2. **AsaasGateway** em `src/adapters/asaas/gateway.ts` embrulhando o client; fake equivalente (`fakes/fakeGateway` ou o fakeAsaas exposto pela porta). Prova: testes do adaptador.
3. **Migrar o núcleo** (`src/core/**` e usecases: handleInvoice, processAsaasEvents, receive, customers, reconcileDaily, watchdog, notify, console, limits, asaasPayload) para a porta; `wiring.ts` escolhe o gateway. Repo mantém colunas `asaas_*` com mapeamento. Prova: **suíte inteira verde sem editar asserts** (251+).
4. **Boundary**: estender `test/unit/boundary.test.ts` para proibir import de `adapters/asaas` e tipos `Asaas*` em `src/core` (exceto onde a spec permitir explicitamente). Prova: teste.
5. **Itaú auth + headers + certificado** com testes unitários contra servidor fake (P5, P6, P7). Prova: `test/unit/itau-*.test.ts`.
6. **ItauGateway** stub + seleção `GATEWAY` + recusa de boot (P8, P9). Prova: testes.
7. **Probes P1–P4** como testes db rodando pela porta. Prova: testes.
8. **Wizard** + `.env.example` + README + §Itaú na 02-SPEC. Prova: `bash -n`, shellcheck.
9. `docs/sprint-itau/harness/score.sh` sem hard-fail; `implementation-notes.md` atualizado.
