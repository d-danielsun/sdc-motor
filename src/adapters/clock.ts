import type { Clock } from "../core/ports.js";
const brt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
export const todayBrt = (d: Date): string => brt.format(d);
export const systemClock: Clock = { now: () => new Date(), today: () => todayBrt(new Date()) };
export const fixedClock = (iso: string): Clock => ({ now: () => new Date(iso), today: () => todayBrt(new Date(iso)) });
