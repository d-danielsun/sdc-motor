import type { Clock } from "../core/ports.js";
export const systemClock: Clock = {
  now: () => new Date(),
  today: () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()),
};
export const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso), today: () => iso.slice(0, 10) });
