import { MAX_ATTEMPTS } from "../limits.js";
/** Backoff 1/5/15 min; a partir de MAX_ATTEMPTS devolve null = desiste (vira 'error' + exceção). */
export function backoff(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const minutes = [1, 5, 15, 15, 15][attempts - 1] ?? 15;
  return new Date(now.getTime() + minutes * 60_000);
}
