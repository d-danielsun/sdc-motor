# TEST-PLAN — Fundação do motor de cobrança Odoo ↔ Asaas (S1–S5 API)  (spec 02-SPEC.md v1.1)

> Um por feature, versionado na branch, junto do código — vive dentro do PR.
> §1/§2/§4/§5 são o de sempre (o que mudou, roteiro, evidência, follow-ups).
> A §3 (caça-unknowns) é o passo obrigatório: o que só aparece USANDO.

## 1. O que foi implementado  (o MAPA)
Fatura de cliente postada no Odoo vira 1 boleto Asaas por parcela; `PAYMENT_RECEIVED` vira baixa na parcela exata; o que foge do trilho (cliente sem CPF/CNPJ, valor divergente, juros, estorno, fila do Asaas parada) vira exceção numa API de console que o financeiro opera. Tudo roda em Postgres puro + Node, hoje local/container, amanhã Supabase ou GCP/AWS. · Spec: `~/w/salvei/propostas/SDC/02-SPEC.md` v1.1
Superfícies: `POST /webhook-asaas` · `POST /webhook-odoo?k=` · `GET /health` · `/api/v1/{exceptions,charges,dashboard,health-report,config,customers/enable-notifications}` · jobs `worker`, `sync-invoices`, `reconcile-daily`, `watchdog` · `db/migrations/0001–0004` · `Dockerfile`/`docker-compose.yml`
Personas afetadas: **Fernanda (financeiro SDC)** opera exceções e gates pelo console; **Asaas** e **Odoo** são atores externos que batem nos webhooks; **Dan (operador)** roda jobs e migrations.
Deploy: aplicar `db/migrations/*.sql` ANTES do código (`npm run db:migrate`; o compose faz isso no serviço `migrate` e o motor recusa subir sem migração); env obrigatório `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` (≥32), `ODOO_WEBHOOK_KEY` (≥32) — falha fechada; `CONSOLE_TOKEN` (≥32) senão a API responde 503; `IDA_ENABLED` nasce `false` (gate R1 liga pelo console). Postgres do compose só em 127.0.0.1 e senha por `POSTGRES_PASSWORD`.

## 2. Roteiro de verificação  (território CONHECIDO — o agente executa)
> Serviço sem UI: [AUTO] = agente com curl no motor rodando em `localhost:8787` + vitest. Sem passo [MANUAL].
### 2.1 fluxo feliz
- [x] [AUTO] `GET /health` → 200 `{ok:true, idaEnabled:false}` (kill switch nasce desligado)
- [x] [AUTO] Odoo → `POST /webhook-odoo?k=<key>` `{_model,_id,_action}` com IDA desligada → 200 em <300 ms e evento gravado como `ignored`
- [x] [AUTO] Fernanda → `PUT /api/v1/config/IDA_ENABLED {value:true}` → 200; `GET /config` reflete; `GET /health` reflete
- [x] [AUTO] Odoo → mesmo POST com IDA ligada → evento `pending` (o worker relê a fatura)
- [x] [AUTO] Asaas → `POST /webhook-asaas` (header `asaas-access-token`) com `PAYMENT_RECEIVED` → 200 em <2 s; 2º POST idêntico → 200 e **1** linha em `webhook_events` (dedupe por `id`)
- [x] [AUTO] Fernanda → `GET /api/v1/charges` lista cobranças com cliente/boleto/conciliação; `?status=received` e `?q=` filtram; `GET /charges/:id` traz `reconciliations`, `exceptions`, `events`
- [x] [AUTO] Fernanda → `GET /api/v1/exceptions?status=open` lista com a cobrança junta; `POST /exceptions/:id/resolve` (header `x-user`) → `status=resolved`, `resolvedBy=fernanda`
- [x] [AUTO] Fernanda → `GET /api/v1/dashboard` aging bate com as cobranças abertas; `GET /health-report` traz `idaEnabled`, `openCharges`, `openExceptionsByType`, últimos jobs
- [x] [AUTO] vitest `test/db/flow.test.ts`: ida (2 parcelas, idempotente, watermark), cancelamento, push do Odoo, volta (CONFIRMED→RECEIVED, duplicata 0×, malformado 200), divergência/juros, órfão, DELETED/RESTORED/REFUNDED, reconcile-daily, watchdog (fila/penalidade/silêncio), RLS → todos verdes
- [x] [AUTO] vitest `test/db/console.test.ts`: auth, listas/detalhe/aging, reprocessar (evento reenfileirado → baixa), aceitar write-off, cliente corrigido → cobranças, gates R1/R3 → todos verdes
- [x] [AUTO] vitest `test/sandbox/asaas.live.test.ts` (sandbox real): cliente com notificações OFF → ON, boleto → confirm → RECEIVED, filtro por externalReference, delete → verdes
### 2.2 validações / erros
- [x] [AUTO] `POST /webhook-odoo?k=<key>` com corpo não-JSON → 400; com `_id` string → 400; nenhum 500
- [x] [AUTO] `POST /webhook-asaas` com token certo e corpo `{{{` → **200** (nunca derrubar a fila do Asaas) e linha `UNPARSEABLE` em `error`
- [x] [AUTO] `PUT /config/ASAAS_API_KEY` → 400 (chave fora da allowlist); `PUT /config/IDA_ENABLED {value:"sim"}` → 400; `PUT /config/TOLERANCE_BRL {value:"0,50"}` → 400; `limit=abc`, `/exceptions/abc`, `due_from=garbage`, `status=opened`, corpo `null` → 400 (era 500)
- [x] [AUTO] `POST /exceptions/999999/resolve` → 404 `{ok:false, code:'not_found'}`; reprocessar exceção já resolvida → 409; `GET /charges/999999` → 404
### 2.3 permissões / multi-tenant   ← sempre, em app com múltiplos clientes/usuários
- [x] [AUTO] `/api/v1/*` sem `Authorization` → 401; token errado → 401; motor sem `CONSOLE_TOKEN` → 503 (vitest)
- [x] [AUTO] `POST /webhook-asaas` sem/errado `asaas-access-token` → 401; `POST /webhook-odoo` com `k` errado → **404** (não confirma que a rota existe)
- [x] [AUTO] Cobrança `received` não volta a `cancelled` por evento `PAYMENT_DELETED` (máquina de estados, vitest) — recurso finalizado é imutável por rota genérica

