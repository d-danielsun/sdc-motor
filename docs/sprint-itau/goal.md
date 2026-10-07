# Sprint pivô Itaú — objetivo e limiar

**Objetivo:** o motor deixa de depender do Asaas no núcleo e ganha um cliente Itaú (auth + mTLS + certificado) pronto para receber a Cobrança V2 quando o banco responder — sem inventar o que o banco ainda não disse e sem mudar nenhuma regra de dinheiro.

**Entregáveis**
1. Porta de gateway neutra em `src/core` (`ChargeGateway`); Asaas vira um adaptador atrás dela, sem regressão.
2. `src/adapters/itau/`: token OAuth `client_credentials` via mTLS, cache < 300 s, headers `x-itau-*`, solicitação/renovação de certificado — testados contra fake.
3. Cobrança V2 e aviso de pagamento Itaú: **stub explícito** que lança `GatewayNotReady` com o motivo (aguardando banco). Nada inventado.
4. SPEC v2 (`propostas/sdc/02-SPEC.md` §Itaú) e `scripts/wizard-sdc-itau.sh`.
5. S0.1 Odoo somente-leitura executado de verdade (ou bloqueio registrado com a causa exata).

**Passa com:** score ≥ 90 em `loss.md`, nenhum hard-fail, todos os probes verdes.
**Máx. iterações:** 4. Score parado por 2 iterações → para e escala ao Dan.
