// Portas: tudo que o núcleo precisa do mundo. Adaptadores implementam; fakes também.
import type {
  Alert, AsaasCustomer, AsaasPayment, AsaasWebhook, AuditDirection, Charge, ChargeStatus, CustomerMap,
  DiffPolicy, ExceptionType, Money, OdooInvoice, OdooInvoiceLine, OdooPartner, OdooPaymentResult,
  ProcessStatus, StoredAsaasEvent, StoredOdooEvent,
} from "./types.js";

export interface OdooClient {
  /** Faturas de cliente (postadas/canceladas/rascunho) depois do watermark. O Odoo devolve write_date truncado a segundos
   *  (o banco tem microssegundos): `after` é um BALDE de 1 s — "segundo maior" OU "mesmo segundo e id maior". Ordem (write_date, id). */
  searchInvoices(q: { after?: { writeDate: string; id: number } | null; invoiceDateFrom?: string | null; partnerId?: number | null; limit?: number }): Promise<OdooInvoice[]>;
  /** Drena um balde de 1 segundo ordenado por id — usado quando uma página inteira cai no mesmo segundo (confirmação em lote). */
  searchInvoicesInSecond(q: { second: string; afterId: number; invoiceDateFrom?: string | null; limit?: number }): Promise<OdooInvoice[]>;
  getInvoice(id: number): Promise<OdooInvoice | null>;
  getOpenPaymentTermLines(moveId: number): Promise<OdooInvoiceLine[]>;
  /** Todas as parcelas da fatura (conciliadas ou não) — numeração "k/n" e detecção de parcela sumida. */
  getPaymentTermLines(moveId: number): Promise<OdooInvoiceLine[]>;
  /** A linha exata, conciliada ou não; null = não existe (mais) no Odoo. */
  getPaymentTermLine(lineId: number): Promise<OdooInvoiceLine | null>;
  getPartner(id: number): Promise<OdooPartner | null>;
  /** Registra a baixa com chave de idempotência (`ref`): se já existe pagamento com essa ref no Odoo, adota ou recusa — nunca duplica. */
  registerPayment(p: { moveLineId: number; amount: Money; paymentDate: string; ref: string }): Promise<OdooPaymentResult>;
}

export interface AsaasClient {
  findCustomerByExternalRef(ref: string): Promise<AsaasCustomer | null>;
  /** Cliente que a SDC já tinha no Asaas (sem a nossa referência): adotar em vez de duplicar por CPF/CNPJ. */
  findCustomerByDocument(cpfCnpj: string): Promise<AsaasCustomer | null>;
  createCustomer(c: {
    name: string; cpfCnpj: string; email?: string | null; phone?: string | null;
    externalReference: string; notificationDisabled: boolean;
  }): Promise<AsaasCustomer>;
  updateCustomer(id: string, patch: { notificationDisabled?: boolean }): Promise<AsaasCustomer>;
  createPayment(p: {
    customer: string; value: Money; dueDate: string; externalReference: string; description: string;
  }): Promise<AsaasPayment>;
  getPayment(id: string): Promise<AsaasPayment | null>;
  /** Boleto vivo (não deletado) com este externalReference — idempotência da ida pela fonte de verdade. */
  findPaymentByExternalRef(ref: string): Promise<AsaasPayment | null>;
  deletePayment(id: string): Promise<void>;
  /** `creditDateFrom` usa `estimatedCreditDate[ge]`: boleto pago numa quinta e creditado na terça
   *  sai da janela de `paymentDate` quando finalmente vira RECEIVED. */
  listPayments(f: { status?: string; paymentDateFrom?: string; creditDateFrom?: string; externalReference?: string }): AsyncIterable<AsaasPayment>;
  getWebhook(id: string): Promise<AsaasWebhook | null>;
  listWebhooks(): Promise<AsaasWebhook[]>;
  createWebhook(w: { name: string; url: string; email: string; authToken: string; events: string[] }): Promise<AsaasWebhook>;
  updateWebhook(id: string, patch: { interrupted?: boolean; enabled?: boolean }): Promise<AsaasWebhook>;
}

