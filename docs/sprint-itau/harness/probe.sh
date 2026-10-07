#!/usr/bin/env bash
# Probes que o verificador roda além da suíte. Cada um vira teste em test/unit/itau-*.test.ts ou test/db/gateway-*.test.ts.
cat <<'P'
P1 webhook/aviso repetido do gateway → 1 baixa só (memo idempotente), via porta neutra
P2 valor pago ≠ residual → exceção, nenhuma baixa (com Asaas atrás da porta)
P3 IDA_ENABLED ausente → nenhuma cobrança criada em nenhum gateway
P4 sem GO_LIVE_CUTOFF_DATE → nada emitido
P5 Itaú: STS responde 401 → erro claro, sem loop de retry
P6 Itaú: token expira (>270 s) → renova uma vez; dois pedidos simultâneos → 1 chamada ao STS
P7 Itaú: sem cert/key configurados → recusa subir o cliente (nunca chama sem mTLS)
P8 Itaú: criar cobrança → GatewayNotReady com motivo "aguardando Cobrança V2 do banco"
P9 GATEWAY=itau com IDA_ENABLED=true → boot recusa (não há emissão real ainda)
P
