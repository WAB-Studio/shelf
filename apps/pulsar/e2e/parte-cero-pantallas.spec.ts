import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { todayInZone } from "@/lib/zone";

// RP-76 (module 844): on screen a share that rounds to 0 reads as a month with no planned
// amount, never «0 de 0»; paper keeps the 0; a budget the person typed as 0 keeps «de 0».
// Hoy is covered by `hoy-parte-cero.spec.ts`. What a month with no amount draws on each
// screen was read off a goal with neither rhythm nor budget; the zero share must read alike.
// Day-independent seeding: a rhythm of ceil(L / daysLeft) - 1 opened today plans a share
// of 0. On the 1st every rhythm of 1 or more plans at least a day, so those tests skip.

const today = todayInZone();
const month = today.slice(0, 7);
const length = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const daysLeft = length - Number(today.slice(8, 10)) + 1;
const zeroRhythm = Math.ceil(length / daysLeft) - 1;
const noZeroShare = zeroRhythm < 1;
const monthName = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`));

type Unit = { label: string; measure: string; token: string };
const UNITS: Unit[] = [
  { label: "distance", measure: "km", token: "km" },
  { label: "time", measure: "minutos", token: "min" },
];

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
// innerText applies text-transform, so «ESTE MES» and «PROBE ZERO» come back upper-cased.
async function textOf(page: Page, name: string): Promise<string> {
  await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
  return flat(await page.locator("body").innerText());
}

async function seedGoal(db: postgres.Sql, person: Person, name: string, unit: Unit, rhythm: number | null) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${person.id}, ${name}, '2099-12-31'::date, ${unit.measure}, ${unit.measure}, ${rhythm},
            ${`${today}T12:00:00Z`}::timestamptz)
    returning id`;
  return goal.id;
}

// One extractor per screen: the stretch of text that carries the current month's figure.
const NEXT_MONTH_ROW = String.raw`(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre) \d{4}`;
const segment = {
  metasRow(text: string, name: string) {
    const from = text.indexOf(name);
    expect(from, `«${name}» on /metas`).toBeGreaterThanOrEqual(0);
    const to = text.indexOf("hasta el", from);
    return text.slice(from + name.length, to + "hasta el".length).trim();
  },
  goalMonth(text: string) {
    const m = text.match(new RegExp(`en total, desde el \\d+ de \\w+ (.*?) ver por mes`, "i"));
    expect(m, `the month block on the goal page: ${text.slice(0, 400)}`).not.toBeNull();
    return m![1];
  },
  mesesCurrent(text: string) {
    const m = text.match(new RegExp(`en curso (.*?) ${NEXT_MONTH_ROW}`, "i"));
    expect(m, `the current row of Por mes: ${text.slice(0, 400)}`).not.toBeNull();
    return m![1];
  },
  monthPage(text: string) {
    const m = text.match(/este mes (.*?) tareas/i);
    expect(m, `«Este mes» on the month page: ${text.slice(0, 400)}`).not.toBeNull();
    return m![1];
  },
  exportMonth(text: string, name: string) {
    const from = text.toLowerCase().indexOf(name.toLowerCase());
    expect(from, `«${name}» on /exportar`).toBeGreaterThanOrEqual(0);
    const m = text.slice(from).match(new RegExp(`este mes · ${monthName} (.*?) hasta hoy`, "i"));
    expect(m, `«Este mes» block of the export: ${text.slice(from, from + 300)}`).not.toBeNull();
    return m![1];
  },
  exportRow(text: string, name: string) {
    const from = text.toLowerCase().indexOf(`${name.toLowerCase()} · por mes`);
    expect(from, `«${name} · por mes» on /exportar`).toBeGreaterThanOrEqual(0);
    const m = text.slice(from).match(new RegExp(`en curso (.*?) ${NEXT_MONTH_ROW}`, "i"));
    expect(m, `the current row of the export: ${text.slice(from, from + 300)}`).not.toBeNull();
    return m![1];
  },
  mes(text: string, name: string) {
    const from = text.indexOf(name);
    expect(from, `«${name}» on /mes`).toBeGreaterThanOrEqual(0);
    return text.slice(from + name.length, from + name.length + 120);
  },
};

const ZERO_OF_ZERO = /\b0(?:\s*\S+)?\s+de\s+0\b/;

async function open(browser: import("@playwright/test").Browser, baseURL: string | undefined, person: Person, path: string, name: string) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  const page = await context.newPage();
  await page.goto(path);
  return { page, text: await textOf(page, name), close: () => context.close() };
}

