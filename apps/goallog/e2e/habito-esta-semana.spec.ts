import type { Page } from "@playwright/test";

import { test, expect } from "./fixtures";
import { expectedMonths, figure, labelOf } from "./habit-weeks";
import { between, mainLower, visit } from "./metas-sin-final-seed";
import { type Days, serverDays } from "./server-day";
import { seedFact, seedHabit, shift } from "./sin-final-seed";

// Module 940, RP-112: a weekly habit reads «{done} de {count} esta semana» for the week in progress, on its own
// screen and in «Mes»; a retired habit keeps the retirement week it had met and never reads «en curso» nor «esta
// semana». Board HabitoSemanaRetiro, E3–E6 of private/contrato-940.md, decisions of 2026-10-13 in docs/goallog/DESIGN.md.
// Written from the contract before the screens draw the line. What depends on today is computed from it (a Monday,
// a Sunday, the 1st of a month all read the same rule); the fixed examples use days already past.

test.use({ actionTimeout: 6000 });

const noonOf = (day: string) => new Date(`${day}T12:00:00-05:00`);
const MONTH_RE = /(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) \d{4}/g;
const NONE_YET = "aún sin semanas cerradas";

const path = (id: string) => `/metas/habitos/${id}`;
const monthsText = async (page: Page) => between(await mainLower(page), "por mes");
const rowsOf = (section: string) => section.match(MONTH_RE) ?? [];
const thisWeekOf = (done: number, count: number) => `${done} de ${count} esta semana`;

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
    for (const el of Array.from(document.querySelectorAll("main a[href], main button"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (Math.min(r.width, r.height) < 32) bad.push(`${(el.textContent ?? "").trim().slice(0, 30)} ${r.width}x${r.height}`);
      if (r.right > 360.5) bad.push(`${(el.textContent ?? "").trim().slice(0, 30)} right ${r.right}`);
    }
    return bad;
  });
}

// A Monday 8 weeks back, and the Mondays since: read from the server's day in `beforeEach`.
let D: Days;
test.beforeEach(async ({ browser, baseURL, person }) => {
  D = await serverDays(browser, baseURL, person);
});
const mondaysUntilNow = () => {
  const mondays: string[] = [];
  for (let monday = D.eightWeeksAgo; monday <= D.weekStart; monday = shift(monday, 7)) mondays.push(monday);
  return mondays;
};

// The «{met} de {counted} semanas» or «aún sin semanas cerradas» that `facts` give this month, by the reference of the rule.
function monthMiddle(created: string, facts: Set<string>, n: number): string {
  const found = expectedMonths(created, null, D.today, facts, n).get(D.today.slice(0, 7));
  return found && found.counted > 0 ? figure(found.met, found.counted) : NONE_YET;
}

