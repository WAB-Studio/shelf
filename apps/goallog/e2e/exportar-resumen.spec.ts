import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `ExportarResumen` (approved 2026-10-13): `/exportar` opens with a summary, one line per open goal in the tree's order —
// name, this month's figure, this week's — then «EL DETALLE DE CADA META», the annex, whole. On paper the summary is a table
// (Meta | month | Semana del …) with «—» where a goal has no amount and nothing done; the annex follows on the same sheet.
const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const startOf = (offset: number) => {
  const date = civilDateToDate(`${todayInZone().slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateToCivilDate(date);
};
const month = MONTHS[Number(startOf(0).slice(5, 7)) - 1];

type Tree = { general: string; big: string; small: string; empty: string; loose: string; archived: string };

// General G (position 10) > large g1 (30) > small p (40, 20 h this month, 1 h 30 min done today), G > g2 (50, no amount);
// a loose goal L (20, no amount); an archived goal. Flat order by position is G, L, g1, p, g2: the tree's is G, g1, p, g2, L.
async function seedTree(db: postgres.Sql, person: Person): Promise<Tree> {
  const stamp = Date.now();
  const names: Tree = {
    general: `Rojo ${stamp}`,
    big: `Alfa ${stamp}`,
    small: `Pico ${stamp}`,
    empty: `Gama ${stamp}`,
    loose: `Suelta ${stamp}`,
    archived: `Archivada ${stamp}`,
  };
  const created = `${startOf(0)}T12:00:00Z`;
  const goal = async (name: string, position: number, parent: string | null, archived = false) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, parent_id, position, created_at, archived_at)
      values (${person.id}, ${name}, ${startOf(12)}::date, 'minutos', 'minutos', ${parent}, ${position},
              ${created}::timestamptz, ${archived ? created : null}::timestamptz)
      returning id
    `;
    return row.id;
  };
  const general = await goal(names.general, 10, null);
  await goal(names.loose, 20, null);
  const big = await goal(names.big, 30, general);
  const small = await goal(names.small, 40, big);
  await goal(names.empty, 50, general);
  await goal(names.archived, 60, null, true);
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${small}, ${startOf(0)}::date, 1200)
  `;
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${small}, ${`Hecha ${stamp}`}, ${startOf(0)}::date, 90)
    returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${small}, ${task.id}, ${todayInZone()}::date)
  `;
  // Hours come from blocks alone (RP-128): the task's 90 minutes are a block of their own.
  const [block] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
    values (${person.id}, ${small}, ${`Bloque ${stamp}`}, 'daily', 'quantity', 10, 'minutos') returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${person.id}, ${small}, ${block.id}, ${todayInZone()}::date, 90)
  `;
  return names;
}

const clear = (db: postgres.Sql, person: Person) => db`delete from goals.goals where user_id = ${person.id}`;

async function open(browser: Browser, baseURL: string, person: Person, width: number, media: "screen" | "print", first: string) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL,
    viewport: { width, height: media === "print" ? 1123 : 900 },
  });
  const page = await context.newPage();
  await page.emulateMedia({ media });
  await page.goto("/exportar");
  await expect(page.getByRole("main").getByText(first, { exact: true }).first()).toBeVisible();
  return { context, page };
}

const flat = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

// The two labels of the page, by the words the board draws.
const SUMMARY = "resumen";
const ANNEX = "el detalle de cada meta";

// The summary's text and the annex's, cut at the annex's label; what is drawn, never the markup.
async function split(page: Page): Promise<{ summary: string; annex: string }> {
  return page.evaluate(
    ([summaryLabel, annexLabel]) => {
      const leaf = (label: string) =>
        [...document.querySelectorAll("main *")].find(
          (el) => el.children.length === 0 && el.textContent?.trim().toLowerCase() === label,
        );
      const a = leaf(summaryLabel);
      const b = leaf(annexLabel);
      if (!a) throw new Error("no «RESUMEN» label");
      if (!b) throw new Error("no «EL DETALLE DE CADA META» label");
      const main = document.querySelector("main")!;
      const text = main.innerText;
      const at = text.toLowerCase().indexOf(summaryLabel);
      const cut = text.toLowerCase().indexOf(annexLabel);
      return { summary: text.slice(at, cut), annex: text.slice(cut) };
    },
    [SUMMARY, ANNEX],
  );
}

// The summary's text from one goal's name to the next.
function chunks(summary: string, names: string[]): string[] {
  const text = flat(summary);
  const at = names.map((name) => text.indexOf(name.toLowerCase()));
  expect(at.every((i) => i >= 0), `every open goal is in the summary: ${JSON.stringify(at)}`).toBe(true);
  expect([...at].sort((x, y) => x - y), "tree order: G, g1, p, g2, L").toEqual(at);
  return at.map((from, i) => text.slice(from, i + 1 < at.length ? at[i + 1] : undefined));
}

for (const width of [360, 1280]) {
  test(`at ${width} page one is the summary: every open goal once, in the tree's order, with its month and its week; the annex follows whole`, async ({
    person, browser, baseURL, db,
  }) => {
    const n = await seedTree(db, person);
    const { context, page } = await open(browser, baseURL!, person, width, "screen", n.general);
    try {
      const { summary, annex } = await split(page);
      const order = [n.general, n.big, n.small, n.empty, n.loose];
      const [g, big, small, empty, loose] = chunks(summary, order);
      for (const name of order) {
        expect(flat(summary).split(name.toLowerCase()).length - 1, `${name} once in the summary`).toBe(1);
      }
      expect(flat(summary), "an archived goal is not open").not.toContain(n.archived.toLowerCase());

      // The holder and the goals above the small one carry its sum.
      for (const row of [g, big, small]) {
        expect(row).toContain(`${month} 1 h 30 min de 20 h`);
        expect(row).toMatch(/semana 1 h 30 min/);
      }
      for (const row of [empty, loose]) {
        expect(row, "nothing planned this month").toContain("sin monto este mes");
        expect(row).not.toContain("semana");
        expect(row).not.toContain(`${month} `);
      }

      // The detail is whole: each goal's card, its month and its to-date, and the count of what a general holds.
      const text = flat(annex);
      for (const name of order) expect(text, `${name} in the annex`).toContain(name.toLowerCase());
      expect(text).toContain(`este mes · ${month}`);
      expect(text).toContain("hasta hoy");
      expect(text).toContain("metas dentro · 3");
    } finally {
      await context.close();
      await clear(db, person);
    }
  });
}

