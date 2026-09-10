# sdc-motor

Motor de cobrança **Odoo ↔ Asaas** da SDC (produto Salvei). Fatura de cliente postada no Odoo → boleto no Asaas (1 por parcela) → `PAYMENT_RECEIVED` → baixa na parcela exata do Odoo. Exceções (cliente sem CPF/CNPJ, valor divergente, estorno, fila do Asaas parada, integração fora) vão pra um console; o resto é automático.

Spec e contratos: `~/w/salvei/propostas/SDC/02-SPEC.md`. Plano de teste e caça-unknowns: `TEST-PLAN.md`.

## Rodar local (sem Supabase, sem Odoo)

```bash
npm install
npm run db:up && npm run db:migrate && npm run db:migrate:test   # Postgres em Docker (127.0.0.1:55432): bancos motor (dev) e motor_test
npm run test:unit                          # puro, sem rede nem banco
npm test                                   # unit + fluxo contra Postgres real (motor_test) com Odoo/Asaas em memória
scripts/with-op.sh npm run test:sandbox    # vivo contra o sandbox do Asaas (key do 1Password)
scripts/with-op.sh npm run dev             # API em :8787 (/health, /webhook-asaas, /webhook-odoo?k=, /api/v1)
```

Container completo (AC14 — a prova de que não depende do Supabase): `docker compose --profile motor up --build` sobe Postgres → `migrate` (aplica `db/migrations`) → `motor`. Fora do laptop, defina `POSTGRES_PASSWORD` e os tokens por env.

## Layout

| Pasta | O quê |
|---|---|
| `src/core/` | Domínio puro: tipos, dinheiro em centavos, máquina de estados, casos de uso, **portas** (`OdooClient`, `AsaasClient`, `Repo`, `Clock`), `limits.ts`. Sem pg/hono/fetch/env — há teste que garante. |
| `src/adapters/` | `asaas/` (API v3), `odoo/` (JSON-2), `db/` (pg, migrations, read model do console), `fakes/` (Odoo e Asaas em memória), `clock.ts` |
| `src/app/` | Hono (webhooks em `server.ts`, console em `console.ts`), scheduler em processo, wiring de env |
| `src/cli/` | `migrate`, `job <nome>` |
| `db/migrations/` | SQL puro, ordem numérica, forward-only. `0002`/`0004` só agem se o role `authenticated` (Supabase) existir |

## Invariantes que o código defende (e os testes fixam)

- **Baixa só com prova:** o pagamento é relido no Asaas (o webhook é gatilho, não verdade — ele não é assinado), a parcela é lida por id no Odoo, o residual tem que bater com a cobrança, e o wizard só conta se o residual caiu no valor pago. Parcela sumida, residual diferente ou wizard sem efeito viram exceção, nunca "recebido".
- **Nada em dobro:** lock por cobrança e por fatura (advisory lock do Postgres), `unique(reconciliations.charge_id)`, `unique(charges.odoo_move_line_id)`, boleto existente adotado por `externalReference` antes de criar, eventos reservados com `SKIP LOCKED`.
- **Nada em silêncio:** falha definitiva de evento ou de job vira exceção reprocessável; `IDA_ENABLED` é o kill switch de toda emissão; boot recusa banco sem migração.

## API do console (`/api/v1`, `Authorization: Bearer $CONSOLE_TOKEN`)

| Rota | O quê |
|---|---|
| `GET /exceptions?status=open\|resolved\|ignored&type=&limit=&offset=` · `GET /exceptions/:id` | fila de exceções, com a cobrança/cliente juntos |
| `POST /exceptions/:id/resolve` · `/ignore` · `/reprocess` · `/accept-writeoff` | ações do financeiro (só em exceção aberta); reprocessar reenfileira o evento ou relê a fatura — nunca atalha o fluxo; aceitar write-off exige o pagamento ainda recebido no Asaas |
| `GET /charges?status=a,b&due_from=&due_to=&partner=&q=&limit=&offset=` · `GET /charges/:id` | cobranças com cliente, boleto, conciliação, eventos |
| `GET /dashboard` | aging das cobranças abertas (a vencer / 1–7 / 8–30 / 31+) |
| `GET /health-report` | kill switch, régua, abertas, exceções por tipo, último evento/varredura/reconcile/watchdog, fila do Asaas, idade da key |
| `GET /config` · `PUT /config/:key {value}` | `IDA_ENABLED` (gate R1), `TOLERANCE_BRL` (≤100), `GO_LIVE_CUTOFF_DATE`, `JUROS_MULTA_AUTO`, `RECONCILE_LOOKBACK_DAYS` (1–30) |
| `POST /customers/enable-notifications` | gate R3: liga a régua nos clientes existentes e como política pros próximos |

Listas devolvem `{ data, total, limit, offset }` (`limit` 1–200, default 50). Erros devolvem sempre `{ ok:false, code, error }` com `code` ∈ `invalid_input` 400 · `unauthorized` 401 · `not_found` 404 · `invalid_state`/`busy` 409 · `upstream` 502 · `config`/`internal` 500. O header `x-user` vira `resolved_by` — é **asserção do cliente**; identidade forte vem com o JWT do Supabase Auth (issue #1).

## Jobs

`worker` (1 min: eventos do Odoo e do Asaas, lotes de 20) · `sync-invoices` (15 min, varredura de segurança da ida, páginas de 200) · `reconcile-daily` (06:00 BRT, relê RECEIVED e RECEIVED_IN_CASH dos últimos `RECONCILE_LOOKBACK_DAYS`, e apaga `audit_log`/eventos processados > 90 dias) · `watchdog` (15 min: fila interrompida, penalidades, silêncio, idade da key). Um job nunca sobrepõe a si mesmo. Uma vez por ambiente: `WEBHOOK_PUBLIC_URL=… ALERT_EMAIL=… npm run job -- register-asaas-webhook`.

## O que ainda depende de acesso externo

- **S0.1/S0.3** — `OdooJson2Client.registerPayment` segue o desenho da spec; campos exigidos pelo wizard e o tratamento de diferença (juros/multa) se confirmam na duplicata de teste.
- **Webhook do Asaas de verdade** — precisa de URL pública (Supabase, túnel ou container publicado) para o `register-asaas-webhook`.
