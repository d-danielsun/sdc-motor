// ItauGateway: a porta neutra para o Itaú. HOJE é um stub explícito — o banco ainda não disse
// (a) como avisa pagamento, (b) o payload da Cobrança V2, (c) carteira/protesto. Toda operação de
// cliente, cobrança e liquidação lança GatewayNotReady. Nenhum endpoint de boleto é escrito aqui:
// inventar contrato de banco é o jeito mais rápido de emitir boleto errado para cliente real.
//
// O que já existe e funciona: o ItauClient (token OAuth sobre mTLS, headers x-itau-*), exigido no
// construtor — então montar este gateway já prova que cert/key/credenciais estão no lugar.
import { type ChargeGateway, type GatewayCharge, type GatewayCustomer, type GatewayEventQueue, GatewayNotReady, type SettlementEvent } from "../../core/gateway.js";
import type { ItauClient } from "./config.js";

const espera = (op: string) => new GatewayNotReady(`aguardando Cobrança V2 do Itaú: ${op}`);

export class ItauGateway implements ChargeGateway {
  readonly name = "itau";
  /** Sem emissão real até a Cobrança V2: o boot e o console recusam ligar a ida com este gateway. */
  readonly canIssue = false;
  constructor(readonly client: ItauClient) {}

  async findCustomerByExternalRef(_ref: string): Promise<GatewayCustomer | null> { throw espera("achar cliente por referência"); }
  async findCustomerByDocument(_doc: string): Promise<GatewayCustomer | null> { throw espera("achar cliente por CPF/CNPJ"); }
  async createCustomer(_c: Parameters<ChargeGateway["createCustomer"]>[0]): Promise<GatewayCustomer> { throw espera("criar cliente"); }
  async updateCustomer(_id: string, _p: { notificationDisabled?: boolean }): Promise<GatewayCustomer> { throw espera("atualizar cliente"); }

  async createCharge(_p: Parameters<ChargeGateway["createCharge"]>[0]): Promise<GatewayCharge> { throw espera("criar cobrança"); }
  async getCharge(_id: string): Promise<GatewayCharge | null> { throw espera("obter cobrança"); }
  async findChargeByExternalRef(_ref: string): Promise<GatewayCharge | null> { throw espera("achar cobrança por referência"); }
  async cancelCharge(_id: string): Promise<void> { throw espera("cancelar cobrança"); }
  // eslint-disable-next-line require-yield
  async *listCharges(_f: Parameters<ChargeGateway["listCharges"]>[0]): AsyncIterable<GatewayCharge> { throw espera("listar cobranças liquidadas"); }

  /** O formato do aviso de pagamento do Itaú (webhook ou consulta) ainda não foi informado pelo banco. */
  parseSettlementEvent(_payload: unknown): SettlementEvent | null { throw new GatewayNotReady("aguardando o Itaú definir o aviso de pagamento (webhook ou consulta): ler aviso"); }
  async getEventQueue(_id: string): Promise<GatewayEventQueue | null> { throw new GatewayNotReady("aguardando o Itaú definir o aviso de pagamento: estado da fila de avisos"); }
  async resumeEventQueue(_id: string): Promise<void> { throw new GatewayNotReady("aguardando o Itaú definir o aviso de pagamento: retomar fila de avisos"); }
}
