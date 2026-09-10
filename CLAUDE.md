# sdc-motor

Motor de cobrança Odoo ↔ Asaas da SDC (deal Salvei, R$ 8k/mês). Fatura postada no Odoo → boleto no Asaas → `PAYMENT_RECEIVED` → baixa na parcela exata do Odoo, com console de exceções. Stack: Node 24 + TypeScript, Hono, `pg`, Postgres. **Invariante: o núcleo (`src/core`) não importa nada de Supabase, Deno ou HTTP — roda igual em Supabase hoje e em container/GCP/AWS/servidor físico amanhã.**

## Como rodar
- `npm run db:up && npm run db:migrate && npm run db:migrate:test` — Postgres local (porta 55432): banco `motor` (dev) + `motor_test` (testes) + `motor_demo` (demonstração). Volume antigo sem `motor_test`? `npm run db:reset`.
- `npm run demo -- tudo` — semeia o `motor_demo` com os cenários de demonstração (cria e migra o banco sozinho; recusa banco que não termine em `_demo`). Cenários e o porquê: seção "Modo demo" do README.
- `npm run test:unit` — puro. `npm test` — unit + fluxo contra Postgres real (`motor_test`). `scripts/with-op.sh npm run test:sandbox` — vivo contra o sandbox do Asaas (key vem do 1Password, nunca de arquivo).
- `npm run dev` — API local (`/health`, `/webhook-asaas`, `/webhook-odoo?k=`). `npm run job -- <nome>` — roda um job (sync-invoices, reconcile-daily, watchdog…).

## Estrutura
- `src/core/` — tipos, máquina de estados de `charges`, casos de uso, **portas** (`OdooClient`, `AsaasClient`, `Repo`, `Clock`). Puro.
- `src/adapters/` — `asaas/` (fetch), `odoo/` (JSON-2 `/json/2`), `db/` (pg), `fakes/` (Odoo e Asaas em memória pra testes).
- `src/app/` — Hono (webhooks em `server.ts`, console em `console.ts`) + scheduler. `src/cli/` — migrate, job, demo. `db/migrations/` — SQL puro, ordem numérica.
- Read model do console: `src/core/console.ts` (interface) + `src/adapters/db/console.ts` (SQL). Ações: `src/core/usecases/console.ts`.
- Spec-fonte: `~/w/salvei/propostas/SDC/02-SPEC.md` (v1.1). Contratos Odoo/Asaas estão lá, não aqui.

## Convenções
- Dinheiro: `numeric(14,2)` no banco, `string` decimal no TS (nunca `number` pra somar). Datas civis (`due_date`, `payment_date`) são `date` em America/Sao_Paulo.
- 1 cobrança Asaas por parcela do Odoo; `externalReference = odoo:move_line:<id>`. Nunca `installmentCount`.
- Todo caso de uso é idempotente (unique em `odoo_move_line_id` e `asaas_event_id`); retry é seguro.
- Segredos só por env; `scripts/with-op.sh` pra desenvolvimento. Nada de `.env` commitado.
- Config em `app_config` é jsonb, mas dinheiro lá também é **string** (`"0.01"`), nunca número.

## NÃO faça
- Não importe `pg`, `hono`, `fetch` ou env dentro de `src/core` — há teste que quebra.
- Não use o parcelamento nativo do Asaas (o `externalReference` propaga igual pra todas as parcelas — spike S0.2).
- Não dê baixa em `PAYMENT_CONFIRMED`; só em `PAYMENT_RECEIVED`.
- Não responda nada além de 200 rápido nos webhooks: Asaas interrompe a fila após 15 falhas; o Odoo desiste em 1 s e não reenvia.
- Não rode com escrita contra a base de produção do cliente — S0.3/S0.4 só em duplicata. `ODOO_URL`/`ODOO_DB` não têm default justamente por isso.
- Não aceite resposta não-JSON/redirect de Odoo ou Asaas como sucesso, e não marque cobrança como `received` sem o Odoo confirmar (parcela lida por id, residual antes×depois do wizard). QA 09/09: base expirada devolvendo HTML gerou baixa falsa.
- Não use o payload do webhook do Asaas como verdade: releia o pagamento (`asaas.getPayment`) antes de qualquer transição — o webhook não é assinado.
- Não escreva `where status=...` de transição sem `WHERE status IN (…)` (`charges.transition`), nem baixa fora de `markReceived` (transação + unique).
- Não chame Odoo/Asaas segurando um lock desnecessário; os advisory locks (`withLock`) são por cobrança/fatura/parceiro e são `try` (busy → volta pra fila), nunca bloqueantes.
- Ao sobrescrever método de um fake num teste (`w.deps.odoo.x = …`), restaure com `delete (w.odoo as any).x` — `w.deps.odoo` É o fake.
