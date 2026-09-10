# Runbook R1 — do zero até a emissão ligada

Este documento leva alguém que nunca viu este projeto do nada até `IDA_ENABLED=true`, com boleto
saindo de verdade para clientes reais. Siga na ordem. Cada etapa tem como conferir se deu certo,
e no fim há como desligar tudo em dez segundos.

Nada aqui exige perguntar a ninguém, **exceto** o que estiver marcado com **[precisa de alguém]**:
são as coisas que dependem de credencial ou de acesso que só uma pessoa pode conceder.

## O que este motor faz, em cinco linhas

Uma fatura de cliente é postada no Odoo. O motor cria um boleto no Asaas para **cada parcela**
daquela fatura. Quando o cliente paga, o Asaas avisa por webhook, o motor confere o pagamento
lendo o Asaas de novo e registra a baixa na parcela exata do Odoo. O que não fecha
automaticamente vira **exceção** numa fila que uma pessoa resolve pelo console. O motor nunca
inventa baixa: sem confirmação do Odoo, a cobrança não é marcada como recebida.

## Etapa 0 — o que você precisa ter em mãos

| Item | Como conseguir |
|---|---|
| Acesso ao Odoo do cliente, com permissão de criar chave de API | **[precisa de alguém]** um administrador do Odoo |
| Conta Asaas da SDC, com chave de API de produção | **[precisa de alguém]** ver `GO-LIVE.md`, seção KYC |
| Um host público com HTTPS para o motor | Cloud Run, ECS, VM ou servidor físico — a imagem é a mesma |
| Postgres 16 | Supabase, Cloud SQL, RDS ou o container do compose |

Na máquina de quem executa: **Node 24**, **Docker** (só se for usar o Postgres do compose) e o
**CLI do 1Password** (`op`), que é como as chaves saem do cofre sem passar por chat. Sem `op`,
exporte os segredos à mão — os scripts `scripts/with-op*.sh` são conveniência, não obrigação.

Para rodar as consultas de conferência deste documento:

```bash
psql "$DATABASE_URL" -c "select 1"        # se tiver o psql instalado
# ou, com o Postgres do compose:
docker compose exec postgres psql -U motor -d motor -c "select 1"
```

Antes de tocar em produção, rode tudo localmente com o modo demo. São dois comandos, e você vê
as quatro exceções na tela sem depender de ninguém:

```bash
npm run db:up && npm run db:migrate && npm run db:migrate:demo
npm run demo -- tudo        # imprime usuário e senha do console
```

## Etapa 1 — banco e migrations

```bash
export DATABASE_URL='postgres://usuario:senha@host:5432/motor'
npm run db:migrate
```

**Confira:** a saída termina em `ok — N applied now`. O motor **recusa subir** num banco sem
migration aplicada, de propósito: é melhor não subir do que responder erro nos webhooks.

Se o banco for Supabase, use a conexão **direta** (porta 5432), não o pooler em modo transação
(6543). Os advisory locks do motor precisam de conexão de sessão, e no pooler eles simplesmente
não funcionam. O motor avisa no boot se detectar isso.

## Etapa 2 — chave de API no Odoo

**[precisa de alguém]** com login no Odoo (não precisa ser administrador; vale no próprio
usuário):

1. Entre no Odoo e vá em **Minhas preferências → aba Segurança da conta**.
2. **Nova chave de API**, nome `salvei-motor`, duração a máxima possível.
3. Copie a chave. Ela aparece **uma vez**.
4. Guarde no 1Password, sem passar por chat:
   `op item create --category password --title "Odoo API Key - SDC" password="$(pbpaste)"`
5. **Anote a data de hoje em `ODOO_API_KEY_CREATED_AT`** (Etapa 4). Sem ela o motor não tem como
   saber a idade da chave, e o aviso de vencimento **nunca dispara**. É uma variável de
   ambiente; o motor grava no banco no boot.

A chave vence em 90 dias. O motor avisa por e-mail a partir de 75 (ver `watchdog`), e quando ela
vence a baixa para de acontecer: o boleto continua sendo emitido e pago, e o Odoo deixa de
receber a liquidação. Trocar a chave não precisa de janela de manutenção.

**Confira:** com `ODOO_URL` e `ODOO_DB` apontando para a **duplicata de teste**, nunca produção:

```bash
ODOO_URL=https://<base>.odoo.com ODOO_DB=<base> scripts/with-op-odoo.sh npm run test:odoo
```

O script exige `op` instalado e logado, com um item chamado exatamente `Odoo API Key - SDC` (é o
que o passo 4 cria). Verde é: os testes passam e a saída lista as faturas lidas, com os campos que
o motor espera. Sem chave, a suíte é **pulada** em vez de falhar — se a saída disser "skipped", a
chave não chegou ao processo.

