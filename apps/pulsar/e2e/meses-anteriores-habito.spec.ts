import type { Browser, Locator, Page } from "@playwright/test";

import { dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";

import { test, expect, settled, visit, type Person } from "./fixtures";
import { seedOpenGoal } from "./metas-sin-final-seed";
import { monthStartOf, seedHabit, shift } from "./sin-final-seed";

// Module 974, RP-120 (boards MesesAnteriores 4, 5 and 6, approved 2026-10-14): a habit older than 12 months reads
// «12 de 21 meses» and, after the label and before the table, «9 meses anteriores» (a link to the whole list);
// «Por semana» of a goal with no end reads «134 semanas anteriores» the same way. Opened whole, short, or with an end,
// no line. Written from the contract. Dates relative to today. Every test names the mutation that kills it.

test.use({ actionTimeout: 6000 });

const noonOf = (day: string) => new Date(`${day}T12:00:00-05:00`);
const weeksAgo = (n: number) => noonOf(shift(weekOf(todayInZone())[0], -7 * n));

async function open(browser: Browser, baseURL: string | undefined, person: Person, path: string, width = 360) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  const page = await context.newPage();
  await visit(page, path);
  await settled(page);
  return { page, context };
}

const habitOf = (db: Parameters<typeof seedHabit>[0], person: Person, months: number) =>
  seedHabit(db, person.id, "Bañarse", { kind: "daily" }, { kind: "tap" }, { created: noonOf(monthStartOf(-(months - 1))) });
const noEnd = (db: Parameters<typeof seedOpenGoal>[0], person: Person, weeks: number) =>
  seedOpenGoal(db, person, { name: "Escribir", unit: { measure: "páginas", unit: "páginas" }, horizon: null, created: weeksAgo(weeks - 1) });

const habitPath = (id: string, query = "") => `/metas/habitos/${id}${query}`;
const weekPath = (id: string, query = "") => `/metas/${id}/revision${query}`;

const earlier = (page: Page) => page.getByRole("link", { name: /anteriores?$/ });
const seeAll = (page: Page) => page.getByRole("link", { name: "ver todo", exact: true });
const seeLess = (page: Page) => page.getByRole("link", { name: "ver menos", exact: true });
const rows = (page: Page) => page.locator("main ol > li:visible, main tbody tr:visible");
const text = (page: Page, s: string) => page.getByText(s, { exact: true }).locator("visible=true");

// The line sits after the label and before the first row, as the approved boards draw it.
async function expectBetween(page: Page, label: Locator, line: Locator) {
  const [l, k, first] = [await label.boundingBox(), await line.boundingBox(), await rows(page).first().boundingBox()];
  expect(k!.y).toBeGreaterThanOrEqual(l!.y + l!.height - 1);
  expect(k!.y + k!.height).toBeLessThanOrEqual(first!.y);
}

