import type { Page } from "@playwright/test";

import { civilDateToDate } from "@/lib/zone";

import { test, expect } from "./fixtures";
import { expectedMonths, figure, labelOf } from "./habit-weeks";
import { between, mainLower, visit } from "./metas-sin-final-seed";
import { TODAY, monthLabel, seedFact, seedHabit, shift } from "./sin-final-seed";

// Module 933, RP-109: a habit that counts by the week reads «3 de 4 semanas» on its screen and in «Mes».
// A week belongs to the month of its Thursday, is judged whole (lun a dom), is counted once it has ended, and the
// first and last week count when the habit lived that week's Thursday. Boards: HabitoSemanas (private/tableros-s3/
// NOTAS.md §5), E3 and E4 of private/contrato-933.md. Written from the contract before `weeks` reaches the screens.
// Fixed examples use days of 2025, which read the same any day; what depends on today is computed from it by a
// reference of the rule (`habit-weeks.ts`), never seeded with the answer.

test.use({ actionTimeout: 6000 });

const noonOf = (day: string) => new Date(`${day}T12:00:00-05:00`);
const MONTH_RE = /(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) \d{4}/g;
const NONE_YET = "aún sin semanas cerradas";

const path = (id: string, query = "") => `/metas/habitos/${id}${query}`;
const monthsText = async (page: Page) => between(await mainLower(page), "por mes");
const rowsOf = (section: string) => section.match(MONTH_RE) ?? [];

// The text of one month's row: from its label to the next label.
function rowText(section: string, label: string): string {
  const start = section.indexOf(label);
  if (start < 0) return "";
  const rest = section.slice(start + label.length);
  const next = rest.search(MONTH_RE);
  return label + (next < 0 ? rest : rest.slice(0, next));
}


async function fits360(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    if (document.documentElement.scrollWidth > 360) bad.push(`scrollWidth ${document.documentElement.scrollWidth}`);
    for (const el of Array.from(document.querySelectorAll('main a[href], main button'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (Math.min(r.width, r.height) < 32) bad.push(`${(el.textContent ?? "").trim().slice(0, 30)} ${r.width}x${r.height}`);
      if (r.right > 360.5) bad.push(`${(el.textContent ?? "").trim().slice(0, 30)} right ${r.right}`);
    }
    return bad;
  });
}