## Etapa 3 — as duas regras de webhook no Odoo

O motor descobre faturas de duas formas, e as duas são necessárias: o **push** (o Odoo avisa na
hora) e a **varredura** a cada 15 minutos (a rede de segurança, que pega o que o push perdeu).
Esta etapa configura o push.

No Odoo, com o modo desenvolvedor ligado, vá em **Configurações → Técnico → Automações →
Automações**. Crie duas regras.

**Regra A — fatura postada**

| Campo | Valor |
|---|---|
| Modelo | Lançamento contábil (`account.move`) |
| Gatilho | Na atualização (ou "Ao criar e atualizar") |
| Domínio | `[("move_type", "=", "out_invoice"), ("state", "=", "posted")]` |
| Ação | Enviar notificação de webhook |
| URL | `https://<host>/webhook-odoo?k=<ODOO_WEBHOOK_KEY>` |

**Regra B — fatura cancelada ou de volta a rascunho**

Igual à A, com domínio `[("move_type", "=", "out_invoice"), ("state", "in", ["cancel", "draft"])]`.
É ela que faz o motor cancelar o boleto de uma fatura que deixou de valer.

Três detalhes que fazem diferença:

- **O filtro `move_type = out_invoice` é obrigatório na regra.** Sem ele, o Odoo dispara para
  compras e lançamentos internos também. O motor ignora o que não interessa, mas isso vira
  tráfego e ruído no log por nada.
- **O token vai na URL** (`?k=`), porque o webhook do Odoo não manda cabeçalho. Ele precisa ter
  32 caracteres ou mais, e o motor responde 404 (não 401) quando o token está errado, para não
  confirmar a existência do endpoint.
- **O Odoo desiste em 1 segundo e não reenvia.** Por isso o motor só grava o evento e responde
  200 na hora; o processamento é do worker. E por isso a varredura existe.

**Confira:** poste uma fatura de teste na duplicata e veja a linha aparecer:

```sql
select odoo_model, odoo_id, process_status, received_at from odoo_events order by received_at desc limit 5;
```

## Etapa 4 — segredos e primeiro boot

Todos os segredos entram por variável de ambiente. Nunca commite `.env`.

```bash
DATABASE_URL=...
ASAAS_URL=https://api.asaas.com/v3          # produção. sandbox: https://api-sandbox.asaas.com/v3
ASAAS_API_KEY=...                            # $aact_prod_... em produção, $aact_hmlg_... no sandbox
ASAAS_WEBHOOK_TOKEN=...                      # ≥32 chars, nosso; o Asaas devolve em asaas-access-token
ODOO_URL=https://<base>.odoo.com
ODOO_DB=<base>
ODOO_API_KEY=...
ODOO_WEBHOOK_KEY=...                         # ≥32 chars, o mesmo do ?k= das regras
CONSOLE_TOKEN=...                            # ≥32 chars, só para o cron externo
CONSOLE_PUBLIC_URL=https://<host>            # monta o link do console no e-mail de alerta
ODOO_API_KEY_CREATED_AT=2026-09-10           # data da Etapa 2; sem ela o aviso de chave vencendo não dispara
RESEND_API_KEY=...                           # sem ela, alerta crítico NÃO é enviado
ALERT_FROM=motor@<dominio-verificado>
ALERT_EMAIL=financeiro@cliente.com.br,voce@salvei.com.br
TRUSTED_PROXIES=1                            # atrás de Cloud Run / ALB / Cloudflare
```

O motor **falha fechado** no que é essencial: sem `ASAAS_API_KEY` ou sem os dois tokens de
webhook ele não sobe. O que é opcional vira aviso no log, não erro: sem `RESEND_API_KEY` os
alertas ficam em no-op, e sem `CONSOLE_TOKEN` o console responde 503.

O prefixo da chave do Asaas tem que combinar com a URL. Chave de produção com URL de sandbox, ou
o contrário, é recusado no boot — foi o erro que mais quase aconteceu durante o desenvolvimento.

## Etapa 4b — subir o motor e garantir que os jobs rodem

Este é o passo que faz o resto existir. Escolha conforme onde o motor vai morar.

**Container (Cloud Run, ECS, VM, servidor físico) — o caminho recomendado:**

```bash
docker build -t sdc-motor .
docker run -p 8787:8787 --env-file .env sdc-motor
```

**Direto do código, para desenvolvimento ou uma VM simples:**

```bash
npm ci && npm run build && npm start      # produção
npm run dev                                # desenvolvimento, com recarga
```

### Os jobs, que é onde mora a pegadinha

