# Runbook — trocar de gateway (`GATEWAY=asaas|itau`)

Decisão do Dan (2026-10-07): **um gateway ativo por vez**. O motor não roda Asaas e Itaú em paralelo.

## Pré-condição: zero cobranças abertas no gateway atual
Cobrança aberta no gateway que sai perde a baixa automática: os avisos dele caem em `error` e o reconcile
deixa de consultá-lo. Por isso só se troca com **zero** cobranças abertas (`created`, `confirmed` ou em `exception`).

Conferir no banco do motor:
```sql
select status, count(*) from charges where status in ('created','confirmed','exception') group by status;
-- tem que voltar vazio: 'exception' também conta — uma baixa pendente de decisão fica órfã depois da troca
```
No console: o painel de saúde mostra as cobranças abertas — tem que estar em 0.
Também conferir no painel do gateway que sai que não há boleto pendente emitido pelo motor.

Se houver abertas: esperar liquidarem/vencerem, ou cancelar no gateway e no motor, antes de trocar.

## Passos
1. Console → desligar a ida (`IDA_ENABLED=false`). Esperar o tick de varredura em curso terminar.
2. Rodar a consulta acima → vazio.
3. Trocar `GATEWAY` no ambiente e reiniciar servidor e jobs. O boot (`main.ts` e `npm run job`) recusa subir
   com um gateway que não emite e a ida ligada.
   Ficou preso nessa recusa (trocou o `GATEWAY` antes de desligar a ida)? O console não sobe para desligá-la.
   Desligue direto no banco do motor e suba de novo:
   ```sql
   update app_config set value = 'false'::jsonb, updated_at = now() where key = 'IDA_ENABLED';
   ```
   `npm run job -- console-user …` não passa por essa recusa (só mexe no banco); os jobs e
   `register-asaas-webhook` continuam barrados.
4. Gateway que emite: religar a ida no console. Gateway que ainda não emite (Itaú até a Cobrança V2): a ida
   fica desligada.

## O que o motor faz com um gateway que não emite (Itaú hoje)
- `sync-invoices` não varre e **não avança o watermark** (`SYNC_LAST.ok=false`, `gatewayCanIssue=false`):
  ao voltar para um gateway que emite, todas as faturas do período ainda são cobradas.
- `reconcile-daily` pula com o motivo e não grava `RECONCILE_LAST`: a janela cresce até o último sucesso.
  A tentativa do dia fica em `RECONCILE_SKIPPED_LAST`, então o diário (e as purgas) roda **uma vez por dia**,
  não a cada minuto. Trocou para um gateway que emite no mesmo dia em que já houve o pulo? O diário só volta
  sozinho no dia seguinte; para não esperar, `npm run job -- reconcile-daily`.
- `watchdog` pula só a checagem da fila de avisos (`eventQueueSkipped`); silêncio e exceções travadas seguem alertando.
