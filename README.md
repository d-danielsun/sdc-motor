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

Container completo (AC14 — a prova de que não depende do Supabase): `docker compose --profile motor up --build` sobe Postgres → `migrate` (aplica `db/migrations`) → `motor` (com `restart`, `healthcheck` e 70 s de graça no stop). Fora do laptop, defina `POSTGRES_PASSWORD` e os tokens por env. O banco pode vir por `DATABASE_URL` ou por `PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT` (senha com `@ / # %` não quebra). **Conexão de sessão obrigatória** (Supabase `:5432`, não o pooler `:6543`): os advisory locks não sobrevivem a pooler em modo transação — o motor avisa no boot.

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
- **Nada em dobro:** lock por cobrança, fatura e parceiro (advisory lock do Postgres num pool próprio), `unique(reconciliations.charge_id)`, `unique(charges.odoo_move_line_id)`, boleto existente adotado por `externalReference` (e cliente por CPF/CNPJ) antes de criar, chave de idempotência no wizard do Odoo (`memo = asaas:<pay_id>` — pagamento avulso é adotado ou recusado, nunca duplicado), eventos reservados com `SKIP LOCKED`.
- **Sem data de corte, nada sai:** `IDA_ENABLED=true` é recusado enquanto `GO_LIVE_CUTOFF_DATE` for nula — senão a primeira varredura emitiria boleto pro histórico inteiro do Odoo.
- **A varredura não trava:** o watermark é um balde de 1 s (o Odoo devolve `write_date` truncado; 200+ faturas confirmadas no mesmo segundo são drenadas por id); uma fatura que o Odoo recusa 3 varreduras seguidas vira exceção com o id e a fila anda.
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
| `POST /jobs/:name` | pro cron externo (Supabase): roda `worker`, `sync-invoices`, `reconcile-daily` ou `watchdog` com o mesmo guard de não-sobreposição; 502 se o job falhou |

