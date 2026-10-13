import { civilDateToDate } from "@/lib/zone";

import { shift } from "./sin-final-seed";

export const weeksWord = (counted: number) => (counted === 1 ? "semana" : "semanas");
export const figure = (met: number, counted: number) => `${met} de ${counted} ${weeksWord(counted)}`;

// A reference of the contract, written here from the rule and not from the code under test.
export function expectedMonths(created: string, retired: string | null, today: string, facts: Set<string>, n: number) {
  const months = new Map<string, { met: number; counted: number }>();
  const dow = (day: string) => (civilDateToDate(day).getUTCDay() + 6) % 7;
  for (let monday = shift(created, -dow(created)); monday <= today; monday = shift(monday, 7)) {
    const thursday = shift(monday, 3);
    const sunday = shift(monday, 6);
    if (thursday < created || (retired !== null && thursday > retired) || sunday >= today) continue;
    let done = 0;
    for (let d = 0; d < 7; d += 1) if (facts.has(shift(monday, d))) done += 1;
    const key = thursday.slice(0, 7);
    const row = months.get(key) ?? { met: 0, counted: 0 };
    row.counted += 1;
    if (done >= n) row.met += 1;
    months.set(key, row);
  }
  return months;
}

const WORD = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export const labelOf = (key: string) => `${WORD[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