test("on screen the summary's names come before the annex's headings in the page, the labels in that order", async ({
  person, browser, baseURL, db,
}) => {
  const n = await seedTree(db, person);
  const { context, page } = await open(browser, baseURL!, person, 360, "screen", n.general);
  try {
    const order = await page.evaluate(
      ([summaryLabel, annexLabel, name]) => {
        const leaves = (text: string) =>
          [...document.querySelectorAll("main *")].filter(
            (el) => el.children.length === 0 && el.textContent?.trim().toLowerCase() === text.toLowerCase(),
          );
        const a = leaves(summaryLabel)[0];
        const b = leaves(annexLabel)[0];
        const named = leaves(name);
        const before = (x: Element, y: Element) => !!(x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING);
        return {
          labels: !!a && !!b && before(a, b),
          firstAfterSummary: !!a && named.length > 0 && before(a, named[0]),
          firstBeforeAnnex: !!b && named.length > 0 && before(named[0], b),
          lastAfterAnnex: !!b && named.length > 1 && before(b, named[named.length - 1]),
          count: named.length,
        };
      },
      [SUMMARY, ANNEX, n.general],
    );
    expect(order.labels, "RESUMEN comes before EL DETALLE DE CADA META").toBe(true);
    expect(order.firstAfterSummary, "the general's line follows «RESUMEN»").toBe(true);
    expect(order.firstBeforeAnnex, "the general's line comes before the annex").toBe(true);
    expect(order.lastAfterAnnex, "the general's own card is in the annex").toBe(true);
  } finally {
    await context.close();
    await clear(db, person);
  }
});

