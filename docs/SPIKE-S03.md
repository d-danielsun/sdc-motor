# S0.3 — o assistente de baixa do Odoo

Este é o único pedaço do motor escrito a partir da especificação e **nunca** exercitado contra o
Odoo real. Tudo o mais foi provado. Este roteiro existe para transformar três suposições em fato,
numa tarde, por alguém que não participou da conversa que gerou o código.

**Só em duplicata de teste. Nunca em produção.** O `registerPayment` escreve: cria um pagamento e
concilia uma parcela. Fazer isso na base de produção do cliente é criar lançamento contábil de
verdade.

## As três suposições

| # | Suposição no código hoje | Onde | Como confirmar |
|---|---|---|---|
| 1 | O campo de referência do pagamento é `memo` (era `ref` até o Odoo 17) | `src/adapters/odoo/client.ts`, `PAYMENT_REF_FIELD` | Passo 4 |
| 2 | O assistente aceita só `amount`, `payment_date` e `communication` | mesmo arquivo, `registerPayment` | Passo 3 |
| 3 | Diferença de valor (juros, multa, centavos) precisa de tratamento explícito | não implementado — é a issue #2 | Passo 6 |

A suposição 1 tem uma sutileza que é fácil passar batido: o motor **escreve** `communication` no
assistente e depois **lê** `memo` no pagamento. Em teoria o Odoo copia um no outro. Se não
copiar, a chave de idempotência da baixa não funciona, e o retry cria pagamento duplicado. É a
coisa mais importante deste spike.

## Antes de começar

```bash
export ODOO_URL=https://<base-de-teste>.odoo.com
export ODOO_DB=<base-de-teste>
scripts/with-op-odoo.sh npm run test:odoo      # S0.1, só leitura: tem que passar antes
```

Se o S0.1 não passar, pare aqui: o problema é acesso, não o assistente.

Na duplicata, crie ou escolha:

- um cliente com CPF ou CNPJ preenchido;
- uma fatura de cliente **postada**, com **duas parcelas** (é o caso que o motor trata);
- anote o `id` da fatura e o `id` de cada parcela. As parcelas são linhas de `account.move.line`
  com `date_maturity` preenchido. Para achá-las, a forma mais rápida é a própria API:

```bash
scripts/with-op-odoo.sh npx tsx -e '
import { OdooJson2Client } from "./src/adapters/odoo/client.js";
const c = new OdooJson2Client({ url: process.env.ODOO_URL!, db: process.env.ODOO_DB!, apiKey: process.env.ODOO_API_KEY! });
const inv = await c.searchInvoices({ limit: 5 });
for (const i of inv) console.log(i.id, i.name, i.amountResidual, i.state, i.paymentState);
'
```

## Passo 1 — o assistente aceita ser criado?

Com o `id` de **uma** parcela, e o valor **exato** dela:

```bash
scripts/with-op-odoo.sh npx tsx -e '
import { OdooJson2Client } from "./src/adapters/odoo/client.js";
const c = new OdooJson2Client({ url: process.env.ODOO_URL!, db: process.env.ODOO_DB!, apiKey: process.env.ODOO_API_KEY! });
const linha = await c.getPaymentTermLine(NUMERO_DA_PARCELA);
console.log("antes:", linha);
const r = await c.registerPayment({ moveLineId: NUMERO_DA_PARCELA, amount: linha!.amountResidual, paymentDate: new Date().toISOString().slice(0,10), ref: "asaas:spike-s03-1" });
console.log("resultado:", r);
console.log("depois:", await c.getPaymentTermLine(NUMERO_DA_PARCELA));
'
```

**Esperado:** `resultado` traz um `paymentId` numérico, e a parcela volta com
`amountResidual: "0.00"` e `reconciled: true`.

**Se falhar com erro de campo obrigatório**, é a suposição 2 caindo. O erro do Odoo diz qual
campo falta — normalmente `journal_id` (em qual diário entra o dinheiro) ou
`payment_method_line_id` (qual meio de pagamento). Anote o nome exato e siga para o passo 2.

## Passo 2 — descobrir os campos exigidos, se o passo 1 falhar

O assistente sabe dizer o que ele quer:

```bash
scripts/with-op-odoo.sh npx tsx -e '
import { OdooJson2Client } from "./src/adapters/odoo/client.js";
const c = new OdooJson2Client({ url: process.env.ODOO_URL!, db: process.env.ODOO_DB!, apiKey: process.env.ODOO_API_KEY! });
const campos = await (c as any).call("account.payment.register", "fields_get", { attributes: ["string", "required", "type", "relation"] });
for (const [k, v] of Object.entries<any>(campos)) if (v.required) console.log(k, "·", v.type, v.relation ?? "", "·", v.string);
'
```