test.describe("the habit's screen, by the week (RP-109)", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  test("E3 in fixed days of 2025: julio «3 de 4 semanas», agosto «4 de 4», septiembre «3 de 4», octubre «1 de 5»", async ({ person, browser, baseURL, db }) => {
    // Kills: counting the week of 30 Jun (julio 5), not counting the week of 7 Jul, a week belonging to the month of its Monday
    // (the 29 Sep week in September), «N días» left in place.
    const id = await seedHabit(db, person.id, "Llamar a mamá", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf("2025-07-09") });
    for (const day of ["2025-07-09", "2025-07-16", "2025-07-23", "2025-08-06", "2025-08-13", "2025-08-20", "2025-08-27", "2025-09-03", "2025-09-10", "2025-09-17", "2025-10-08"]) {
      await seedFact(db, person.id, id, null, day);
    }
    const { page, context } = await visit(browser, baseURL, person, path(id, "?todo=1"), 360);
    try {
      const text = await mainLower(page);
      expect(text).toContain("1 vez por semana");
      const section = between(text, "por mes");
      expect(rowsOf(section).slice(0, 4)).toEqual(["julio 2025", "agosto 2025", "septiembre 2025", "octubre 2025"]);
      expect(rowText(section, "julio 2025")).toContain(figure(3, 4));
      expect(rowText(section, "agosto 2025")).toContain(figure(4, 4));
      expect(rowText(section, "septiembre 2025")).toContain(figure(3, 4));
      expect(rowText(section, "octubre 2025")).toContain(figure(1, 5));
      expect(section).not.toMatch(/\d+ días?/);
      expect(text).not.toContain("volver a pedirlo");
      expect(await fits360(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("created today: one row, «en curso», no figure and «aún sin semanas cerradas» (never «0 de 0 semanas»)", async ({ person, browser, baseURL, db }) => {
    // Kills: «0 de 0 semanas»; a figure on a month with nothing closed; a row missing for the month it was created in.
    const id = await seedHabit(db, person.id, "Llamar a mamá", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf(TODAY) });
    const { page, context } = await visit(browser, baseURL, person, path(id), 360);
    try {
      const section = await monthsText(page);
      expect(rowsOf(section)).toEqual([monthLabel(0)]);
      expect(section).toContain("en curso");
      expect(section).toContain(NONE_YET);
      expect(section).not.toMatch(/\d+ de \d+/);
      expect(section).not.toMatch(/\bsemanas?\b(?!s? cerradas)/);
      await expect(page.getByRole("button", { name: "Retirarlo", exact: true })).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("E4 in fixed days of 2025: septiembre «1 de 2 semanas», octubre «4 de 5 semanas»; the 30 Sep fact is the week of the 29th, October's", async ({ person, browser, baseURL, db }) => {
    // Kills: the month of a week taken from its Monday (septiembre 2 de 3) or its Sunday; a fact of 30 Sep counted in September.
    const id = await seedHabit(db, person.id, "Llamar a mamá", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf("2025-09-15") });
    for (const day of ["2025-09-16", "2025-09-30", "2025-10-08", "2025-10-15", "2025-10-29"]) await seedFact(db, person.id, id, null, day);
    const { page, context } = await visit(browser, baseURL, person, path(id, "?todo=1"), 360);
    try {
      const section = await monthsText(page);
      expect(rowText(section, "septiembre 2025")).toContain(figure(1, 2));
      expect(rowText(section, "octubre 2025")).toContain(figure(4, 5));
      expect(rowsOf(section)[0]).toBe("septiembre 2025");
    } finally {
      await context.close();
    }
  });

  test("a habit's first week counts when it lived that week's Thursday: created Wed 17 Sep 2025 yes, created Fri 19 Sep no", async ({ person, browser, baseURL, db }) => {
    // Kills: counting the creation week whatever the day; never counting it; judging the first week from the creation day on.
    const wed = await seedHabit(db, person.id, "Creado miércoles", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf("2025-09-17") });
    const fri = await seedHabit(db, person.id, "Creado viernes", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf("2025-09-19") });
    await seedFact(db, person.id, wed, null, "2025-09-18");
    await seedFact(db, person.id, fri, null, "2025-09-19");
    await seedFact(db, person.id, fri, null, "2025-09-23");
    for (const [id, expected] of [[wed, figure(1, 2)], [fri, figure(1, 1)]] as const) {
      const { page, context } = await visit(browser, baseURL, person, path(id, "?todo=1"), 360);
      try {
        expect(rowText(await monthsText(page), "septiembre 2025")).toContain(expected);
      } finally {
        await context.close();
      }
    }
  });

  test("a retired habit's last week counts when it lived that week's Thursday: retired Wed 22 Oct 2025 «3 de 3», retired Thu 23 Oct «4 de 4»", async ({ person, browser, baseURL, db }) => {
    // Kills: counting the retirement week whatever the day; dropping it always; a row for a month after the retirement.
    const early = await seedHabit(db, person.id, "Retirado miércoles", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf("2025-09-15"), retired: noonOf("2025-10-22") });
    const late = await seedHabit(db, person.id, "Retirado jueves", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf("2025-09-15"), retired: noonOf("2025-10-23") });
    for (const id of [early, late]) for (const day of ["2025-09-30", "2025-10-07", "2025-10-14", "2025-10-21"]) await seedFact(db, person.id, id, null, day);
    for (const [id, expected] of [[early, figure(3, 3)], [late, figure(4, 4)]] as const) {
      const { page, context } = await visit(browser, baseURL, person, path(id, "?todo=1"), 360);
      try {
        const section = await monthsText(page);
        expect(rowText(section, "octubre 2025")).toContain(expected);
        expect(rowsOf(section).at(-1)).toBe("octubre 2025");
      } finally {
        await context.close();
      }
    }
  });

  test("controls, September 2025: «12 de 30 días» daily, «5 de 13 días» on weekdays, «2 días» by the month: the days reading is untouched", async ({ person, browser, baseURL, db }) => {
    // Kills: weeks computed for every cadence (a daily habit reading «12 de 4 semanas»).
    const created = { created: noonOf("2025-09-01") };
    const daily = await seedHabit(db, person.id, "Meditar", { kind: "daily" }, { kind: "tap" }, created);
    const days = await seedHabit(db, person.id, "Estirar", { kind: "weekdays", days: [1, 3, 5] }, { kind: "tap" }, created);
    const [{ id: monthly }] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, created_at)
      values (${person.id}, null, 'Ir al cine', 'times_per_month', 3, 'tap', ${created.created}) returning id`;
    for (let d = 1; d <= 12; d += 1) await seedFact(db, person.id, daily, null, `2025-09-${String(d).padStart(2, "0")}`);
    for (const day of ["2025-09-01", "2025-09-03", "2025-09-05", "2025-09-08", "2025-09-10"]) await seedFact(db, person.id, days, null, day);
    for (const day of ["2025-09-03", "2025-09-10"]) await seedFact(db, person.id, monthly, null, day);
    for (const [id, expected] of [[daily, "12 de 30 días"], [days, "5 de 13 días"], [monthly, "2 días"]] as const) {
      const { page, context } = await visit(browser, baseURL, person, path(id, "?todo=1"), 360);
      try {
        const section = await monthsText(page);
        expect(rowText(section, "septiembre 2025")).toContain(expected);
        expect(section).not.toContain("semana");
      } finally {
        await context.close();
      }
    }
  });
});

for (const n of [1, 2]) {
  test(`every day of the week: a ${n}-per-week habit made two months ago reads the weeks of each month by their Thursday, the running week left out`, async ({ person, browser, baseURL, db }) => {
    // Kills: `sunday <= today` (a week counted on the day it ends), a week by its Monday, «≥ 1» for every N, an off-by-one
    // on the first week; it only bites on some days, so run it under PULSAR_CLOCK on a Sunday, a Monday and a Tuesday.
    let created = shift(TODAY, -84);
    while (((civilDateToDate(created).getUTCDay() + 6) % 7) !== 0 || Number(created.slice(8, 10)) < 8 || Number(created.slice(8, 10)) > 24) created = shift(created, 1);
    const id = await seedHabit(db, person.id, "Llamar a mamá", { kind: "times_per_week", n }, { kind: "tap" }, { created: noonOf(created) });
    const facts = new Set<string>();
    let index = 0;
    for (let monday = created; monday <= TODAY; monday = shift(monday, 7), index += 1) {
      for (let k = 0; k < index % 3; k += 1) {
        const day = shift(monday, 1 + k);
        if (day <= TODAY) facts.add(day);
      }
    }
    for (const day of facts) await seedFact(db, person.id, id, null, day);
    const expected = expectedMonths(created, null, TODAY, facts, n);
    const { page, context } = await visit(browser, baseURL, person, path(id), 360);
    try {
      const section = await monthsText(page);
      const first = created.slice(0, 7);
      const keys: string[] = [];
      for (let key = first; key <= TODAY.slice(0, 7); key = shift(`${key}-01`, 32).slice(0, 7)) keys.push(key);
      expect(rowsOf(section)).toEqual(keys.map(labelOf));
      for (const key of keys) {
        const row = rowText(section, labelOf(key));
        const found = expected.get(key) ?? { met: 0, counted: 0 };
        if (found.counted === 0) {
          expect(row, labelOf(key)).toContain(NONE_YET);
          expect(row).not.toMatch(/\d+ de \d+/);
        } else {
          expect(row, labelOf(key)).toContain(figure(found.met, found.counted));
          expect(row).not.toContain(NONE_YET);
        }
      }
      expect(rowText(section, labelOf(TODAY.slice(0, 7)))).toContain("en curso");
      expect(await fits360(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test.describe("«Mes», by the week (RP-109)", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  // «Mes» is always the current month, so the figure comes from the reference of the rule applied to today.
  test("a weekly habit reads «1 vez por semana · {met} de {counted} semanas» for this month's closed weeks, never days, and its name links", async ({ person, browser, baseURL, db }) => {
    // Kills: reading `daysDone` for a weekly habit («· 2 días»); the name drawn as plain text; counting the running week; «1 de 1 semanas».
    let created = shift(TODAY, -56);
    while (((civilDateToDate(created).getUTCDay() + 6) % 7) !== 0) created = shift(created, 1);
    const id = await seedHabit(db, person.id, "Llamar a mamá", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf(created) });
    const facts = new Set<string>();
    for (let monday = created, index = 0; monday <= TODAY; monday = shift(monday, 7), index += 1) {
      if (index % 3 === 0) continue;
      const day = shift(monday, 2);
      if (day <= TODAY) facts.add(day);
    }
    for (const day of facts) await seedFact(db, person.id, id, null, day);
    const month = expectedMonths(created, null, TODAY, facts, 1).get(TODAY.slice(0, 7));
    const { page, context } = await visit(browser, baseURL, person, "/mes", 360);
    try {
      const text = await mainLower(page);
      if (month && month.counted > 0) {
        expect(text).toContain(`llamar a mamá 1 vez por semana · ${figure(month.met, month.counted)}`);
      }
      expect(text).toContain("llamar a mamá 1 vez por semana");
      expect(text).not.toMatch(/1 vez por semana · \d+ días?/);
      expect(text).not.toContain("1 de 1 semanas");
      await expect(page.locator("main").getByRole("link", { name: "Llamar a mamá", exact: true })).toHaveAttribute("href", new RegExp(`/metas/habitos/${id}`));
      expect(await fits360(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("the day-counting cadences keep their line in «Mes»: «todos los días · N de M días», «3 veces al mes · N días»", async ({ person, browser, baseURL, db }) => {
    // Kills: weeks computed for every cadence.
    const dayOfMonth = Number(TODAY.slice(8, 10));
    const monthStart = `${TODAY.slice(0, 7)}-01`;
    const daily = await seedHabit(db, person.id, "Meditar", { kind: "daily" }, { kind: "tap" }, { created: noonOf(monthStart) });
    const [{ id: monthly }] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, created_at)
      values (${person.id}, null, 'Ir al cine', 'times_per_month', 3, 'tap', ${noonOf(monthStart)}) returning id`;
    const done = Math.min(dayOfMonth, 2);
    for (let d = 0; d < done; d += 1) {
      await seedFact(db, person.id, daily, null, shift(monthStart, d));
      await seedFact(db, person.id, monthly, null, shift(monthStart, d));
    }
    const { page, context } = await visit(browser, baseURL, person, "/mes", 360);
    try {
      const text = await mainLower(page);
      expect(text).toContain(`meditar todos los días · ${done} de ${dayOfMonth} ${dayOfMonth === 1 ? "día" : "días"}`);
      expect(text).toContain(`ir al cine 3 veces al mes · ${done} ${done === 1 ? "día" : "días"}`);
      expect(text).not.toContain("semana ·");
    } finally {
      await context.close();
    }
  });
});