test("on paper the summary is a table: Meta | month | Semana del…, a row per open goal in the tree's order, «—» where a goal has no amount", async ({
  person, browser, baseURL, db,
}) => {
  const n = await seedTree(db, person);
  const { context, page } = await open(browser, baseURL!, person, 794, "print", n.general);
  try {
    const { summary } = await split(page);
    const text = flat(summary);
    const head = text.slice(0, text.indexOf(n.general.toLowerCase()));
    expect(head).toMatch(new RegExp(`meta ${month} semana del \\d`));
    // A week across two months names both; one inside a month names neither.
    const today = todayInZone();
    const monday = civilDateToDate(today);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const sunday = new Date(monday);
    sunday.setUTCDate(sunday.getUTCDate() + 6);
    const abbreviated = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    const [from, to] = [monday, sunday].map((date) => `${date.getUTCDate()} ${abbreviated[date.getUTCMonth()]}`);
    if (monday.getUTCMonth() === sunday.getUTCMonth()) {
      expect(head).toContain(`semana del ${monday.getUTCDate()} al ${sunday.getUTCDate()}`);
    } else {
      expect(head).toContain(`semana del ${from} al ${to} ${sunday.getUTCFullYear()}`);
    }
    const order = [n.general, n.big, n.small, n.empty, n.loose];
    const [g, big, small, empty, loose] = chunks(summary, order);
    for (const row of [g, big, small]) {
      expect(row).toContain("1 h 30 min de 20 h");
      expect(row, "a goal with an amount draws no dash").not.toContain("—");
    }
    for (const row of [empty, loose]) {
      expect(row, "a goal with nothing reads «—»").toContain("—");
      expect(row).not.toContain("min de");
    }
    expect(text).not.toContain(n.archived.toLowerCase());
  } finally {
    await context.close();
    await clear(db, person);
  }
});

test("on paper the annex follows the summary on its sheet: no break between them", async ({ person, browser, baseURL, db }) => {
  const n = await seedTree(db, person);
  const { context, page } = await open(browser, baseURL!, person, 794, "print", n.general);
  try {
    const breaks = await page.evaluate(
      ([annexLabel]) => {
        const label = [...document.querySelectorAll("main *")].find(
          (el) => el.children.length === 0 && el.textContent?.trim().toLowerCase() === annexLabel,
        );
        if (!label) throw new Error("no annex label");
        const found: boolean[] = [];
        for (let node: Element | null = label; node && node.tagName !== "MAIN"; node = node.parentElement) {
          const style = getComputedStyle(node);
          found.push(["page", "always", "left", "right"].includes(style.breakBefore) || style.pageBreakBefore === "always");
        }
        return found.some(Boolean);
      },
      [ANNEX],
    );
    expect(breaks, "the annex label opens no sheet of its own").toBe(false);
  } finally {
    await context.close();
    await clear(db, person);
  }
});

test("a goal with hours done and no amount for the month prints what was done, on screen and on paper; the week never waits on the month", async ({
  person, browser, baseURL, db,
}) => {
  const stamp = Date.now();
  const name = `Sin monto ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${name}, ${startOf(12)}::date, 'minutos', 'minutos', ${`${startOf(0)}T12:00:00Z`}::timestamptz)
    returning id
  `;
  const [block] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
    values (${person.id}, ${goal.id}, ${`Bloque ${stamp}`}, 'daily', 'quantity', 10, 'minutos') returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${person.id}, ${goal.id}, ${block.id}, ${todayInZone()}::date, 90)
  `;
  try {
    for (const media of ["screen", "print"] as const) {
      const { context, page } = await open(browser, baseURL!, person, media === "print" ? 794 : 1280, media, name);
      try {
        const { summary } = await split(page);
        const row = flat(summary).slice(flat(summary).indexOf(name.toLowerCase()));
        expect(row, `${media}: the month says what was done`).toContain("1 h 30 min");
        expect(row, `${media}: the week says what was done`).toContain("1 h 30 min");
        expect(row, `${media}: no dash for a goal with hours done`).not.toContain("—");
        expect(row).not.toContain("sin monto este mes");
      } finally {
        await context.close();
      }
    }
  } finally {
    await clear(db, person);
  }
});