## 3. CAÇA-UNKNOWNS  (o território — o DIFÍCIL, só usando aparece)
> Depois que §2 passar, NÃO revalide o roteiro. TENTE QUEBRAR de formas que o roteiro não
> previu, usando como um humano estressado usaria. Preencher DURANTE o uso, não lendo o diff.
> Alvo: 3-5 achados reais (ou justificar "SEM-UNKNOWNS").
Sondas executadas (curl no motor de pé + `job` contra o Odoo real expirado + testes dirigidos):
- [x] Dados reais/legados: Odoo REAL com base expirada (303 → HTML 200)
- [x] Deploy/migração não aplicada: `app_config` renomeada com o motor no ar; boot com migration faltando
- [x] Permissões cruzadas: `x-user`; token de webhook; policies do Supabase
- [x] Atomicidade: crash entre `registerPayment` e o insert; crash entre conciliação e status
- [x] Volume: 500+ faturas com o mesmo `write_date`; fila com 100 eventos e Odoo lento
- [x] Concorrência: 2 workers no mesmo tick; push × varredura na mesma fatura; worker × reconcile na mesma cobrança
- [x] Estado de borda: `PAYMENT_RECEIVED` antes da cobrança existir; reprocessar exceção resolvida; fatura resetada/re-postada; testes sujando o banco de dev
Achados (todos corrigidos e fixados em teste — `test/db/robustez.test.ts`, `flow.test.ts`, `console.test.ts`):
- U1 **(P1)** Odoo devolvendo HTML 200 (base expirada) → motor registrou "baixa" com `odooPaymentId: null` e marcou `received` sem pagamento no Odoo. Repro: `ODOO_URL` da base expirada, `job worker` com um `PAYMENT_RECEIVED` pendente. Causa: `fetch` seguia redirect e aceitava não-JSON; `registerPayment` não verificava efeito; `receivePayment` aceitava `paymentId: null`. Fix: HTTP estrito (sem redirect, JSON obrigatório), verificação por residual antes×depois do wizard, parcela lida por id, status `exception` em falha definitiva.
- U2 **(P1)** `sync-invoices` explodia com stack trace e nenhuma exceção/alerta. Fix: `runJob` abre `integration_error` (uma por vez); `health-report` mostra.
- U3 **(P2)** sem `app_config` → 500 em `/health` e `/webhook-odoo`. Fix: `assertMigrated` no boot (motor e `job`), 503 com corpo genérico quando o banco cai (webhook do Odoo não reenvia — a varredura cobre).
- U4 **(P2)** testes rodavam no banco de dev e deixavam `GO_LIVE_CUTOFF_DATE` setado. Fix: `motor_test` separado + reset a partir do registro `CONFIG_KEYS`.
- U5 **(P2, aberto → #1)** `x-user` é asserção do cliente sob token compartilhado.
- U6 **(P1)** crash entre `registerPayment` e `reconciliations.insert` → retry registrava 2º pagamento. Fix: parcela lida por id no Odoo (conciliada → fecha só do nosso lado, `ja_baixada_no_odoo`), `markReceived` transacional, `unique(reconciliations.charge_id)`.
- U7 **(P1)** evento `PAYMENT_RECEIVED` com falha definitiva ia pra `error` sem exceção → perdido se o Odoo ficasse fora > janela do reconcile. Fix: exceção `payment_unmatched` apontando pro evento, reprocessável pelo console.
- U8 **(P1)** dois workers (cron do Supabase + container) pegavam o mesmo evento. Fix: reserva `FOR UPDATE SKIP LOCKED` + `touch`; lock advisory por cobrança/fatura/parceiro.
**Red Team (10/09, sobre o código já corrigido) — 18 achados, 5 críticos corrigidos:** watermark comparado a segundo contra `write_date` com microssegundos (a varredura giraria em círculo com 200+ faturas no mesmo segundo → balde de 1 s + drenagem por id); `withLock` segurando conexão do pool durante HTTP → pool separado pra locks + erros de conexão do pg como transientes; reprocesso de cobrança em `exception` re-rodava o wizard → chave de idempotência `memo` + adoção do pagamento avulso + `res_id` no detalhe; primeira execução sem `GO_LIVE_CUTOFF_DATE` emitiria boleto pro histórico → guard no config e fail-closed na ida; uma fatura com 5xx eterno congelava a varredura → contador por fatura, exceção na 3ª e a fila anda. Informativos corrigidos: `PAYMENT_DELETED` de boleto vivo, `insert` engolindo qualquer unique, boleto adotado divergente, `reconcile` ancorado no último sucesso + passe por cobranças vencidas, baixa manual com boleto pago concilia em vez de escalar, cliente adotado por CPF/CNPJ, `POST /api/v1/jobs/:name` pro cron do Supabase, compose com `restart`/`healthcheck`/`stop_grace_period`/`PG*`. Deferidos: #5 (créditos tardios), #6 (token de posse do claim).

Do `/gstack-review` (8 especialistas + adversarial Claude + 2 passes do Codex), corrigidos no mesmo lote: webhook do Asaas tratado como verdade (evento forjado registrava pagamento) → releitura viva; `safeEqual` lançando com multibyte; ids do Asaas em path (`pay_1/../webhooks/x`); residual maior que a cobrança duplicava no retry; parcela sumida virava "paga"; `externalReference` vencia `asaasPaymentId`; `accept-writeoff` de pagamento estornado; watermark travado por falha permanente e por formato de data do Odoo; fatura re-postada/baixada por fora deixava boleto órfão; kill switch não valia pro push enfileirado; `money()` lançando no webhook → 500; corpo sem limite; entradas inválidas → 500; `enable-notifications` só pros clientes existentes; jobs sobrepostos; shutdown fechando o pool com escrita no meio; compose com Postgres em 0.0.0.0/senha fixa; runner de migração sem lock; índices faltando; policy do Supabase permitindo editar qualquer coluna.

## 4. Evidência
- Roteiro §2 (curl): `scratchpad/qa-roteiro.log` (sessão de 09/09) — HTTP: health, webhooks, console, validações, permissões
- Testes automatizados: `npm test` — **97 testes verdes** (10 arquivos: unit · fluxo · console · robustez, incluindo os casos do Red Team) · `scripts/with-op.sh npm run test:sandbox` — **3 verdes** no sandbox real do Asaas · `npm run test:odoo` pronto (somente-leitura, trava contra escrita) pra quando houver API key
- Container: `docker compose --profile motor up --build` → `migrate` aplica 0001–0004 e sai, `motor` sobe, `/health` 200, console 401/400/200 (AC14)
- Sondas §3 executadas contra o Odoo real expirado (`sdctech-danieltestes`): nenhuma baixa falsa após as correções; `integration_error` visível no `health-report`
- Review: `/gstack-review` (testing 19, maintainability 22, security 12, performance 11, data-migration 13, api-contract 14, simplification 6 advisory, adversarial Claude 24) + Codex adversarial 28 + Codex structured 2 P1 + **Red Team 18** → todos os P1 corrigidos; 8 issues pro resto

## 5. Limitações conhecidas → issues
- Identidade do operador é o header `x-user` (asserção do cliente) até o JWT do Supabase Auth → [#1](https://github.com/d-danielsun/sdc-motor/issues/1)
- `registerPayment` é o desenho da spec: campos do wizard e tratamento de juros/multa/centavos (Q3) só se confirmam no S0.3, na duplicata → [#2](https://github.com/d-danielsun/sdc-motor/issues/2)
- Regra do Odoo precisa filtrar `move_type = out_invoice` (senão cada write vira um POST) → [#3](https://github.com/d-danielsun/sdc-motor/issues/3)
- RLS sem policy pro role do motor: funciona porque o role é owner; role menos privilegiado enxerga 0 linhas → tripwire no boot → [#4](https://github.com/d-danielsun/sdc-motor/issues/4)
- `reconcile-daily`: créditos tardios e indisponibilidade maior que a janela; reenfileirar em lote → [#5](https://github.com/d-danielsun/sdc-motor/issues/5)
- Reserva de eventos sem token de posse; notificações repetidas do Odoo → [#6](https://github.com/d-danielsun/sdc-motor/issues/6)
- Migrations sem hash/ordem estrita/down → [#7](https://github.com/d-danielsun/sdc-motor/issues/7)
- Console: DTO do health-report, paginação keyset, `enable-notifications` como job → [#8](https://github.com/d-danielsun/sdc-motor/issues/8)
- Webhook do Asaas de verdade (URL pública) e UI Lovable sobre a API: fora deste gate (dependem de infra/Supabase)
