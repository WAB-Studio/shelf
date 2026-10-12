import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `JerarquiaInforme` (RP-84, RP-80, RP-95): `/exportar` draws one card per general goal, with the goals inside it in the
// tree's order, their figures summed (RP-80), and each task naming the goal it comes from. A goal with nothing above or
// inside it stays the card it is today. Every month is an offset from the real current month.
const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const startOf = (offset: number) => {
  const date = civilDateToDate(`${todayInZone().slice(0, 7)}-01`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  return dateToCivilDate(date);
};
const nameOf = (offset: number) => MONTHS[Number(startOf(offset).slice(5, 7)) - 1];
// «31 de diciembre de 2026»: the day before a horizon.
const lastDay = (horizonOffset: number) => {
  const date = civilDateToDate(startOf(horizonOffset));
  date.setUTCDate(date.getUTCDate() - 1);
  return `${date.getUTCDate()} de ${MONTHS[date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
};

type Tree = {
  general: string;
  big1: string;
  small: string;
  big2: string;
  empty: string;
  loose: string;
  pendingSmall: string;
  pendingGeneral: string;
};

// G (minutes) > g1 > p, G > g2, G > g3 (no amount); a loose goal. Horizons in months from this one: G 12, g1 3, p 2, g2 9, g3 4.
// This month: p planned 20 h, reached 8 h 30; g2 planned 17 h, reached 4 h; so G is 12 h 30 min of 37 h.
// G keeps a stored month of 999 min of its own, which a holder never reads (RP-80).
async function seedTree(db: postgres.Sql, person: Person): Promise<Tree> {
  const stamp = Date.now();
  const names: Tree = {
    general: `Rojo ${stamp}`,
    big1: `Alfa ${stamp}`,
    small: `Pico ${stamp}`,
    big2: `Beta ${stamp}`,
    empty: `Gama ${stamp}`,
    loose: `Suelta ${stamp}`,
    pendingSmall: `Revisar cuaderno ${stamp}`,
    pendingGeneral: `Ordenar archivo ${stamp}`,
  };
  const created = `${startOf(0)}T12:00:00Z`;
  const goal = async (name: string, horizon: number, parent: string | null) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, parent_id, created_at)
      values (${person.id}, ${name}, ${startOf(horizon)}::date, 'minutos', 'minutos', ${parent}, ${created}::timestamptz)
      returning id
    `;
    return row.id;
  };
  const budget = (goalId: string, offset: number, amount: number) => db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goalId}, ${startOf(offset)}::date, ${amount})
  `;
  const task = async (goalId: string, name: string, estimate: number | null, done: boolean, offset = 0) => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
      values (${person.id}, ${goalId}, ${name}, ${startOf(offset)}::date, ${estimate})
      returning id
    `;
    if (done) {
      await db`
        insert into goals.facts (user_id, goal_id, one_off_id, day)
        values (${person.id}, ${goalId}, ${row.id}, ${todayInZone()}::date)
      `;
    }
  };

  const general = await goal(names.general, 12, null);
  await budget(general, 0, 999);
  const big1 = await goal(names.big1, 3, general);
  const small = await goal(names.small, 2, big1);
  const big2 = await goal(names.big2, 9, general);
  await goal(names.empty, 4, general);
  await goal(names.loose, 6, null);

  await budget(small, 0, 1200);
  await budget(small, 1, 600);
  await task(small, `Hecha pico ${stamp}`, 510, true);
  await task(small, names.pendingSmall, null, false);
  for (let offset = 0; offset < 9; offset++) await budget(big2, offset, 1020);
  await task(big2, `Hecha beta ${stamp}`, 240, true);
  await task(general, names.pendingGeneral, null, false);
  return names;
}

const clear = (db: postgres.Sql, person: Person) => db`delete from goals.goals where user_id = ${person.id}`;

async function open(browser: Browser, baseURL: string, person: Person, width: number, name: string) {
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL,
    viewport: { width, height: width < 700 ? 800 : 1000 },
  });
  const page = await context.newPage();
  await page.goto("/exportar");
  await expect(page.getByRole("main").getByText(name, { exact: true }).first()).toBeVisible();
  return { context, page };
}

