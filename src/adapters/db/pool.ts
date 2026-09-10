import pg from "pg";
// numeric(14,2) chega como string (tipo 1700) — é o que o núcleo quer. date (1082) também como string YYYY-MM-DD, sem fuso.
pg.types.setTypeParser(1082, (v) => v);
export const DEFAULT_DATABASE_URL = "postgres://motor:motor@localhost:55432/motor";
export function createPool(connectionString: string): pg.Pool {
  // Prazos: sem eles, um banco lento prende as 5 conexões e o processo inteiro para (review 09/09).
  return new pg.Pool({ connectionString, max: 5, connectionTimeoutMillis: 5_000, query_timeout: 30_000, statement_timeout: 30_000, idleTimeoutMillis: 30_000 });
}