O motor tem um agendador **em processo**: quando ele está no ar, `worker` roda a cada minuto,
`sync-invoices` e `watchdog` a cada 15, e `reconcile-daily` uma vez por dia às 6h BRT. Se o seu
host mantém **um processo sempre ligado** (VM, ECS, servidor físico, Cloud Run com instância
mínima 1), não há mais nada a fazer.

**Se o host desliga o processo quando não há requisição** — Cloud Run com escala a zero é o caso
comum, e é o que este runbook sugere na Etapa 0 — o agendador em processo **não roda**, e sem ele:
nenhum pagamento é processado, nenhuma fatura é varrida, nenhum alerta é disparado. O motor
parece saudável e não faz nada.

A saída é um cron externo chamando a API, que é exatamente o que o `CONSOLE_TOKEN` existe para
abrir (é a única rota que ele ainda abre):

```
POST https://<host>/api/v1/jobs/worker            a cada 1 minuto
POST https://<host>/api/v1/jobs/sync-invoices     a cada 15 minutos
POST https://<host>/api/v1/jobs/watchdog          a cada 15 minutos
POST https://<host>/api/v1/jobs/reconcile-daily   uma vez por dia, 06:00 BRT (09:00 UTC)
```

Todos com `Authorization: Bearer $CONSOLE_TOKEN`. No Cloud Scheduler, um job por linha. Um job
nunca sobrepõe a si mesmo, então chamar mais vezes que o necessário é seguro.

**Confira:** `curl -X POST -H "authorization: Bearer $CONSOLE_TOKEN" https://<host>/api/v1/jobs/watchdog`
devolve 200 com o resumo do watchdog. Depois, a tela Saúde mostra "último watchdog" recente.

**Confira também:** `curl https://<host>/health` devolve `{"ok":true,"idaEnabled":false}`. O
`false` está certo: a emissão ainda não foi ligada.

## Etapa 5 — acesso ao console

```bash
npm run job -- console-user --email pessoa@empresa.com.br --name "Nome da Pessoa"
```

A senha é gerada e impressa **uma vez**; o banco guarda só o hash scrypt. Perdida, use
`--reset-password`, que também derruba as sessões abertas daquela pessoa. Crie um acesso por
pessoa: quem resolveu cada exceção fica registrado, e um acesso compartilhado apaga isso.

**Confira:** abra `https://<host>/console/`, entre, e veja as quatro telas. Exceções deve estar
vazia; Saúde deve mostrar a emissão desligada.

## Etapa 6 — webhook do Asaas

Uma vez por ambiente:

```bash
WEBHOOK_PUBLIC_URL=https://<host>/webhook-asaas ALERT_EMAIL=voce@salvei.com.br \
  npm run job -- register-asaas-webhook
```

O `ALERT_EMAIL` desta linha é do **Asaas**, não do motor: é o endereço que o Asaas usa para
avisar quando interrompe a fila dele. Ele não substitui o `ALERT_EMAIL` do ambiente, que é quem
recebe os alertas do motor. Pode ser o mesmo endereço, e pode ser só o seu.

O job é idempotente: se já existir webhook registrado, ele diz e não cria outro.

**Confira:** no painel do Asaas, o webhook aparece habilitado, com envio sequencial. Na tela
Saúde do console, o cartão "Fila do Asaas" mostra `ok`.

O que você precisa saber sobre esta fila: o Asaas **interrompe** a entrega depois de 15 falhas
consecutivas, e a partir daí nenhum pagamento chega ao motor. O watchdog detecta em até 15
minutos, pede a reativação, abre exceção e manda e-mail. Os eventos ficam guardados 14 dias; o
que passar disso só volta pelo reconcile diário, dentro da janela de lookback.

## Etapa 7 — a régua (`GO_LIVE_CUTOFF_DATE`)

Esta é a etapa que evita o pior acidente possível: o motor emitir boleto para o estoque
histórico de faturas do cliente.

Na tela **Configuração** do console, defina `GO_LIVE_CUTOFF_DATE` com a data de hoje (ou a data
combinada de início). Fatura com data anterior a essa **nunca** é cobrada pelo motor.

A régua vem **antes** de ligar a emissão, e não é só recomendação: o console **recusa** ligar
`IDA_ENABLED` sem data de corte, com a mensagem "defina GO_LIVE_CUTOFF_DATE antes de ligar
IDA_ENABLED". E mesmo que fosse ligada por outro caminho, nada seria emitido sem a régua. São
duas defesas para o mesmo acidente, e as duas são de propósito.

**Confira:** a tela Configuração mostra a data, e a tela Saúde continua com a emissão desligada.

## Etapa 8 — piloto com 3 a 5 clientes

Não ligue a emissão para a base inteira no primeiro dia. Escolha de 3 a 5 clientes que:

- têm CPF ou CNPJ preenchido e correto no Odoo (sem isso o motor abre exceção e não emite);
- pagam por boleto normalmente;
- alguém do financeiro conhece pelo nome, para notar se algo sair errado.

