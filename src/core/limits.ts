// Limites operacionais num lugar só (o README cita estes nomes).
export const ODOO_PAGE_SIZE = 200;            // faturas por página da varredura
export const SWEEP_MAX_PAGES = 25;            // 5.000 faturas por tick da varredura, no máximo
export const ASAAS_EVENT_BATCH = 20;          // eventos do Asaas por tick do worker
export const ODOO_EVENT_BATCH = 20;           // eventos do Odoo por tick do worker
export const MAX_ATTEMPTS = 5;                // retries de um evento antes de virar 'error'
export const AUDIT_RETENTION_DAYS = 90;
export const EVENT_RETENTION_DAYS = 90;       // done/ignored; 'error' fica até alguém resolver
export const API_KEY_WARN_DAYS = 75;          // key do Odoo vence em ≤90
export const STALE_HEARTBEAT_HOURS = 8;
export const RECONCILE_LOOKBACK_DAYS = 3;
export const RAW_PAYLOAD_MAX = 20_000;
export const MAX_MONEY_INT_DIGITS = 12;       // numeric(14,2)
export const TOLERANCE_MAX_BRL = "5.00";          // acima disso é política de write-off (Q3), não tolerância
export const SWEEP_FAILURES_BEFORE_SKIP = 3;      // fatura que o Odoo recusa (5xx) N ticks seguidos vira exceção e a varredura segue
export const OVERDUE_RECHECK_DAYS = 2;            // reconcile relê no Asaas cobranças abertas vencidas há mais de N dias
export const WIZARD_TIMEOUT_MS = 60_000;          // o wizard pode demorar; retry antes de o Odoo terminar duplicaria
export const ASAAS_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;  // pay_…, cus_…, evt_…, uuid do webhook
