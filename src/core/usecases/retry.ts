/** Backoff 1/5/15 min, máximo 5 tentativas; depois null = desiste (vira 'error' + exceção). */
export function backoff(attempts: number, now: Date): Date | null {
  if (attempts >= 5) return null;
  const minutes = [1, 5, 15, 15, 15][attempts - 1] ?? 15;
  return new Date(now.getTime() + minutes * 60_000);
}
