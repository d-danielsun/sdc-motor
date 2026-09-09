# sdc-motor

Motor de cobrança **Odoo ↔ Asaas** da SDC (produto Salvei). Fatura de cliente postada no Odoo → boleto no Asaas (1 por parcela) → `PAYMENT_RECEIVED` → baixa na parcela exata do Odoo. Exceções (cliente sem CPF/CNPJ, valor divergente, estorno, fila do Asaas parada) vão pra um console; o resto é automático.

Spec e contratos: `~/w/salvei/propostas/SDC/02-SPEC.md`.

## Rodar local (sem Supabase, sem Odoo)

```bash
npm install
npm run db:up && npm run db:migrate       # Postgres em Docker, porta 55432
npm test                                  # unit (puro)
npx vitest run test/db                    # ciclo inteiro contra Postgres + Odoo/Asaas em memória
scripts/with-op.sh npm run test:sandbox   # vivo contra o sandbox do Asaas (key do 1Password)
scripts/with-op.sh npm run dev            # API em :8787 (/health, /webhook-asaas, /webhook-odoo?k=)
```

Container completo (AC14 — a prova de que não depende do Supabase): `docker compose --profile motor up --build`.

## Layout

| Pasta | O quê |
|---|---|
| `src/core/` | Domínio puro: tipos, dinheiro em centavos, máquina de estados, casos de uso, **portas** (`OdooClient`, `AsaasClient`, `Repo`, `Clock`). Sem pg/hono/fetch/env — há teste que garante. |
| `src/adapters/` | `asaas/` (API v3), `odoo/` (JSON-2), `db/` (pg), `fakes/` (Odoo e Asaas em memória), `clock.ts` |
| `src/app/` | Hono (webhooks + health), scheduler em processo, wiring de env |
| `src/cli/` | `migrate`, `job <nome>` |
| `db/migrations/` | SQL puro. `0002` só cria policies se o role `authenticated` (Supabase) existir |

## API do console (`/api/v1`, `Authorization: Bearer $CONSOLE_TOKEN`)

| Rota | O quê |
|---|---|
| `GET /exceptions?status=open&type=` · `GET /exceptions/:id` | fila de exceções, com a cobrança/cliente juntos |
| `POST /exceptions/:id/resolve` · `/ignore` · `/reprocess` · `/accept-writeoff` | ações do financeiro (`x-user` vira `resolved_by`); reprocessar reenfileira o evento ou relê a fatura — nunca atalha o fluxo |
| `GET /charges?status=created,confirmed&due_from=&due_to=&partner=&q=` · `GET /charges/:id` | cobranças com cliente, boleto, conciliação, eventos |
| `GET /dashboard` | aging das cobranças abertas (a vencer / 1–7 / 8–30 / 31+) |
| `GET /health-report` | kill switch, abertas, exceções por tipo, último evento/varredura/reconcile/watchdog, fila do Asaas, idade da key |
| `GET /config` · `PUT /config/:key {value}` | só `IDA_ENABLED` (gate R1), `TOLERANCE_BRL`, `GO_LIVE_CUTOFF_DATE`, `JUROS_MULTA_AUTO` |
| `POST /customers/enable-notifications` | gate R3: liga a régua do Asaas pra todos os clientes sincronizados |

No Supabase, a UI (Lovable) chama estas rotas; a auth troca o token fixo por JWT do Supabase Auth com a mesma allowlist.

## Jobs

`worker` (1 min: eventos do Odoo e do Asaas) · `sync-invoices` (15 min, varredura de segurança da ida) · `reconcile-daily` (06:00 BRT, relê RECEIVED dos últimos 3 dias) · `watchdog` (15 min: fila interrompida, penalidades, silêncio, idade da key).

## O que ainda depende de acesso externo

- **S0.1/S0.3** — `OdooJson2Client.registerPayment` segue o desenho da spec; a mecânica exata do wizard (`journal_id`, `payment_method_line_id`) se confirma na duplicata de teste.
- **Webhook do Asaas de verdade** — precisa de URL pública (Supabase, túnel ou container publicado) pra `POST /v3/webhooks`.