Listas devolvem `{ data, total, limit, offset }` (`limit` 1–200, default 50). Erros devolvem sempre `{ ok:false, code, error }` com `code` ∈ `invalid_input` 400 · `unauthorized` 401 · `not_found` 404 · `invalid_state`/`busy` 409 · `upstream` 502 · `config`/`internal` 500. O header `x-user` vira `resolved_by` — é **asserção do cliente**; identidade forte vem com o JWT do Supabase Auth (issue #1).

## Jobs

`worker` (1 min: eventos do Odoo e do Asaas, lotes de 20) · `sync-invoices` (15 min, varredura de segurança da ida, páginas de 200) · `reconcile-daily` (06:00 BRT, relê RECEIVED e RECEIVED_IN_CASH dos últimos `RECONCILE_LOOKBACK_DAYS`, e apaga `audit_log`/eventos processados > 90 dias) · `watchdog` (15 min: fila interrompida, penalidades, silêncio, idade da key). Um job nunca sobrepõe a si mesmo. Uma vez por ambiente: `WEBHOOK_PUBLIC_URL=… ALERT_EMAIL=… npm run job -- register-asaas-webhook`.

## Modo demo

`npm run demo -- <cenário>` deixa o banco `motor_demo` com um estado que dá para demonstrar,
treinar alguém ou aceitar a UI. Sem isso o console nasce vazio, e a pessoa do financeiro veria
uma exceção pela primeira vez em produção, no dia em que ela importa.

| cenário | o que deixa na tela |
|---|---|
| `ciclo-feliz` | 1 fatura, 2 parcelas, boletos criados, 1 paga e baixada com diferença zero |
| `sem-cpf` | fatura de cliente sem CPF/CNPJ: exceção `customer_missing_document`, nenhuma cobrança |
| `divergente` | pagamento de R$ 90 numa cobrança de R$ 100: `amount_divergent`, sem baixa |
| `juros` | pagamento de R$ 103,10 com `originalValue` R$ 100: `writeoff_needed`, pronto para aceitar |
| `fila-parada` | webhook interrompido: `queue_interrupted` aberta e penalizações registradas |
| `tudo` | todos os anteriores, mais 3 cobranças vencidas para o aging mostrar as 4 faixas |

A semeadura passa pelas portas reais. Os fakes do Odoo e do Asaas rodam em processo e o
repositório é o Postgres de verdade, então o estado que fica no banco é o que o motor
produziria. Não há `INSERT` à mão e nenhuma chamada de rede, o que um teste afirma. Se o
comportamento do motor mudar, o demo muda com ele ou a suíte quebra.

Duas guardas valem citar. O comando recusa rodar se o banco não terminar em `_demo`, porque
ele trunca tudo e em `motor` apagaria o desenvolvimento. E ele cria e migra o banco de
demonstração sozinho na primeira vez, sem exigir um `db:reset`, que apagaria o banco de
desenvolvimento de quem já tinha o Postgres de pé.

As datas são relativas a hoje por desenho: um seed com datas fixas envelhece e passa a mostrar
tudo na faixa de mais de 30 dias. Depois de semear, suba o motor apontando para o banco de
demonstração e opere pelo console. As ações que chamariam Odoo ou Asaas falham como falhariam
em produção sem acesso, e isso aparece na tela, que é o comportamento esperado.

O login próprio do console chega com a issue #13. Até lá o acesso é pelo `CONSOLE_TOKEN`, e o
comando imprime a URL e o que usar.

## CI

Todo PR e todo push na `main` rodam dois workflows. Nenhum deles tem filtro `paths:` de
propósito: filtro de path é como uma suíte morre calada.

- **`ci`** (`.github/workflows/ci.yml`) — job **`test`**: sobe um `postgres:16` de serviço,
  cria o `motor_test`, aplica as migrations nos dois bancos e roda `npm run typecheck` mais
  os 97 testes (`test/unit` + `test/db` contra Postgres real). Job **`build`**: `docker build`
  da imagem, que executa `npm run build` no estágio de build. Job **`sandbox`**: só em
  `workflow_dispatch`, toca o sandbox real do Asaas e é pulado com aviso se o segredo
  `ASAAS_SANDBOX_KEY` não estiver cadastrado.
- **`gitleaks`** (`.github/workflows/gitleaks.yml`) — varre duas coisas com o binário
  oficial pinado, cujo checksum é conferido antes de rodar: a árvore de trabalho e, em PR,
  os commits do próprio PR. A segunda varredura existe porque um segredo adicionado num
  commit e removido no seguinte passa verde na primeira e fica no histórico para sempre.
  A allowlist em `.gitleaks.toml` cobre só o `.env.example`, e há uma regra própria para a
  chave do Asaas, que as regras padrão não pegam porque o valor começa com `$`. Fixtures de
  teste ficam de fora de propósito, para que uma chave real colada num teste seja pega.

O CI que roda mas não bloqueia é decoração. Quem transforma os workflows em gate é
`./scripts/branch-protection.sh`, idempotente, que exige `test`, `build` e `gitleaks` verdes,
com a branch atualizada em relação à base e a regra valendo também para admin. Rode uma vez
por repositório (`--dry-run` mostra o payload sem alterar nada). Em repositório privado, a
proteção de branch depende de plano pago do GitHub. Rulesets não são saída: estão atrás do
mesmo paywall e devolvem o mesmo 403. Sem plano pago ou sem tornar o repositório público, o
CI sinaliza mas não bloqueia o merge, e o script diz isso na falha.

O `npm run typecheck` checa `src/` e também `test/`, via `tsconfig.test.json`. O
`tsconfig.json` sozinho não olha os testes, e o vitest apaga os tipos sem checar: dava para
escrever `const n: number = "texto"` num teste e o gate passar verde.

Para rodar a mesma coisa na máquina: `npm run db:up && npm run db:migrate && npm run
db:migrate:test && npm run typecheck && npm test`. O `DATABASE_URL_TEST` sobrescreve o banco
de teste quando ele não está na porta local padrão, que é o que o CI faz.

## O que ainda depende de acesso externo

- **S0.1/S0.3** — `OdooJson2Client.registerPayment` segue o desenho da spec; campos exigidos pelo wizard e o tratamento de diferença (juros/multa) se confirmam na duplicata de teste.
- **Webhook do Asaas de verdade** — precisa de URL pública (Supabase, túnel ou container publicado) para o `register-asaas-webhook`.
