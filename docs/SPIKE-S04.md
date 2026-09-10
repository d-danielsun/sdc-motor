# S0.4 — as regras de automação do Odoo e a entrega do webhook

O motor descobre faturas de duas formas: o **push**, em que o Odoo avisa na hora, e a
**varredura** a cada 15 minutos, que é a rede de segurança. Este spike prova o push contra o Odoo
real e mede a coisa que a especificação não garante: **quantas vezes** a regra dispara por
postagem.

Roteiro executável por quem não participou da conversa. Vale em duplicata de teste; as mesmas
regras, com outra URL, são o que vai para produção.

## Antes de começar

Três coisas de pé, na ordem:

```bash
npm run db:up && npm run db:migrate          # 1. banco
ODOO_WEBHOOK_KEY=$(openssl rand -hex 24) npm run dev    # 2. motor local (guarde essa chave)
scripts/tunnel.sh                             # 3. túnel, em outro terminal
```

O `tunnel.sh` imprime a URL pronta para colar, já com o token. Ele recusa abrir se o motor não
estiver respondendo, justamente para você não descobrir isso pelo webhook morrendo em 502.

A URL do quick tunnel **muda a cada execução**. Se o túnel cair no meio do spike, rode de novo e
atualize a URL nas duas regras — é o custo de ainda não haver domínio próprio.

## Passo 1 — a entrega chega, antes de envolver o Odoo

Do seu terminal, com a URL que o script imprimiu:

```bash
curl -sS -X POST "https://<host>.trycloudflare.com/webhook-odoo?k=<ODOO_WEBHOOK_KEY>" \
  -H 'content-type: application/json' -d '{"_model":"account.move","_id":999999}'
```

**Esperado:** `{"ok":true}`, e a linha no banco:

```sql
select odoo_model, odoo_id, process_status, received_at from odoo_events order by received_at desc limit 3;
-- account.move | 999999 | pending
```

Confira também que o token errado é recusado: trocar o `?k=` por qualquer coisa devolve **404**,
não 401. É de propósito — 401 confirmaria que o endpoint existe.

Se este passo não passar, **não continue**. O problema é túnel ou motor, e depurar isso com o
Odoo no meio é muito mais difícil.

## Passo 2 — criar a Regra A (fatura postada)

No Odoo, com o modo desenvolvedor ligado: **Configurações → Técnico → Automações → Automações**,
botão Novo.

| Campo | Valor |
|---|---|
| Nome | `Salvei · fatura postada → motor` |
| Modelo | Lançamento contábil (`account.move`) |
| Gatilho | **Ao atualizar** um campo, campo `state` (no Odoo 17+ aparece como "State is set to") |
| Antes da atualização / domínio | `[("move_type", "=", "out_invoice"), ("state", "=", "posted")]` |
| Ação | **Enviar notificação de webhook** |
| URL | `https://<host>.trycloudflare.com/webhook-odoo?k=<ODOO_WEBHOOK_KEY>` |

**O filtro `move_type = out_invoice` é obrigatório na regra.** Sem ele, o Odoo dispara para
compras e lançamentos internos também. O motor ignora o que não interessa, mas isso vira tráfego
e ruído por nada, e é a issue [#3](https://github.com/d-danielsun/sdc-motor/issues/3).

## Passo 3 — postar uma fatura e ver o que chega

Crie uma fatura de cliente com duas parcelas e **confirme** (poste).

```sql
select id, odoo_model, odoo_id, odoo_action, process_status, received_at, payload
  from odoo_events order by received_at desc limit 5;
```

**Esperado:** uma linha, `account.move`, com o id da fatura, `pending`.

**Observe três coisas e anote cada uma:**

1. **Quantas linhas apareceram para uma única postagem.** Se vier mais de uma, o Odoo está
   disparando por gravação e não por transição de estado. O motor aguenta (o `handleInvoice` é
   idempotente e tem lock por fatura), mas isso multiplica trabalho — e é o que o índice parcial
   único de `odoo_events` colapsa.
2. **O que vem no `payload`.** O motor só usa `_model` e `_id`; o resto é registro. Se `_id` não
   vier, o webhook do Odoo mudou de formato e o receptor precisa ajustar.
3. **Quanto tempo levou.** O Odoo desiste em ~1 segundo e **não reenvia**. Por isso o motor só
   grava e responde 200; se o túnel adicionar latência demais, a entrega falha silenciosamente do
   lado do Odoo.

## Passo 4 — o ciclo completo do push

Com `IDA_ENABLED` ligado e `GO_LIVE_CUTOFF_DATE` definida (tela Configuração do console), o worker
processa o evento e cria as cobranças:

```sql
select id, odoo_move_line_id, status, amount, due_date, asaas_payment_id from charges order by id desc limit 5;
select process_status, error from odoo_events order by received_at desc limit 3;
```

**Esperado:** uma cobrança por parcela, evento em `done`. Se o evento ficar em `error`, o campo
`error` diz o motivo, e a exceção correspondente aparece no console.

## Passo 5 — criar a Regra B (cancelada ou de volta a rascunho)

Igual à Regra A, com:

| Campo | Valor |
|---|---|
| Nome | `Salvei · fatura cancelada/rascunho → motor` |
| Domínio | `[("move_type", "=", "out_invoice"), ("state", "in", ["cancel", "draft"])]` |

Cancele a fatura do passo 3.

**Esperado:** novo evento, e o motor **cancela o boleto** no Asaas. As cobranças ficam
`cancelled`. É a regra que evita boleto órfão cobrando por uma fatura que deixou de valer.

Se a fatura já tiver boleto **pago**, o esperado é diferente e igualmente importante: o motor
**não** apaga o boleto e abre uma exceção `reversal_pending`. Dinheiro que entrou não desaparece
porque alguém cancelou a fatura.

## Passo 6 — a varredura pega o que o push perdeu

Desligue o túnel (Ctrl+C) e poste outra fatura. O Odoo tenta entregar, falha, e não reenvia.

```bash
npm run job -- sync-invoices
```

**Esperado:** a varredura acha a fatura pelo `write_date` e cria as cobranças de qualquer forma.
É esta a prova de que o push é otimização, não dependência — e é por isso que uma queda de túnel
ou de motor não perde fatura.

## O que este spike NÃO cobre

O webhook do **Asaas** (a volta do dinheiro) é registrado pelo mesmo túnel, com
`npm run job -- register-asaas-webhook`, e a URL sai pronta no `tunnel.sh`. Mas exercitar a volta
depende de pagar um boleto no sandbox, o que já está coberto por `npm run test:sandbox`.

## Onde registrar o resultado

1. **`~/w/salvei/propostas/SDC/fase0/spikes.md`** — o registro do deal.
2. **Issue [#3](https://github.com/d-danielsun/sdc-motor/issues/3)** — se a regra disparar mais de
   uma vez por postagem, ou se o filtro de `move_type` se mostrar insuficiente.
3. **`docs/RUNBOOK-R1.md`, Etapa 3** — se o caminho de menu do Odoo estiver diferente do descrito
   (a interface muda entre versões), corrija lá. O runbook é o que alguém vai seguir em produção.