test.describe("a weekly habit's week in progress (RP-112)", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  test("E3, screen: the month in progress reads «en curso», its closed weeks and below them «1 de 1 esta semana»; no other month says «esta semana»", async ({ person, browser, baseURL, db }) => {
    // Kills: the week in progress drawn on every month; not drawn; drawn above the closed weeks; «esta semana: 1».
    const id = await seedHabit(db, person.id, "Llamar a mamá", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf(D.eightWeeksAgo) });
    const facts = new Set(mondaysUntilNow());
    for (const day of facts) await seedFact(db, person.id, id, null, day);
    const { page, context } = await visit(browser, baseURL, person, path(id), 360);
    try {
      const section = await monthsText(page);
      const current = rowText(section, labelOf(D.today.slice(0, 7)));
      expect(current).toContain("en curso");
      expect(current).toContain(thisWeekOf(1, 1));
      expect(current).toContain(monthMiddle(D.eightWeeksAgo, facts, 1));
      expect(current.indexOf(thisWeekOf(1, 1))).toBeGreaterThan(current.indexOf(monthMiddle(D.eightWeeksAgo, facts, 1)));
      expect(section.split("esta semana").length - 1).toBe(1);
      expect(section).not.toContain("esta semana:");
      expect(rowsOf(section).at(-1)).toBe(labelOf(D.today.slice(0, 7)));
      expect(await fits360(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("E3 with nothing done this week: «0 de 1 esta semana» is said, not hidden", async ({ person, browser, baseURL, db }) => {
    // Kills: hiding the line when the count is 0.
    const id = await seedHabit(db, person.id, "Llamar a mamá", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf(D.eightWeeksAgo) });
    const facts = new Set(mondaysUntilNow().filter((day) => day < D.weekStart));
    for (const day of facts) await seedFact(db, person.id, id, null, day);
    const { page, context } = await visit(browser, baseURL, person, path(id), 360);
    try {
      const current = rowText(await monthsText(page), labelOf(D.today.slice(0, 7)));
      expect(current).toContain(thisWeekOf(0, 1));
      expect(current).toContain("en curso");
    } finally {
      await context.close();
    }
  });

  test("E3 and E6, «Mes»: «1 vez por semana · {closed weeks} · 1 de 1 esta semana»; the name links to the habit and comes back to /mes; 360 fits", async ({ person, browser, baseURL, db }) => {
    // Kills: reading `daysDone` for the weekly line; the week in progress left out of «Mes»; the name drawn as plain text; a line past 360. Run under PULSAR_CLOCK=2026-11-01 (E6): the Monday's fact of the month before is the week in progress,
    // so it reads «aún sin semanas cerradas · 1 de 1 esta semana»; kills a facts window that starts at the 1st.
    const id = await seedHabit(db, person.id, "Llamar a mamá", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf(D.eightWeeksAgo) });
    const facts = new Set(mondaysUntilNow());
    for (const day of facts) await seedFact(db, person.id, id, null, day);
    const { page, context } = await visit(browser, baseURL, person, "/mes", 360);
    try {
      const text = await mainLower(page);
      expect(text).toContain(`llamar a mamá 1 vez por semana · ${monthMiddle(D.eightWeeksAgo, facts, 1)} · ${thisWeekOf(1, 1)}`);
      await expect(page.locator("main").getByRole("link", { name: "Llamar a mamá", exact: true })).toHaveAttribute("href", `/metas/habitos/${id}?volver=/mes`);
      expect(await fits360(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("E4, created today (b20): the screen and «Mes» say «aún sin semanas cerradas» and the week in progress, never «0 de 0 semanas»", async ({ person, browser, baseURL, db }) => {
    // Kills: `habit.weeks.counted === 0` turned into `=== -1` (b20: «0 de 0 semanas»); the `noWeeks` branch inverted; the week in
    // progress left out when no week has closed.
    const swim = await seedHabit(db, person.id, "Nadar", { kind: "times_per_week", n: 2 }, { kind: "tap" }, { created: noonOf(D.today) });
    const rest = await seedHabit(db, person.id, "Descansar", { kind: "times_per_week", n: 2 }, { kind: "tap" }, { created: noonOf(D.today) });
    await seedFact(db, person.id, swim, null, D.today);
    const own = await visit(browser, baseURL, person, path(swim), 360);
    try {
      const section = await monthsText(own.page);
      expect(rowsOf(section)).toHaveLength(1);
      expect(section).toContain("en curso");
      expect(section).toContain(NONE_YET);
      expect(section).toContain(thisWeekOf(1, 2));
      expect(section).not.toMatch(/\d+ de \d+ semanas?/);
    } finally {
      await own.context.close();
    }
    const restScreen = await visit(browser, baseURL, person, path(rest), 360);
    try {
      const section = await monthsText(restScreen.page);
      expect(section).toContain(NONE_YET);
      expect(section).toContain(thisWeekOf(0, 2));
    } finally {
      await restScreen.context.close();
    }
    const mes = await visit(browser, baseURL, person, "/mes", 360);
    try {
      const text = await mainLower(mes.page);
      expect(text).toContain(`nadar 2 veces por semana · ${NONE_YET} · ${thisWeekOf(1, 2)}`);
      expect(text).toContain(`descansar 2 veces por semana · ${NONE_YET} · ${thisWeekOf(0, 2)}`);
      expect(text).not.toMatch(/\b0 de 0\b/);
      expect(await fits360(mes.page)).toEqual([]);
    } finally {
      await mes.context.close();
    }
  });

  test("the count is the week from Monday to today: the last days of the week before do not count, whatever day of the week it is", async ({ person, browser, baseURL, db }) => {
    // Kills: the Monday taken a day late (a Sunday's fact counted on Monday); the running week counted from today only; counting a week
    // ahead. Run under PULSAR_CLOCK on a Monday and on a Sunday: «2 de 2» the Sunday, «0 de 2» the Monday.
    const id = await seedHabit(db, person.id, "Ejercicio", { kind: "times_per_week", n: 2 }, { kind: "tap" }, { created: noonOf(shift(D.weekStart, -35)) });
    for (const day of [shift(D.weekStart, -2), shift(D.weekStart, -1)]) await seedFact(db, person.id, id, null, day);
    const mine = D.today === D.weekStart ? [] : [D.weekStart, D.today];
    for (const day of mine) await seedFact(db, person.id, id, null, day);
    const screen = await visit(browser, baseURL, person, path(id), 360);
    try {
      expect(rowText(await monthsText(screen.page), labelOf(D.today.slice(0, 7)))).toContain(thisWeekOf(mine.length, 2));
    } finally {
      await screen.context.close();
    }
    const mes = await visit(browser, baseURL, person, "/mes", 360);
    try {
      expect(await mainLower(mes.page)).toContain(`ejercicio 2 veces por semana · `);
      expect(await mainLower(mes.page)).toContain(` · ${thisWeekOf(mine.length, 2)}`);
    } finally {
      await mes.context.close();
    }
  });

  test("the day-counting cadences say nothing of this week, on their screen and in «Mes»", async ({ person, browser, baseURL, db }) => {
    // Kills: the week in progress computed for every cadence (a daily «12 de 13 días» followed by «esta semana»).
    const created = { created: noonOf(shift(D.today, -20)) };
    const daily = await seedHabit(db, person.id, "Meditar", { kind: "daily" }, { kind: "tap" }, created);
    const days = await seedHabit(db, person.id, "Estirar", { kind: "weekdays", days: [1, 3, 5] }, { kind: "tap" }, created);
    const [{ id: monthly }] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, created_at)
      values (${person.id}, null, 'Ir al cine', 'times_per_month', 3, 'tap', ${created.created}) returning id`;
    for (const id of [daily, days, monthly]) await seedFact(db, person.id, id, null, D.today);
    for (const id of [daily, days, monthly]) {
      const screen = await visit(browser, baseURL, person, path(id), 360);
      try {
        const section = await monthsText(screen.page);
        expect(section).toContain("en curso");
        expect(section).not.toContain("esta semana");
        expect(section).not.toContain("semana");
      } finally {
        await screen.context.close();
      }
    }
    const mes = await visit(browser, baseURL, person, "/mes", 360);
    try {
      const text = await mainLower(mes.page);
      expect(text).toContain("meditar todos los días");
      expect(text).toContain("ir al cine 3 veces al mes");
      expect(text).not.toContain("esta semana");
    } finally {
      await mes.context.close();
    }
  });
});

test.describe("a retired weekly habit (RP-112)", () => {
  test.use({ viewport: { width: 360, height: 900 } });

  test("E5, Yoga retired Wed 7 Oct 2026: agosto «2 de 2 semanas», septiembre «3 de 4», octubre «2 de 2» (the 5 Oct week met before retiring), no «en curso», no «esta semana»", async ({ person, browser, baseURL, db }) => {
    // Kills: the retirement week dropped; «en curso» drawn on the month of today for a retired
    // habit; the week in progress said of a retired habit; a row for a month after the retirement.
    const id = await seedHabit(db, person.id, "Yoga", { kind: "times_per_week", n: 2 }, { kind: "tap" }, { created: noonOf("2026-08-17"), retired: noonOf("2026-10-07") });
    for (const monday of ["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14"]) {
      await seedFact(db, person.id, id, null, monday);
      await seedFact(db, person.id, id, null, shift(monday, 1));
    }
    for (const day of ["2026-09-29", "2026-09-30", "2026-10-05", "2026-10-06"]) await seedFact(db, person.id, id, null, day);
    const { page, context } = await visit(browser, baseURL, person, path(id), 360);
    try {
      const text = await mainLower(page);
      expect(text).toContain("retirado el 7 oct 2026");
      const section = between(text, "por mes");
      expect(rowsOf(section)).toEqual(["agosto 2026", "septiembre 2026", "octubre 2026"]);
      expect(rowText(section, "agosto 2026")).toContain(figure(2, 2));
      expect(rowText(section, "septiembre 2026")).toContain(figure(3, 4));
      expect(rowText(section, "octubre 2026")).toContain(figure(2, 2));
      expect(section).not.toContain("en curso");
      expect(section).not.toContain("esta semana");
      expect(text).not.toContain(NONE_YET);
      await expect(page.getByRole("button", { name: "Retirarlo", exact: true })).toHaveCount(0);
      expect(await fits360(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("E5, the retirement week not met: only the 5 Oct done and retired Wed 7 Oct → octubre «1 de 1 semana»; retired Thu 8 Oct → «1 de 2 semanas»", async ({ person, browser, baseURL, db }) => {
    // Kills: counting every retirement week; never counting it; the Thursday rule of s3 lost.
    const early = await seedHabit(db, person.id, "Yoga miércoles", { kind: "times_per_week", n: 2 }, { kind: "tap" }, { created: noonOf("2026-09-14"), retired: noonOf("2026-10-07") });
    const late = await seedHabit(db, person.id, "Yoga jueves", { kind: "times_per_week", n: 2 }, { kind: "tap" }, { created: noonOf("2026-09-14"), retired: noonOf("2026-10-08") });
    for (const id of [early, late]) for (const day of ["2026-09-29", "2026-09-30", "2026-10-05"]) await seedFact(db, person.id, id, null, day);
    for (const [id, expected] of [[early, figure(1, 1)], [late, figure(1, 2)]] as const) {
      const { page, context } = await visit(browser, baseURL, person, path(id), 360);
      try {
        const section = await monthsText(page);
        expect(rowText(section, "octubre 2026")).toContain(expected);
        expect(section).not.toContain("en curso");
      } finally {
        await context.close();
      }
    }
  });

  test("E5c, retired Tue 29 Sep 2026 in a met week whose Thursday is 1 Oct: septiembre «4 de 4 semanas», no octubre row; without that fact «3 de 3 semanas»", async ({ person, browser, baseURL, db }) => {
    // Kills: the retirement week put in the month of its Thursday (octubre), leaving septiembre «3 de 3».
    const met = await seedHabit(db, person.id, "Retirado cumplido", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf("2026-09-07"), retired: noonOf("2026-09-29") });
    const unmet = await seedHabit(db, person.id, "Retirado sin cumplir", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf("2026-09-07"), retired: noonOf("2026-09-29") });
    for (const monday of ["2026-09-07", "2026-09-14", "2026-09-21"]) for (const id of [met, unmet]) await seedFact(db, person.id, id, null, monday);
    await seedFact(db, person.id, met, null, "2026-09-28");
    for (const [id, expected] of [[met, figure(4, 4)], [unmet, figure(3, 3)]] as const) {
      const { page, context } = await visit(browser, baseURL, person, path(id), 360);
      try {
        const section = await monthsText(page);
        expect(rowsOf(section)).toEqual(["septiembre 2026"]);
        expect(rowText(section, "septiembre 2026")).toContain(expected);
        expect(section).not.toContain("en curso");
      } finally {
        await context.close();
      }
    }
  });

  test("E5b, retired today after meeting this week: the month of today counts the week in progress whole, reads no «en curso» and no «esta semana» — screen and «Mes»", async ({ person, browser, baseURL, db }) => {
    // Kills: waiting for Sunday to count the retirement week; «en curso» on the last month of a retired habit; the week in progress said
    // of a retired habit in «Mes»; `thisWeek` not looking at the retirement.
    const id = await seedHabit(db, person.id, "Llamar retirado", { kind: "times_per_week", n: 1 }, { kind: "tap" }, { created: noonOf(D.eightWeeksAgo), retired: noonOf(D.today) });
    for (const day of mondaysUntilNow()) await seedFact(db, person.id, id, null, day);
    const month = D.today.slice(0, 7);
    const earlier = mondaysUntilNow().filter((monday) => monday < D.weekStart && shift(monday, 3).slice(0, 7) === month).length;
    const counted = earlier + 1;
    const screen = await visit(browser, baseURL, person, path(id), 360);
    try {
      const section = await monthsText(screen.page);
      expect(rowText(section, labelOf(month))).toContain(figure(counted, counted));
      expect(rowsOf(section).at(-1)).toBe(labelOf(month));
      expect(section).not.toContain("en curso");
      expect(section).not.toContain("esta semana");
    } finally {
      await screen.context.close();
    }
    const mes = await visit(browser, baseURL, person, "/mes", 360);
    try {
      const text = await mainLower(mes.page);
      expect(text).toContain(`llamar retirado 1 vez por semana · ${figure(counted, counted)}`);
      expect(text).not.toContain("esta semana");
    } finally {
      await mes.context.close();
    }
  });
});