// The card of one goal: the widest ancestor of its heading that does not also hold the other goal's heading.
async function card(page: Page, name: string, other: string): Promise<string> {
  return page.evaluate(
    ([mine, theirs]) => {
      const heading = (text: string) =>
        [...document.querySelectorAll("main h2")].find((h) => h.textContent?.trim() === text) ?? null;
      const a = heading(mine);
      const b = heading(theirs);
      if (!a || !b) throw new Error(`no heading for ${!a ? mine : theirs}`);
      let node: HTMLElement = a as HTMLElement;
      while (node.parentElement && !node.parentElement.contains(b)) node = node.parentElement;
      return node.innerText;
    },
    [name, other],
  );
}

const lines = (text: string) => text.toLowerCase().split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
const flat = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

test.describe("/exportar groups by general goal (RP-84)", () => {
  for (const width of [360, 1280]) {
    test(`the general's card holds G, g1, p, g2, g3 in the tree's order, and the loose goal is its own card at ${width}`, async ({
      person, browser, baseURL, db,
    }) => {
      const n = await seedTree(db, person);
      const { context, page } = await open(browser, baseURL!, person, width, n.general);
      try {
        const text = flat(await card(page, n.general, n.loose));
        const dentro = text.indexOf("metas dentro");
        expect(dentro, "«METAS DENTRO» in the general's card").toBeGreaterThanOrEqual(0);
        const at = [n.big1, n.small, n.big2, n.empty].map((name) => text.indexOf(name.toLowerCase(), dentro));
        expect(at.every((i) => i > dentro), `every goal inside is in the card: ${JSON.stringify(at)}`).toBe(true);
        expect([...at].sort((x, y) => x - y), "preorder: g1, p, g2, g3").toEqual(at);
        expect(text, "the loose goal is not inside the general's card").not.toContain(n.loose.toLowerCase());

        const loose = flat(await card(page, n.loose, n.general));
        expect(loose).not.toContain(n.general.toLowerCase());
        expect(loose).not.toContain("metas dentro");
      } finally {
        await context.close();
        await clear(db, person);
      }
    });
  }

  test("the rows name their month and end, omit the month part with no amount, and indent 20 px and 40 px", async ({
    person, browser, baseURL, db,
  }) => {
    const n = await seedTree(db, person);
    const { context, page } = await open(browser, baseURL!, person, 1280, n.general);
    try {
      const text = flat(await card(page, n.general, n.loose));
      const dentro = text.indexOf("metas dentro");
      expect(dentro, "«METAS DENTRO» in the general's card").toBeGreaterThanOrEqual(0);
      const rows = text.slice(dentro);
      expect(rows).toContain(
        `${n.big1.toLowerCase()} ${nameOf(0)} · 8 h 30 min de 20 h · hasta el ${lastDay(3)}`,
      );
      const emptyAt = rows.indexOf(n.empty.toLowerCase());
      const emptyEnd = rows.indexOf("tareas de ", emptyAt);
      const emptyRow = rows.slice(emptyAt, emptyEnd === -1 ? undefined : emptyEnd);
      expect(emptyRow).toContain(`hasta el ${lastDay(4)}`);
      expect(emptyRow, "no amount, so no month part").not.toContain(`${nameOf(0)} ·`);

      const left = (name: string, heading: boolean) =>
        page.evaluate(
          ([text, isHeading]) => {
            const found = [...document.querySelectorAll("main *")].find(
              (el) =>
                el.children.length === 0 &&
                el.textContent?.trim() === text &&
                (el.tagName === "H2") === isHeading,
            );
            if (!found) throw new Error(`no leaf for ${text}`);
            return found.getBoundingClientRect().left;
          },
          [name, heading] as const,
        );
      const root = await left(n.general, true);
      expect(Math.round((await left(n.big1, false)) - root), "large goal").toBeGreaterThanOrEqual(18);
      expect(Math.round((await left(n.big1, false)) - root)).toBeLessThanOrEqual(22);
      expect(Math.round((await left(n.small, false)) - root), "small goal").toBeGreaterThanOrEqual(38);
      expect(Math.round((await left(n.small, false)) - root)).toBeLessThanOrEqual(42);
      expect(Math.abs((await left(n.big2, false)) - (await left(n.big1, false))), "siblings align").toBeLessThanOrEqual(1);
    } finally {
      await context.close();
      await clear(db, person);
    }
  });

  test("the general's month is the sum of its goals: 12 h 30 min of 37 h, never its own stored month", async ({
    person, browser, baseURL, db,
  }) => {
    const n = await seedTree(db, person);
    const { context, page } = await open(browser, baseURL!, person, 1280, n.general);
    try {
      const text = flat(await card(page, n.general, n.loose));
      const from = text.indexOf(`este mes · ${nameOf(0)}`);
      expect(from, "«ESTE MES» in the general's card").toBeGreaterThanOrEqual(0);
      const section = text.slice(from, text.indexOf("hasta hoy", from));
      expect(section).toContain("12 h 30 min de 37 h");
      expect(text, "the sum sits in the card that holds the goals it sums").toContain("metas dentro · 4");
      expect(text, "the stored 999 min of the holder is never read").not.toContain("16 h 39 min");
      expect(text).toContain(`mide en horas y minutos · hasta el ${lastDay(12)}`);
    } finally {
      await context.close();
      await clear(db, person);
    }
  });

  test("a small goal's task names the small goal, not the general it hangs from", async ({
    person, browser, baseURL, db,
  }) => {
    const n = await seedTree(db, person);
    const { context, page } = await open(browser, baseURL!, person, 1280, n.general);
    try {
      const all = lines(await card(page, n.general, n.loose));
      const label = all.findIndex((l) => l.startsWith("tareas de "));
      expect(label, "«TAREAS DE …» in the general's card").toBeGreaterThanOrEqual(0);
      const at = all.findIndex((l, i) => i > label && l.includes(n.pendingSmall.toLowerCase()));
      expect(at, "the small goal's pending task is listed").toBeGreaterThan(label);
      const row = all.slice(at, at + 2).join(" ");
      expect(row).toContain(n.small.toLowerCase());
      expect(row).toContain("pendiente");
      const own = all.findIndex((l, i) => i > label && l.includes(n.pendingGeneral.toLowerCase()));
      expect(own, "the general's own task is listed").toBeGreaterThan(label);
      expect(all.slice(own, own + 2).join(" ")).toContain(n.general.toLowerCase());
    } finally {
      await context.close();
      await clear(db, person);
    }
  });

  test("the count reads «2 metas · una con 4 dentro»: the general and the loose goal are the two, the goals inside are counted apart", async ({
    person, browser, baseURL, db,
  }) => {
    const n = await seedTree(db, person);
    const { context, page } = await open(browser, baseURL!, person, 360, n.general);
    try {
      await expect(page.getByText("2 metas · una con 4 dentro", { exact: true })).toBeVisible();
      expect(flat(await card(page, n.general, n.loose))).toContain("metas dentro · 4");
      await expect(page.getByRole("button", { name: "Descargar PDF" }).or(page.getByText("Descargar PDF", { exact: true })).first()).toBeVisible();
    } finally {
      await context.close();
      await clear(db, person);
    }
  });

  test("no goals: today's empty screen, no count, no download, no goals inside", async ({ person, browser, baseURL, db }) => {
    await clear(db, person);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 360, height: 800 } });
    const page = await context.newPage();
    try {
      await page.goto("/exportar");
      await expect(page.getByText("No tienes metas abiertas. No hay nada que exportar.", { exact: true })).toBeVisible();
      await expect(page.getByText("Tu plan", { exact: true })).toBeVisible();
      await expect(page.getByText("Descargar PDF", { exact: true })).toHaveCount(0);
      await expect(page.getByText(/dentro/)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
