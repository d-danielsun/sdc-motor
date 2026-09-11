# Rollback de migration

**Migration é forward-only neste projeto.** O caminho normal de desfazer uma mudança de schema é
escrever uma migration nova que a reverta, não rodar o arquivo daqui. O runner (`npm run db:migrate`)
nem sabe que esta pasta existe: ele recusa aplicar arquivo que ordene antes do último aplicado, e
recusa arquivo já aplicado que tenha sido editado.

Então para que serve isto? Para **um** caso: o deploy acabou de subir, a migration foi aplicada, o
código novo está quebrando, e a decisão é voltar o código. Nesse momento alguém precisa saber, sem
pensar, o que exatamente desfazer — e descobrir isso lendo SQL de trás para frente, às pressas, é
como se perde dado.

## Duas regras antes de qualquer coisa

1. **Só a ÚLTIMA migration aplicada pode ser desfeita por aqui.** Desfazer uma do meio e apagar a
   linha dela deixa o runner travado para sempre: a guarda de ordem estrita recusa reaplicá-la e
   recusa tudo que vier depois. Para desfazer uma anterior, desfaça em cascata da mais nova até
   ela — ou, melhor, escreva uma migration nova para frente.
2. **O código volta ANTES do schema.** O motor novo não sobe sem as colunas novas, e o motor
   antigo quebra com elas em alguns casos. Derrube o container, volte a imagem anterior, e só
   então rode o down.
3. **Índice único sobre tabela que recebe webhook: pare o tráfego antes de migrar.** Vale para
   aplicar, não para desfazer, e é a regra que a 0008 estabeleceu do jeito difícil. Uma migration
   que limpa duplicatas e cria índice único na mesma transação aborta se um evento novo cair no
   meio da limpeza — e como o motor recusa subir com migration pendente, o resultado é deploy
   travado com o motor fora do ar. Antes de `db:migrate`, desligue as duas regras de automação no
   Odoo (Etapa 5 do RUNBOOK-R1, ao contrário) e religue depois. A alternativa de código é
   `create index concurrently` num passo fora da migration — `concurrently` não roda dentro de
   transação, então isso muda o runner, e por ora a decisão registrada é a regra de operação.

## Como usar

```bash
psql "$DATABASE_URL" -1 -f db/migrations/down/0008_hardening.sql
psql "$DATABASE_URL" -c "delete from schema_migrations where name = '0008_hardening.sql'"
```

O `-1` roda em transação única: ou desfaz tudo, ou nada. A linha em `schema_migrations` **tem** que
sair junto, senão o runner acha que a migration ainda está aplicada e nunca a reaplica.

Rollback é por migration, **não por item**. A 0008 mudou três coisas; o down dela desfaz as três.

## O que cada down PERDE de dado

Leia antes de rodar. `drop column` e `drop table` não têm volta.

| Arquivo | O que se perde |
|---|---|
| `0008_hardening.sql` | **Para as duas filas na hora, e o webhook do Odoo junto. Não rode com o motor no ar.** O código referencia `claim_token` sem guarda (`claimSql`/`markSql`/`touchSql`), então todo tick morre com `column "claim_token" does not exist`; e o insert usa `on conflict (odoo_model, odoo_id) where process_status='pending'`, que sem o índice estoura `42P10` e devolve 500 no `/webhook-odoo`. **Volte o CÓDIGO antes do schema.** Também perde os hashes das migrations (o backfill os recria) e não devolve a `pending` as notificações que a migration colapsou. |
| `0007_alerts_sent.sql` | **Todo o histórico de alertas enviados.** Depois disso, o primeiro tick de cada alerta manda e-mail de novo, porque a janela de silêncio vive nessa tabela. |
| `0006_audit_console.sql` | Nada de dado; mas linhas de `audit_log` com `direction='console'` passam a violar a constraint restaurada, então elas são **apagadas** primeiro. É trilha de login e logout. |
| `0005_console_users.sql` | **Todos os usuários e sessões do console.** Ninguém entra até serem recriados por `npm run job -- console-user`. As senhas não são recuperáveis. |
| `0004_review_hardening.sql` | Os índices e a unicidade de `reconciliations.charge_id` — **é a defesa contra baixa em dobro no schema**. Não rode este down com o motor no ar. Também perde `sync_watermarks.last_id`, o que faz a varredura repetir um segundo de faturas. |
| `0003_claim_and_integration_error.sql` | `locked_at` das duas filas, e as exceções de tipo `integration_error` (a constraint antiga não as aceita, então são **apagadas**). Eventos em `processing` viram `pending`, senão a constraint antiga os rejeita. |

Não há down para `0001_core.sql` nem `0002_rls_supabase.sql`: desfazer a 0001 é apagar o banco
inteiro (`npm run db:reset` em desenvolvimento), e a 0002 só cria policies que a 0004 complementa.