Anote **cada** campo obrigatório. Depois descubra o valor certo para os dois candidatos:

```bash
# diários de banco/caixa disponíveis
... searchRead("account.journal", [["type","in",["bank","cash"]]], ["id","name","type"])
# meios de pagamento de entrada do diário escolhido
... searchRead("account.payment.method.line", [["journal_id","=",ID_DO_DIARIO],["payment_type","=","inbound"]], ["id","name"])
```

**Qual escolher não é decisão técnica.** É a pergunta Q3 para o contador da SDC: em qual diário
entram os recebimentos via Asaas. Registre a resposta, não escolha por conta própria.

## Passo 3 — a idempotência funciona? (o passo que mais importa)

Rode **o mesmo comando do passo 1 outra vez**, com a mesma `ref`.

**Esperado:** o motor detecta o pagamento existente por `memo` e **não** cria um segundo. Como a
parcela já está conciliada, ele adota o pagamento anterior e devolve o mesmo `paymentId`.

**Se criar um segundo pagamento**, a suposição 1 caiu: o `communication` do assistente não virou
`memo` no pagamento. Confirme onde a referência foi parar:

```bash
... searchRead("account.payment", [["id","=",ID_DO_PAGAMENTO]], ["memo","ref","communication","payment_reference","name"])
```

O campo que contém `asaas:spike-s03-1` é o valor certo de `PAYMENT_REF_FIELD`. **Isto é um P1:**
sem ele, um retry depois de timeout duplica pagamento no ERP do cliente.

## Passo 4 — a leitura por referência acha o pagamento?

```bash
... findPaymentByRef("asaas:spike-s03-1")
```

**Esperado:** devolve `{ id, state }`. Vazio significa a mesma coisa do passo 3: campo errado.

## Passo 5 — pagamento parcial vira o que?

Na **segunda** parcela, registre **metade** do valor, com uma `ref` nova.

**Esperado:** o motor **recusa** com mensagem dizendo que o residual caiu menos que o valor
pedido, e a baixa não é confirmada. Essa recusa é proposital: ela é a defesa que impediu uma
baixa falsa no QA. Se ele **aceitar** e marcar como recebido, é um P1.

Confira que a parcela ficou com residual parcial e `reconciled: false`.

## Passo 6 — diferença de valor: juros, multa e centavos (issue #2)

É o que falta implementar, e este passo define **como**. Na segunda parcela (ainda aberta),
registre um valor **acima** do residual, com `ref` nova.

Três resultados possíveis, e cada um leva a um caminho diferente:

1. **O Odoo aceita e gera um lançamento de diferença sozinho.** Anote em qual conta ele jogou. É
   o caminho mais simples: o motor não precisa fazer nada além do que já faz.
2. **O Odoo recusa pedindo `payment_difference_handling`.** Então o motor precisa passar
   `"reconcile"` mais uma `writeoff_account_id` — e qual conta é a pergunta Q3 para o contador:
   em qual conta entram juros e multa recebidos.
3. **O Odoo aceita e deixa crédito sobrando no cliente.** Pior caso silencioso: o dinheiro entra,
   a parcela fecha, e sobra um crédito que ninguém conciliou. Anote e trate como P1 na #2.

Repita com **um centavo acima** do residual, que é o caso da tolerância. Se o comportamento for
diferente do caso de juros, os dois precisam de tratamento separado.

## Passo 7 — desfazer o que este spike criou

A duplicata é descartável, mas deixe-a limpa se ela vai ser usada para o S0.4:

```bash
... call("account.payment", "action_draft", { ids: [IDS] })   # volta a rascunho
... call("account.payment", "unlink", { ids: [IDS] })          # e apaga
```

Se algum passo travou a fatura num estado estranho, é mais rápido pedir uma duplicata nova.

## Onde registrar o resultado

1. **Issue [#2](https://github.com/d-danielsun/sdc-motor/issues/2)** — um comentário por passo,
   com o que aconteceu de fato. Se a suposição 1 ou 2 caiu, o comentário vira o plano de correção.
2. **`~/w/salvei/propostas/SDC/fase0/spikes.md`** — o registro do deal, para o cliente.
3. **`src/adapters/odoo/client.ts`** — trocar o comentário "confirmar no S0.3" pelo fato, com a
   data. Suposição confirmada é conhecimento; suposição confirmada e não anotada volta a ser dúvida
   em três meses.

Duplicata de Odoo Online vive cerca de 15 dias. Se ela vencer no meio, o sintoma é resposta HTML
onde deveria vir JSON — o motor detecta e recusa, em vez de dar baixa falsa, mas o spike para.
