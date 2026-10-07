# Spec congelada — pivô Itaú (sprint/itau-pivo)

Decisão da SDC em 25/09/2026: a cobrança passa a ser emitida pelo Itaú (API de Cobrança V2), não pelo Asaas.
O banco ainda não respondeu: (a) como avisa pagamento (webhook vs consulta), (b) payload da Cobrança V2, (c) carteira/protesto.
Esta sprint faz **só o que não depende dessas respostas**.

## Dentro
1. **Porta neutra `ChargeGateway`** (`src/core/gateway.ts`): as operações que o núcleo realmente usa — cliente
   (achar/criar/atualizar), cobrança (criar, obter, achar por externalReference, cancelar, listar liquidadas) e
   eventos de liquidação normalizados (`SettlementEvent`: gatewayChargeId, externalReference, status, valor bruto,
   líquido, datas). O núcleo (`src/core/**`) passa a depender só da porta. Tipos `Asaas*` ficam no adaptador.
2. **`AsaasGateway`** implementa a porta embrulhando o `AsaasClient` atual, sem mudar comportamento. Webhook Asaas
   e varreduras continuam funcionando idênticos (é o adaptador que traduz para `SettlementEvent`).
3. **Banco de dados: nada é renomeado.** Colunas `asaas_*` e tabela `asaas_events` ficam (migration aplicada é
   imutável). O repo mapeia campo neutro ↔ coluna. Renomear é tarefa futura, em migration nova, depois do piloto.
4. **`src/adapters/itau/`**:
   - `auth.ts`: token OAuth `POST https://sts.itau.com.br/api/oauth/token`, form `grant_type=client_credentials`,
     `client_id`, `client_secret`, sobre **mTLS** (cert+key PEM, via `undici` Agent ou `https.Agent`). Cache em
     memória ≤ 270 s; pedidos simultâneos compartilham uma chamada; 401 → erro claro sem retry em loop.
   - `headers`: `authorization: Bearer`, `x-itau-apikey: <client_id>`, `x-itau-correlationID`, `x-itau-flowID` (UUID novo por chamada).
   - `certificate.ts`: `solicitar(csrPem, tokenTemporario)` → `POST /seguranca/v1/certificado/solicitacao` (text/plain,
     Bearer temporário) e `renovar(csrPem, token)` → `/seguranca/v1/certificado/renovacao` com mTLS. Devolve o texto
     da resposta sem interpretar além do necessário. Função `diasParaVencer(certPem)` para o alerta (renovar 30→1 dia antes).
   - `ItauGateway` implementa `ChargeGateway`: toda operação de cobrança/cliente/liquidação lança
     `GatewayNotReady("aguardando Cobrança V2 do Itaú: <operação>")`. **Nenhum endpoint de boleto é escrito.**
   - Config: `ITAU_CLIENT_ID`, `ITAU_CLIENT_SECRET`, `ITAU_CERT_PEM|ITAU_CERT_FILE`, `ITAU_KEY_PEM|ITAU_KEY_FILE`,
     `ITAU_TOKEN_URL` (default acima). Sem cert/key → o cliente recusa construir.
5. **Seleção:** `GATEWAY=asaas|itau` (default `asaas`). `GATEWAY=itau` + `IDA_ENABLED=true` → boot recusa.
6. **Wizard** `scripts/wizard-sdc-itau.sh` (template mattpocock): agência/conta → par RSA (já feito; só confere) →
   decifrar o e-mail do banco (Client ID + token temporário) → gerar CSR (`/CN=<client_id>/OU=SDC/L=SAO PAULO/ST=SP/C=BR`)
   → solicitar certificado → guardar cert/key/secret no 1Password → testar token. Passos cujo formato é desconhecido
   (como o banco cifra o e-mail) dizem isso e pedem o comando ao humano em vez de inventar.
7. **Docs:** `.env.example`, README (seção Gateway), e §Itaú no `~/w/salvei/propostas/sdc/02-SPEC.md` (v2).

## Fora
Emissão real de boleto, aviso de pagamento Itaú, rename de schema, régua, UI.

## Invariantes (não mudam)
Baixa só com parcela lida por id + residual antes×depois + memo `<gateway>:<id>` idempotente (para Asaas continua
`asaas:<pay_id>` — não muda o formato existente); `IDA_ENABLED=false` default; sem `GO_LIVE_CUTOFF_DATE` nada sai;
locks por cobrança/fatura. Critério de pronto: `docs/sprint-itau/{goal,loss}.md`, `harness/score.sh`, probes P1–P9.