export interface Repo {
  config: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
  };
  customers: {
    getByPartner(odooPartnerId: number): Promise<CustomerMap | null>;
    upsert(c: Omit<CustomerMap, "id">): Promise<CustomerMap>;
    listSynced(): Promise<CustomerMap[]>;
  };
  charges: {
    getByMoveLine(moveLineId: number): Promise<Charge | null>;
    getByExternalRef(ref: string): Promise<Charge | null>;
    getByAsaasPayment(asaasPaymentId: string): Promise<Charge | null>;
    listByMove(moveId: number): Promise<Charge[]>;
    /** Insere; null se outra execução já criou a cobrança desta parcela (unique em odoo_move_line_id). */
    insert(c: Omit<Charge, "id">): Promise<Charge | null>;
    /** Transição atômica: só grava se o status atual está em `from`. Devolve false se perdeu a corrida. */
    transition(id: number, from: ChargeStatus[], to: ChargeStatus, patch?: Partial<Pick<Charge, "asaasPaymentId" | "bankSlipUrl" | "nossoNumero" | "asaasInvoiceNumber">>): Promise<boolean>;
    /** Conciliação + status 'received' numa transação só. false = já existia conciliação (unique). */
    markReceived(id: number, r: {
      odooPaymentId: number | null; amountReceived: Money; amountExpected: Money; netValue: Money | null;
      diffPolicy: DiffPolicy | null; paymentDate: string | null; creditDate: string | null;
    }, patch?: Partial<Pick<Charge, "asaasPaymentId" | "nossoNumero" | "asaasInvoiceNumber">>): Promise<boolean>;
    countOpen(): Promise<number>;
    /** Cobranças abertas vencidas há mais de N dias — passe do reconcile guiado por cobrança (webhook e janela podem ter falhado). */
    listOpenDueBefore(date: string, limit: number): Promise<Charge[]>;
  };
  /** Exclusão mútua entre execuções (worker, varredura, reconcile, console): advisory lock do Postgres. */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; busy: true }>;
  asaasEvents: {
    insert(e: { asaasEventId: string; eventType: string; asaasPaymentId: string | null; payload: unknown }): Promise<number | null>; // null = duplicado
    pending(limit: number, now: Date): Promise<StoredAsaasEvent[]>;
    /** `false` = a reserva foi perdida (outro worker assumiu depois do TTL): NÃO sobrescreveu nada. */
    mark(id: number, status: ProcessStatus, o?: { error?: string | null; attempts?: number; nextAttemptAt?: Date | null; claimToken?: string }): Promise<boolean>;
    touch(id: number, now: Date, claimToken?: string): Promise<boolean>;
    lastReceivedAt(): Promise<Date | null>;
    findByPayment(asaasPaymentId: string, eventType: string): Promise<StoredAsaasEvent | null>;
    reset(id: number): Promise<void>;
    /** Volta para `pending` SÓ se estiver em `error` (zera attempts/next_attempt_at/claim_token).
     *  `false` = não estava em erro, então nada foi mexido. */
    requeueFromError(id: number): Promise<boolean>;
    purgeProcessedOlderThan(days: number): Promise<number>;
  };
  odooEvents: {
    /** `null` = já existe notificação PENDENTE para a mesma fatura (índice parcial unique da 0008):
     *  o Odoo dispara por gravação, não por transição, e repetir o mesmo trabalho é desperdício. */
    insert(e: { odooModel: string; odooId: number; odooAction: string | null; payload: unknown; status?: ProcessStatus }): Promise<number | null>;
    pending(limit: number, now: Date): Promise<StoredOdooEvent[]>;
    /** `false` = a reserva foi perdida: NÃO sobrescreveu o resultado de quem assumiu. */
    mark(id: number, status: ProcessStatus, o?: { error?: string | null; attempts?: number; nextAttemptAt?: Date | null; claimToken?: string }): Promise<boolean>;
    touch(id: number, now: Date, claimToken?: string): Promise<boolean>;
    reset(id: number): Promise<void>;
    requeueFromError(id: number): Promise<boolean>;
    purgeProcessedOlderThan(days: number): Promise<number>;
  };
  reconciliations: {
    insert(r: {
      chargeId: number; odooPaymentId: number | null; amountReceived: Money; amountExpected: Money;
      netValue: Money | null; diffPolicy: DiffPolicy | null; paymentDate: string | null; creditDate: string | null;
    }): Promise<void>;
    existsForCharge(chargeId: number): Promise<boolean>;
  };
  exceptions: {
    open(e: { type: ExceptionType; refTable?: string; refId?: number; detail?: unknown }): Promise<void>;
    /** Dedupe de MELHOR ESFORÇO: evita a enxurrada de exceções iguais que uma varredura repetida
     *  criaria. NÃO é exclusão entre processos — é `insert ... where not exists`, que no READ
     *  COMMITTED não pega lock de predicado, então dois workers no mesmo instante podem abrir as
     *  duas (é a mesma armadilha documentada em `alerts.reservar`, que precisou de advisory lock).
     *  Aqui o custo de duas linhas é ruído no console, não dinheiro, então a trava não se paga.
     *  Devolve o id da exceção ABERTA, criada agora (`nova: true`) ou a que já existia: o alerta
     *  por e-mail precisa do id para linkar o console em qualquer um dos dois casos. */
    openOnce(e: { type: ExceptionType; refTable?: string; refId?: number; detail?: unknown }): Promise<{ id: number; nova: boolean }>;
    hasOpen(type: ExceptionType, refTable?: string, refId?: number): Promise<boolean>;
    countOpenByType(): Promise<Record<string, number>>;
    get(id: number): Promise<{ id: number; type: ExceptionType; status: "open" | "resolved" | "ignored"; refTable: string | null; refId: number | null; detail: unknown } | null>;
    setStatus(id: number, status: "open" | "resolved" | "ignored", by: string | null): Promise<void>;
    /** Fecha as exceções ABERTAS de um `refTable`, marcando quem resolveu. Serve para condição que
     *  o motor sabe que passou — um job que voltou a rodar com sucesso. Devolve quantas fechou. */
    resolverPorRef(refTable: string, by: string): Promise<number>;
    /** A exceção ABERTA mais antiga entre `types` criada ANTES de `limite`, com o total do grupo.
     *  O corte vem do chamador (o clock do motor), nunca do `now()` do Postgres: o mundo de teste
     *  usa relógio fixo, e misturar os dois é o erro que já quebrou quatro testes deste repo. */
    oldestOpen(types: ExceptionType[], limite: Date): Promise<{ id: number; type: ExceptionType; criadaEm: Date; total: number } | null>;
    /** Exceções ABERTAS do tipo que apontam para um evento — o alvo do reenfileiramento em lote. */
    listOpenWithEvent(type: ExceptionType): Promise<Array<{ id: number; refTable: "webhook_events" | "odoo_events"; refId: number }>>;
  };
  watermarks: {
    get(key: string): Promise<{ writeDate: string; id: number } | null>;
    set(key: string, w: { writeDate: string; id: number }): Promise<void>;
  };
  alerts: {
    /** Reserva a janela de silêncio: devolve o id quando ESTE processo ganhou o direito de
     *  avisar, e null quando alguém já avisou dentro da janela. A exclusão entre processos é
     *  garantida por advisory lock por chave, não pelo `where not exists` — ver o comentário
     *  em `alerts.reservar` (src/adapters/db/repo.ts), que explica por que a diferença importa. */
    reservar(a: { alertKey: string; channel: string; recipients: string; janelaMinutos: number }): Promise<number | null>;
    /** Fecha a linha reservada com o resultado do envio. */
    registrar(id: number, r: { ok: boolean; error?: string | null }): Promise<void>;
    /** Só para teste: o que foi mandado, mais recente primeiro. Nenhuma tela lê isto ainda. */
    recentes(limit?: number): Promise<Array<{ id: number; alertKey: string; sentAt: Date; ok: boolean; error: string | null; recipients: string }>>;
  };
  audit: {
    log(e: {
      direction: AuditDirection; endpoint: string; requestSummary?: unknown;
      responseStatus?: number; responseSummary?: unknown; durationMs?: number;
    }): Promise<void>;
    purgeOlderThan(days: number): Promise<number>;
  };
}

