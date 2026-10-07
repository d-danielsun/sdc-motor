# Função de perda — sprint pivô Itaú

| Dimensão | Peso | Como mede |
|---|---|---|
| Invariantes de dinheiro intactos | 35 | suíte `test/db` inteira verde, sem editar asserts existentes; probes P1–P4 |
| Desacoplamento real | 20 | `src/core` sem `asaas` fora do adaptador/tipos legados mapeados; `boundary.test.ts` verde |
| Cliente Itaú correto | 20 | testes unit do adaptador: token, cache/renovação, 401→refresh 1x, headers, mTLS obrigatório |
| Honestidade das lacunas | 15 | Cobrança/aviso = `GatewayNotReady`; nenhum endpoint/payload de boleto inventado; SPEC marca as lacunas |
| Operabilidade | 10 | wizard `bash -n`+shellcheck; `.env.example` com as vars Itaú; README atualizado |

**Limiar:** 90.

## Hard-fail (qualquer um zera)
- `npm test` ou `npm run typecheck` vermelho.
- Contagem de testes abaixo de 251 (teste apagado ou pulado para passar).
- Assert existente enfraquecido ou removido em `test/db` / `test/unit`.
- `IDA_ENABLED` passa a default true, ou emissão possível sem `GO_LIVE_CUTOFF_DATE`.
- Endpoint/payload da Cobrança V2 ou do aviso de pagamento escrito como se fosse conhecido.
- Segredo, chave privada ou certificado commitado.
- Chamada de escrita ao Odoo real ou chamada a produção Itaú.

## Anti-trapaça
Não editar `harness/` nem asserts para caber na implementação; não `skip`/`only`; não mockar a própria função testada.
