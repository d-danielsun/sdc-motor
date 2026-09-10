import pg from "pg";
// numeric(14,2) chega como string (tipo 1700) — é o que o núcleo quer. date (1082) também como string YYYY-MM-DD, sem fuso.
pg.types.setTypeParser(1082, (v) => v);
export const DEFAULT_DATABASE_URL = "postgres://motor:motor@localhost:55432/motor";
export function createPool(connectionString: string, o: { max?: number } = {}): pg.Pool {
  // Prazos: sem eles, um banco lento prende as conexões e o processo inteiro para (review 09/09).
  return new pg.Pool({ connectionString, max: o.max ?? 10, connectionTimeoutMillis: 5_000, query_timeout: 30_000, statement_timeout: 30_000, idleTimeoutMillis: 30_000 });
}
/** Pool só pra advisory locks: conexões ficam paradas segurando lock enquanto o núcleo fala com Odoo/Asaas. */
export const createLockPool = (connectionString: string) => createPool(connectionString, { max: 10 });