Poste as faturas desses clientes com data **igual ou posterior** à régua. As outras ficam de
fora sozinhas.

## Etapa 9 — ligar a emissão

Na tela **Configuração**, ligue `IDA_ENABLED`. O console pede confirmação e mostra o que vai
acontecer, porque a partir desse clique sai boleto de verdade.

**Confira, nos primeiros 30 minutos:**

1. Tela **Cobranças**: uma cobrança por parcela, com valor e vencimento iguais aos do Odoo.
2. Clique em "abrir boleto" numa delas: o PDF do Asaas abre com o valor certo.
3. Tela **Exceções**: idealmente vazia. Se aparecer `customer_missing_document`, é cadastro do
   Odoo sem CPF/CNPJ — corrija no Odoo e clique em **reprocessar**.
4. Tela **Saúde**: emissão ligada, fila do Asaas ok, último evento do Odoo recente.

### Os primeiros dias

| Quando | O que olhar |
|---|---|
| Dia 1, de manhã e de tarde | Tela Exceções. Toda exceção nova é informação: ou é cadastro, ou é caso que ninguém previu |
| No primeiro pagamento | A cobrança vira "recebida" e o detalhe mostra a conciliação com diferença zero. Confira no Odoo se a parcela fechou |
| Dia 2 | Tela Saúde: o reconcile diário rodou de madrugada e o cartão mostra "sem erro" |
| Primeira semana | Faixas de vencimento na tela Saúde. Cobrança vencida acumulando é assunto de cobrança, não de motor |

### Quando o cliente pagar com juros

Se o boleto for pago depois do vencimento, o Asaas cobra juros e multa, e o valor recebido fica
acima do da cobrança. O motor **não** baixa sozinho nesse caso: abre uma exceção
`writeoff_needed` com o botão "aceitar diferença". Aceitar registra a baixa no Odoo com o valor
recebido. Se o financeiro preferir que isso seja automático, ligue `JUROS_MULTA_AUTO` na
Configuração — a decisão é de quem fecha o mês, não do motor.

## Como desligar tudo

**Desligar a emissão** (dez segundos, sem deploy): tela Configuração, desligue `IDA_ENABLED`.
Nenhuma fatura nova vira boleto. O que já foi emitido continua valendo e continua sendo baixado
quando o cliente pagar — é kill switch da ida, não da volta.

**Parar o motor inteiro:** derrube o container. Os webhooks do Asaas ficam guardados 14 dias e o
Odoo tem a varredura como rede de segurança, então uma parada curta não perde dado. Uma parada
longa é recuperada pelo reconcile diário, dentro da janela de lookback.

**Emergência, com o motor fora do ar:** direto no banco,
`update app_config set value = 'false'::jsonb where key = 'IDA_ENABLED';`

## Quando algo dá errado

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Nenhum boleto sai | Emissão desligada, ou régua depois da data da fatura | Tela Configuração: confira os dois |
| `customer_missing_document` | Cadastro do Odoo sem CPF/CNPJ válido | Corrija no Odoo, clique em reprocessar |
| `amount_divergent` | Cliente pagou valor diferente | Decisão humana: nada é baixado sozinho |
| `writeoff_needed` | Pagou com juros e multa do Asaas | Botão "aceitar diferença", ou ligue `JUROS_MULTA_AUTO` |
| `queue_interrupted` | Asaas interrompeu a fila após 15 falhas | O motor já pediu reativação; veja por que o endpoint falhou |
| `integration_error` | Job falhando (chave vencida, base expirada, banco fora) | O detalhe da exceção tem o erro cru |
| `stale_heartbeat` | Nenhum pagamento há 8h em horário comercial | Confira no painel do Asaas se houve pagamento hoje |
| Baixa não acontece, sem exceção | Chave do Odoo vencida | Etapa 2 de novo; o watchdog avisa a partir de 75 dias |

## O que este motor deliberadamente NÃO faz

- Não usa o parcelamento nativo do Asaas. Uma cobrança por parcela do Odoo, sempre — o
  `externalReference` do parcelamento nativo propaga igual para todas as parcelas e impediria
  identificar qual parcela foi paga.
- Não dá baixa em `PAYMENT_CONFIRMED`, só em `PAYMENT_RECEIVED`. Confirmado não é dinheiro na
  conta.
- Não acredita no payload do webhook. Relê o pagamento no Asaas antes de qualquer transição,
  porque o webhook não é assinado.
- Não marca cobrança como recebida sem o Odoo confirmar. A parcela é lida por id e o residual é
  comparado antes e depois do registro do pagamento. Uma base expirada devolvendo HTML já gerou
  baixa falsa numa rodada de QA, e é essa a defesa.