async function overflow(page: Page): Promise<string[]> {
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

test.describe("the habit's months, folded (RP-120, board MesesAnteriores 4)", () => {
  test("H1: 21 months read «12 de 21 meses», «9 meses anteriores» after the label and before the 12 rows, with «ver todo»", async ({ person, browser, baseURL, db }) => {
    // Kills: `habit.months.caption` fed `habit.months.length` («21 meses»); no line; the line below the table.
    const id = await habitOf(db, person, 21);
    const { page, context } = await open(browser, baseURL, person, habitPath(id));
    try {
      const label = text(page, "12 de 21 meses");
      await expect(label).toBeVisible();
      const line = page.getByRole("link", { name: "9 meses anteriores", exact: true });
      await expect(line).toHaveCount(1);
      await expect(rows(page)).toHaveCount(12);
      await expectBetween(page, label, line);
      await expect(seeAll(page)).toBeVisible();
      await expect(text(page, "21 meses")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("the line opens the whole list: 21 rows, «21 meses», no line, «ver menos» still there", async ({ person, browser, baseURL, db }) => {
    // Kills: a line to the wrong href; drawing the line with `all`; dropping «ver menos».
    const id = await habitOf(db, person, 21);
    const { page, context } = await open(browser, baseURL, person, habitPath(id));
    try {
      await page.getByRole("link", { name: "9 meses anteriores", exact: true }).click();
      await expect(page).toHaveURL(/todo=1/);
      await expect(rows(page)).toHaveCount(21);
      await expect(text(page, "21 meses")).toBeVisible();
      await expect(earlier(page)).toHaveCount(0);
      await expect(page.getByText(/de 21 meses/)).toHaveCount(0);
      await expect(seeAll(page)).toHaveCount(0);
      await expect(seeLess(page).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("opened whole (`?todo=1`) 21 months read «21 meses» over 21 rows, with no line and no «de N»", async ({ person, browser, baseURL, db }) => {
    // Kills: drawing the line or «de N» with `all`; folding the list in `?todo=1`.
    const id = await habitOf(db, person, 21);
    const { page, context } = await open(browser, baseURL, person, habitPath(id, "?todo=1"));
    try {
      await expect(text(page, "21 meses")).toBeVisible();
      await expect(rows(page)).toHaveCount(21);
      await expect(earlier(page)).toHaveCount(0);
      await expect(page.getByText(/ de \d+ meses/)).toHaveCount(0);
      await expect(seeAll(page)).toHaveCount(0);
      await expect(seeLess(page).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("from Mes the line keeps `volver=/mes` and adds `todo=1`", async ({ person, browser, baseURL, db }) => {
    // Kills: building the href by hand without `volver`.
    const id = await habitOf(db, person, 21);
    const { page, context } = await open(browser, baseURL, person, habitPath(id, "?volver=/mes"));
    try {
      const href = await page.getByRole("link", { name: "9 meses anteriores", exact: true }).getAttribute("href");
      const url = new URL(href!, "http://x");
      expect(url.pathname).toBe(habitPath(id));
      expect(url.searchParams.get("volver")).toBe("/mes");
      expect(url.searchParams.get("todo")).toBe("1");
    } finally {
      await context.close();
    }
  });

  test("13 months: «12 de 13 meses» and the singular «1 mes anterior»", async ({ person, browser, baseURL, db }) => {
    // Kills: a plural fixed in the line («1 meses anteriores»).
    const id = await habitOf(db, person, 13);
    const { page, context } = await open(browser, baseURL, person, habitPath(id));
    try {
      await expect(text(page, "12 de 13 meses")).toBeVisible();
      await expect(page.getByRole("link", { name: "1 mes anterior", exact: true })).toHaveCount(1);
    } finally {
      await context.close();
    }
  });

  test("12 months and 5 months fold nothing: «12 meses» / «5 meses», no line, no «ver todo», no «de N»", async ({ person, browser, baseURL, db }) => {
    // Kills: always drawing «de N»; drawing the line when nothing is hidden (`>=`, `> 0` read off the wrong count).
    for (const months of [12, 5]) {
      const id = await seedHabit(db, person.id, `Meditar ${months}`, { kind: "daily" }, { kind: "tap" }, { created: noonOf(monthStartOf(-(months - 1))) });
      const { page, context } = await open(browser, baseURL, person, habitPath(id));
      try {
        await expect(text(page, `${months} meses`)).toBeVisible();
        await expect(page.getByText(/ de \d+ meses/)).toHaveCount(0);
        await expect(earlier(page)).toHaveCount(0);
        await expect(seeAll(page)).toHaveCount(0);
        await expect(rows(page)).toHaveCount(months);
      } finally {
        await context.close();
      }
    }
  });

  test("at 360 the folded habit does not overflow and its line is a tap target", async ({ person, browser, baseURL, db }) => {
    // Kills: a line narrower than 32 px or wider than the screen; a class outside `components/ui`.
    const id = await habitOf(db, person, 21);
    const { page, context } = await open(browser, baseURL, person, habitPath(id));
    try {
      await expect(page.getByRole("link", { name: "9 meses anteriores", exact: true })).toBeVisible();
      expect(await overflow(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

test.describe("«Por semana» of a goal with no end, folded (RP-120, board MesesAnteriores 6)", () => {
  test("W1: 146 weeks read «134 semanas anteriores» before the 12 rows, linking to `?todo=1`", async ({ person, browser, baseURL, db }) => {
    // Kills: not drawing the line; a line below the table; an href without `todo=1`.
    const id = await noEnd(db, person, 146);
    const { page, context } = await open(browser, baseURL, person, weekPath(id));
    try {
      const line = page.getByRole("link", { name: "134 semanas anteriores", exact: true });
      await expect(line).toHaveCount(1);
      await expect(rows(page)).toHaveCount(12);
      await expect(line).toHaveAttribute("href", weekPath(id, "?todo=1"));
      await expectBetween(page, text(page, "por semana"), line);
      expect(await overflow(page)).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("the line opens all 146 weeks with no line, and «ver menos» is there", async ({ person, browser, baseURL, db }) => {
    // Kills: drawing the line with `all`; losing «ver menos».
    const id = await noEnd(db, person, 146);
    const { page, context } = await open(browser, baseURL, person, weekPath(id));
    try {
      await page.getByRole("link", { name: "134 semanas anteriores", exact: true }).click();
      await expect(rows(page)).toHaveCount(146);
      await expect(earlier(page)).toHaveCount(0);
      await expect(seeLess(page).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("13 weeks: the singular «1 semana anterior»; 12 weeks: no line", async ({ person, browser, baseURL, db }) => {
    // Kills: a fixed plural; the line drawn when nothing is hidden.
    const thirteen = await noEnd(db, person, 13);
    const a = await open(browser, baseURL, person, weekPath(thirteen));
    try {
      await expect(a.page.getByRole("link", { name: "1 semana anterior", exact: true })).toHaveCount(1);
    } finally {
      await a.context.close();
    }
    const twelve = await noEnd(db, person, 12);
    const b = await open(browser, baseURL, person, weekPath(twelve));
    try {
      await expect(rows(b.page)).toHaveCount(12);
      await expect(earlier(b.page)).toHaveCount(0);
    } finally {
      await b.context.close();
    }
  });

  test("a goal with an end shows every week and draws no «semanas anteriores» line", async ({ person, browser, baseURL, db }) => {
    // Kills: drawing the line without looking at `horizon`.
    const horizon = dateToCivilDate(new Date(Date.now() + 280 * 86_400_000));
    const id = await seedOpenGoal(db, person, { name: "Escribir", unit: { measure: "páginas", unit: "páginas" }, horizon, created: weeksAgo(29) });
    const { page, context } = await open(browser, baseURL, person, weekPath(id));
    try {
      expect(await rows(page).count()).toBeGreaterThan(12);
      await expect(earlier(page)).toHaveCount(0);
      await expect(seeAll(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