for (const unit of UNITS) {
  test.describe(`a share that rounds to 0, ${unit.label} goal`, () => {
    test.skip(noZeroShare, "the 1st: no rhythm of 1 or more has a share that rounds to 0");

    test(`/metas at 360 draws the row of a month with no amount, never «0 de 0»`, async ({ person, browser, baseURL, db }) => {
      const name = `Cero ${unit.token} ${Date.now()}`;
      const id = await seedGoal(db, person, name, unit, zeroRhythm);
      try {
        const view = await open(browser, baseURL, person, "/metas", name);
        try {
          const row = segment.metasRow(view.text, name);
          expect(row).not.toMatch(ZERO_OF_ZERO);
          // A month with no amount draws no figure on the row: only the goal's end remains.
          expect(row, row).not.toMatch(/\d/);
        } finally {
          await view.close();
        }
      } finally {
        await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
      }
    });

    test(`the goal page says «sin monto planeado» for the month, never «0 de 0»`, async ({ person, browser, baseURL, db }) => {
      const name = `Cero ${unit.token} ${Date.now()}`;
      const id = await seedGoal(db, person, name, unit, zeroRhythm);
      try {
        const view = await open(browser, baseURL, person, `/metas/${id}`, name);
        try {
          const block = segment.goalMonth(view.text);
          expect(block).not.toMatch(ZERO_OF_ZERO);
          expect(block).toMatch(/sin monto planeado/i);
        } finally {
          await view.close();
        }
      } finally {
        await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
      }
    });

    test(`«Por mes» draws the current row as «sin monto», never «0 de 0»`, async ({ person, browser, baseURL, db }) => {
      const name = `Cero ${unit.token} ${Date.now()}`;
      const id = await seedGoal(db, person, name, unit, zeroRhythm);
      try {
        const view = await open(browser, baseURL, person, `/metas/${id}/meses`, name);
        try {
          const row = segment.mesesCurrent(view.text);
          expect(row).not.toMatch(ZERO_OF_ZERO);
          expect(row).toMatch(/sin monto/i);
        } finally {
          await view.close();
        }
      } finally {
        await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
      }
    });

    test(`the month page's «Este mes» says «sin monto planeado», never «0 de 0»`, async ({ person, browser, baseURL, db }) => {
      const name = `Cero ${unit.token} ${Date.now()}`;
      const id = await seedGoal(db, person, name, unit, zeroRhythm);
      try {
        const view = await open(browser, baseURL, person, `/metas/${id}/meses/${month}`, name);
        try {
          const block = segment.monthPage(view.text);
          expect(block).not.toMatch(ZERO_OF_ZERO);
          expect(block).toMatch(/sin monto planeado/i);
        } finally {
          await view.close();
        }
      } finally {
        await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
      }
    });

    test(`/exportar on screen draws the reached figure alone, in «Este mes» and in the current row`, async ({ person, browser, baseURL, db }) => {
      const name = `Cero ${unit.token} ${Date.now()}`;
      const id = await seedGoal(db, person, name, unit, zeroRhythm);
      try {
        const view = await open(browser, baseURL, person, "/exportar", name);
        try {
          const block = segment.exportMonth(view.text, name);
          const row = segment.exportRow(view.text, name);
          for (const figure of [block, row]) {
            expect(figure).not.toMatch(ZERO_OF_ZERO);
            // The reached figure alone, as a goal with no amount draws it.
            expect(figure).toMatch(new RegExp(`^0 ${unit.token}$`));
          }
        } finally {
          await view.close();
        }
      } finally {
        await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
      }
    });

    test(`/mes draws the goal as a month with nothing planned, never «0 de 0»`, async ({ person, browser, baseURL, db }) => {
      const name = `Cero ${unit.token} ${Date.now()}`;
      const id = await seedGoal(db, person, name, unit, zeroRhythm);
      try {
        const view = await open(browser, baseURL, person, "/mes", name);
        try {
          const line = segment.mes(view.text, name);
          expect(line).not.toMatch(ZERO_OF_ZERO);
          expect(line).toMatch(/nada planeado todavía/i);
        } finally {
          await view.close();
        }
      } finally {
        await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
      }
    });

    test(`/exportar printed keeps the planned 0: «0 de 0»`, async ({ person, browser, baseURL, db }) => {
      const name = `Cero ${unit.token} ${Date.now()}`;
      const id = await seedGoal(db, person, name, unit, zeroRhythm);
      try {
        const view = await open(browser, baseURL, person, "/exportar", name);
        try {
          await view.page.emulateMedia({ media: "print" });
          const text = await textOf(view.page, name);
          expect(segment.exportMonth(text, name)).toMatch(ZERO_OF_ZERO);
          expect(segment.exportRow(text, name)).toMatch(ZERO_OF_ZERO);
        } finally {
          await view.close();
        }
      } finally {
        await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
      }
    });
  });

  test(`a month budget of 0 the person typed keeps «de 0» on every screen, ${unit.label} goal`, async ({ person, browser, baseURL, db }) => {
    const name = `Tecleado ${unit.token} ${Date.now()}`;
    // A rhythm with a share, so only the typed budget makes the planned amount 0.
    const id = await seedGoal(db, person, name, unit, length);
    await db`
      insert into goals.month_budgets (user_id, goal_id, month, amount)
      values (${person.id}, ${id}, ${`${month}-01`}::date, 0)`;
    try {
      const metas = await open(browser, baseURL, person, "/metas", name);
      try {
        expect(segment.metasRow(metas.text, name), "/metas").toMatch(ZERO_OF_ZERO);
      } finally {
        await metas.close();
      }
      const goal = await open(browser, baseURL, person, `/metas/${id}`, name);
      try {
        expect(segment.goalMonth(goal.text), "goal page").toMatch(ZERO_OF_ZERO);
      } finally {
        await goal.close();
      }
      const months = await open(browser, baseURL, person, `/metas/${id}/meses`, name);
      try {
        expect(segment.mesesCurrent(months.text), "Por mes").toMatch(ZERO_OF_ZERO);
      } finally {
        await months.close();
      }
      const page = await open(browser, baseURL, person, `/metas/${id}/meses/${month}`, name);
      try {
        expect(segment.monthPage(page.text), "month page").toMatch(ZERO_OF_ZERO);
      } finally {
        await page.close();
      }
      const report = await open(browser, baseURL, person, "/exportar", name);
      try {
        expect(segment.exportMonth(report.text, name), "/exportar").toMatch(ZERO_OF_ZERO);
        expect(segment.exportRow(report.text, name), "/exportar row").toMatch(ZERO_OF_ZERO);
      } finally {
        await report.close();
      }
    } finally {
      await db`delete from goals.goals where id = ${id} and user_id = ${person.id}`;
    }
  });
}
