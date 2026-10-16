import { dayBefore } from "./meta-arbol-seed";
import { MINUTES, PAGES, openedOnDay, seedOpenGoal } from "./metas-sin-final-seed";
import { monthStartOf, shift, TODAY } from "./sin-final-seed";
import { openedIn } from "./mes-siguiente-seed";
import { civilDateToDate } from "@/lib/zone";

import type { Db } from "./mes-siguiente-seed";
import type { Person } from "./fixtures";

// Seeds and readers of the specs of module 965 (RP-118). A helper file, not a spec. Every month is an offset from the day the server
// reads and every end is built from it, so a spec runs on any day (PULSAR_CLOCK included).

const ABBR = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
export const wordsOf = (day: string) => `${Number(day.slice(8, 10))} ${ABBR[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
export const weekday = (day: string) => civilDateToDate(day).getUTCDay();

// The Monday on or after the 2nd of the month `offset` away: its eve, a Sunday, is the last day and falls in that month.
export function horizonIn(offset: number): string {
  let day = shift(monthStartOf(offset), 1);
  while (weekday(day) !== 1) day = shift(day, 1);
  return day;
}
export const lastDayIn = (offset: number) => dayBefore(horizonIn(offset));
export const lineWords = (count: number, offset: number) =>
  `${count} ${count === 1 ? "mes" : "meses"} más, hasta el ${wordsOf(lastDayIn(offset))}`;

// «2 de 120 meses», but never the «meses más» of the line.
export const ofRe = (shown: number, total: number) => new RegExp(`(?<!\\d)${shown} de ${total} meses(?! más)`);
export const aloneRe = (count: number) => new RegExp(`(?<!\\d)(?<!de )${count} meses(?! más)`);
export const anyOfRe = /\d+ de \d+ meses/;

// V1/V2/V3: «Leer», pages, 40 a month, opened 23 months back, an end `endsIn` months ahead.
export function seedLeer(db: Db, person: Person, o: { endsIn: number | null; name?: string; rhythm?: number | null; opened?: number }) {
  return seedOpenGoal(db, person, {
    name: o.name ?? "Leer",
    unit: PAGES,
    horizon: o.endsIn === null ? null : horizonIn(o.endsIn),
    rhythm: o.rhythm === undefined ? 40 : o.rhythm,
    created: openedIn(o.opened ?? -23),
  });
}

// N1: «Piano», opened this month, ends 120 months on (the 520 weeks of the board), 600 minutes a month.
export function seedPiano(db: Db, person: Person) {
  return seedOpenGoal(db, person, { name: "Piano", unit: MINUTES, horizon: horizonIn(119), rhythm: 600, created: openedOnDay(1).at });
}

// N4: no unit, an end 14 months ahead (15 months), one task next month.
export async function seedMudanza(db: Db, person: Person) {
  const id = await seedOpenGoal(db, person, { name: "Mudanza", unit: null, horizon: horizonIn(14), rhythm: null, created: openedOnDay(1).at });
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${id}, ${"Empacar"}, ${monthStartOf(1)}::date)`;
  return id;
}

// N5: ended, 20 months; the last month is this one when the last day falls in it, the one before otherwise.
export async function seedTerminada(db: Db, person: Person, months = 20, name = "Pintar") {
  let horizon = TODAY;
  while (weekday(horizon) !== 1) horizon = shift(horizon, -1);
  const last = dayBefore(horizon).slice(0, 7) === monthStartOf(0).slice(0, 7) ? 0 : -1;
  const id = await seedOpenGoal(db, person, { name, unit: PAGES, horizon, rhythm: 40, created: openedIn(last - (months - 1)) });
  return { id, last };
}
