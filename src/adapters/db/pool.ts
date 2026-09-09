import pg from "pg";
// numeric(14,2) chega como string (tipo 1700) — é o que o núcleo quer. date (1082) também como string YYYY-MM-DD, sem fuso.
pg.types.setTypeParser(1082, (v) => v);
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5 });
}