export interface Clock {
  now(): Date;
  today(): string; // YYYY-MM-DD em America/Sao_Paulo
}

export type Logger = (msg: string, ctx?: Record<string, unknown>) => void;

/** Canal de alerta. O adaptador de verdade fala com o Resend; o no-op só loga; o fake guarda.
 *  Quem decide SE manda é o núcleo (janela de silêncio); aqui só se entrega. */
export interface Notifier {
  /** Nome do canal, gravado em `alerts_sent.channel` ("resend", "no-op", "fake"). */
  readonly canal: string;
  /** false = canal desligado por configuração (sem chave). O núcleo nem reserva janela. */
  readonly ativo: boolean;
  /** Para quem vai, já normalizado. Vazio = ninguém configurado. */
  readonly destinatarios: readonly string[];
  /** Entrega ou lança. Lançar não derruba job: quem chama grava ok=false e segue. */
  entregar(a: { assunto: string; corpo: string; link: string | null }): Promise<void>;
}

export interface Deps {
  repo: Repo;
  odoo: OdooClient;
  asaas: AsaasClient;
  clock: Clock;
  log: Logger;
  /** Ausente = ninguém é avisado (o motor funciona igual). */
  notify?: Notifier;
}

/** Devolver um evento à fila colidiu com outro JÁ pendente para a mesma fatura. Não é falha: é o
 *  índice parcial da 0008 dizendo que esse trabalho já está enfileirado. Quem chama decide (o
 *  worker marca `ignored`), e o núcleo não precisa conhecer nome de índice para isso. */
export class FilaJaTemPendente extends Error {}

/** Erro de borda que vale retry (5xx, timeout, rede, banco caindo). Adaptadores marcam; o núcleo só lê. */
export interface TransientError extends Error { transient: true }
const PG_TRANSIENT = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "08000", "08001", "08003", "08004", "08006", "40001", "40P01", "53300", "57P01", "57014"]);
export const isTransient = (e: unknown): e is TransientError => {
  if (typeof e !== "object" || e === null) return false;
  const x = e as { transient?: unknown; code?: unknown; message?: unknown };
  if (x.transient === true) return true;
  if (typeof x.code === "string" && PG_TRANSIENT.has(x.code)) return true;   // pg: conexão/serialização/timeout — retry, não exceção
  return typeof x.message === "string" && /timeout exceeded when trying to connect|Connection terminated|pool is draining/.test(x.message);
};
