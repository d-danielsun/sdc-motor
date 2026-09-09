// Dinheiro como string decimal ("123.45") na borda e inteiro de centavos por dentro. Nunca float.
export type Money = string;

const RE = /^-?\d+(\.\d{1,2})?$/;

export function toCents(m: Money | number): number {
  const s = typeof m === "number" ? m.toFixed(2) : m.trim();
  if (!RE.test(s)) throw new Error(`valor monetário inválido: ${JSON.stringify(m)}`);
  const neg = s.startsWith("-");
  const [int = "0", frac = ""] = s.replace("-", "").split(".");
  return (neg ? -1 : 1) * (Number(int) * 100 + Number((frac + "00").slice(0, 2)));
}

export function fromCents(c: number): Money {
  const a = Math.abs(Math.round(c));
  return `${c < 0 ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

export const money = (m: Money | number): Money => fromCents(toCents(m));
export const add = (a: Money, b: Money): Money => fromCents(toCents(a) + toCents(b));
export const sub = (a: Money, b: Money): Money => fromCents(toCents(a) - toCents(b));
export const eq = (a: Money, b: Money): boolean => toCents(a) === toCents(b);
export const moneyOrNull = (m: Money | number | null | undefined): Money | null =>
  m === null || m === undefined ? null : money(m);
