# Checklist de go-live

Confira item por item antes de ligar a emissão para clientes reais. O runbook
(`RUNBOOK-R1.md`) diz **como** fazer cada coisa; este documento diz **o que não pode faltar** e
**quem** resolve o que não é técnico.

Marque com data e nome de quem conferiu. Item sem responsável é item que não acontece.

## 1. Conta Asaas da SDC

- [ ] Cadastro aprovado (KYC concluído) — **conta em análise não emite boleto**
- [ ] Conta bancária de recebimento cadastrada e validada
- [ ] Chave Pix cadastrada, se o boleto for sair com Pix
- [ ] Taxa por boleto e prazo de repasse conferidos com quem paga a conta
- [ ] Chave de API **de produção** gerada (prefixo `$aact_prod_`) e guardada no 1Password
- [ ] Multa e juros por atraso configurados na conta, ou decidido que não haverá
- [ ] Decidido quem envia a cobrança ao cliente: o Asaas (notificações ligadas) ou a SDC por
      fora. Ligar notificações é **irreversível em lote** pelo console e faz o Asaas mandar
      e-mail e SMS para todos os clientes já sincronizados

Responsável pelos itens acima: **[quem tem acesso à conta Asaas da SDC]**.

## 2. Odoo

- [ ] Usuário com chave de API criada, guardada no 1Password, com a data de criação registrada
      em `ODOO_API_KEY_CREATED_AT` (é o que faz o motor avisar antes de vencer)
- [ ] Regra A (fatura postada) criada, com `move_type = out_invoice` no domínio
- [ ] Regra B (cancelada ou rascunho) criada
- [ ] As duas regras apontam para o host **de produção**, com o token certo no `?k=`
- [ ] Confirmado que ninguém dá baixa manual nas parcelas que o motor cobra, ou aceito que
      quando isso acontecer o motor cancela o boleto órfão
- [ ] Alguém sabe qual base é produção e qual é duplicata, e a duplicata **não** é usada para
      escrita fora dos spikes

## 3. Infraestrutura

- [ ] Host com HTTPS válido (o Asaas não entrega webhook em http)
- [ ] Postgres com conexão de **sessão** (não pooler em modo transação)
- [ ] Backup do banco configurado, com restauração testada pelo menos uma vez
- [ ] Healthcheck do orquestrador apontando para `/health` — **o motor não avisa por e-mail
      quando o próprio banco está fora**, porque o dedupe do alerta vive no banco. Esse caso é
      do orquestrador, não do motor
- [ ] `TRUSTED_PROXIES` definido conforme a topologia (Cloud Run, ALB e Cloudflare = 1). Se
      ficar em 0 atrás de proxy, o freio de tentativas de login conta todo mundo como a mesma
      origem; se ficar alto demais, o cliente pode escolher a própria identidade
- [ ] Migrations aplicadas no banco de produção
- [ ] Fuso do container irrelevante por desenho: datas civis são calculadas em
      America/Sao_Paulo pelo próprio código

## 4. Segredos

- [ ] Nenhum `.env` commitado (o CI tem varredura de segredos, e ela roda em todo PR)
- [ ] `ASAAS_WEBHOOK_TOKEN` e `ODOO_WEBHOOK_KEY` com 32 caracteres ou mais, diferentes entre si
- [ ] `CONSOLE_TOKEN` com 32 caracteres ou mais, usado **só** pelo cron externo
- [ ] Prefixo da chave do Asaas combinando com a URL (`$aact_prod_` com `api.asaas.com`)
- [ ] Todos no 1Password, nenhum em chat, planilha ou ticket
- [ ] Rotação combinada: chave do Odoo a cada 90 dias (o motor avisa a partir de 75), chave do
      Asaas quando alguém com acesso sair da empresa

## 5. Quem recebe alerta

- [ ] `ALERT_EMAIL` com pelo menos duas pessoas, sendo uma da SDC e uma da Salvei
- [ ] `ALERT_FROM` com domínio **verificado** no Resend (remetente não verificado é recusado, e
      o erro aparece em `alerts_sent.error`)
- [ ] `CONSOLE_PUBLIC_URL` definido, senão o e-mail sai sem o link que resolve o problema
- [ ] Combinado quem olha a fila de exceções, com que frequência, e o que acontece quando essa
      pessoa está de férias
- [ ] Um alerta de teste enviado e recebido de verdade, com o link clicado

Os quatro alertas, e o que cada um significa:

| Alerta | Significa | Urgência |
|---|---|---|
| Fila do Asaas interrompida | Nenhum pagamento está chegando; nenhuma baixa acontece | Agora. Eventos morrem em 14 dias |
| Job falhando | Uma parte do ciclo parou (chave vencida, base expirada, banco fora) | Hoje |
| Nenhum pagamento chegou hoje | Pode ser dia fraco, pode ser o caminho de volta quebrado | Hoje, com uma olhada no painel do Asaas |
| Chave do Odoo vencendo | Quando vencer, a baixa para de acontecer em silêncio | Esta semana |

Cada um avisa uma vez por janela: 6 horas para os três primeiros, 24 para o da chave. É de
propósito: alerta repetido é alerta ignorado.

## 6. Console

- [ ] Um usuário por pessoa, nenhum compartilhado (quem resolveu cada exceção fica registrado)
- [ ] Senha entregue pelo 1Password, nunca por chat
- [ ] Quem vai operar viu as quatro telas e sabe o que cada tipo de exceção quer dizer
- [ ] Combinado que trocar senha e desativar acesso é feito por linha de comando
      (`npm run job -- console-user`), e quem faz

## 7. A régua e o piloto

- [ ] `GO_LIVE_CUTOFF_DATE` definida **antes** de ligar a emissão
- [ ] Conferido que a régua exclui o estoque histórico de faturas
- [ ] 3 a 5 clientes escolhidos para o piloto, todos com CPF ou CNPJ correto no Odoo
- [ ] Alguém do financeiro sabe que esses clientes vão receber boleto do motor
- [ ] Combinado quanto tempo o piloto dura antes de abrir para a base inteira

## 8. Antes de considerar entregue

- [ ] Uma cobrança emitida, paga e baixada de ponta a ponta, conferida **no Odoo**
- [ ] Uma exceção resolvida pelo console por alguém do cliente, não por nós
- [ ] O kill switch testado: desligar e religar a emissão
- [ ] O runbook lido por alguém que não participou da implantação, que conseguiu seguir sozinho
- [ ] Combinado o que é suporte e o que é evolução, e por qual canal

## O que fica fora desta entrega

Registrado para não haver dúvida depois:

- Sem resumo diário por e-mail. Só alerta crítico, no momento em que acontece. O corte está
  marcado no código (`gstack-shortcut` em `src/core/usecases/notify.ts`) com o gatilho que
  justifica mudar de ideia.
- Sem WhatsApp e sem SMS de alerta.
- Sem escalonamento por plantão: todo mundo em `ALERT_EMAIL` recebe ao mesmo tempo.
- Sem página de status pública.
