import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, visit } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// M58: a row of chips the person picks one of is a radio group the keyboard walks with the arrows, and the
// seven weekday chips carry the day's full name.
const CADENCES = ["todos los días", "días sueltos", "veces por semana", "cada tantos días", "veces al mes"];
const WEEKDAY_NAMES = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

async function goalOf(db: postgres.Sql, personId: string): Promise<string> {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + 90);
  const [row] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${`Radio ${Date.now()}`}, ${dateToCivilDate(date)}::date, now() - interval '3 days')
    returning id
  `;
  return row.id;
}

function asPerson(browser: Browser, baseURL: string, storageState: string): Promise<BrowserContext> {
  return browser.newContext({ storageState, baseURL, viewport: { width: 360, height: 740 }, hasTouch: true });
}

const cadenceGroup = (page: Page): Locator =>
  page.getByRole("radiogroup").filter({ has: page.getByRole("radio", { name: "días sueltos", exact: true }) });

const focusedName = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? null);

test.describe("the cadence row of «Compromiso nuevo»", () => {
  let goal: string;
  let context: BrowserContext;
  let page: Page;
  test.beforeEach(async ({ person, db, browser, baseURL }) => {
    goal = await goalOf(db, person.id);
    context = await asPerson(browser, baseURL!, person.sessionFile);
    page = await context.newPage();
    await visit(page, `/metas/${goal}/compromisos/nuevo`);
  });
  test.afterEach(async ({ person, db }) => {
    await context.close();
    await db`delete from goals.goals where id = ${goal} and user_id = ${person.id}`;
  });

  test("is a named radio group of five radios with exactly one checked and none pressed", async () => {
    // Kills: the chips staying aria-pressed buttons in a bare div.
    const group = cadenceGroup(page);
    await expect(group).toHaveCount(1);
    await expect(group).toHaveAccessibleName(/\S/);
    const radios = group.getByRole("radio");
    await expect(radios).toHaveCount(5);
    expect(await radios.evaluateAll((els) => els.map((el) => el.textContent!.trim()))).toEqual(CADENCES);
    await expect(group.locator('[aria-checked="true"]')).toHaveCount(1);
    await expect(radios.first()).toHaveAttribute("aria-checked", "true");
    await expect(group.locator("[aria-pressed]")).toHaveCount(0);
  });

  test("only the checked radio is tabbable, and one Tab leaves the row", async () => {
    // Kills: every chip in the tab order (Tab stops on each chip).
    const radios = cadenceGroup(page).getByRole("radio");
    await expect(radios).toHaveCount(5);
    const tabindexes = await radios.evaluateAll((els) => els.map((el) => el.getAttribute("tabindex")));
    expect(tabindexes).toEqual(["0", "-1", "-1", "-1", "-1"]);
    await radios.first().focus();
    await page.keyboard.press("Tab");
    const inside = await cadenceGroup(page).evaluate((el) => el.contains(document.activeElement));
    expect(inside, "the second Tab lands outside the row").toBe(false);
  });

  test("ArrowRight moves the check and the focus to the next chip, ArrowLeft back", async () => {
    // Kills: arrows that move focus only, or the check only, or nothing.
    const radios = cadenceGroup(page).getByRole("radio");
    await expect(radios).toHaveCount(5);
    await radios.first().focus();
    await page.keyboard.press("ArrowRight");
    await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
    await expect(radios.nth(1)).toBeFocused();
    await expect(radios.first()).toHaveAttribute("aria-checked", "false");
    expect(await focusedName(page)).toBe("días sueltos");
    expect(await radios.evaluateAll((els) => els.map((el) => el.getAttribute("tabindex")))).toEqual(["-1", "0", "-1", "-1", "-1"]);
    await page.keyboard.press("ArrowRight");
    await expect(radios.nth(2)).toBeFocused();
    await expect(radios.nth(2)).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(radios.nth(1)).toBeFocused();
    await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
    await expect(radios.nth(2)).toHaveAttribute("aria-checked", "false");
  });

  test("the day chips keep their letter and are named by the whole weekday", async () => {
    // Kills: an aria-label left off, so the chip reads «L».
    await page.getByRole("main").getByText("días sueltos", { exact: true }).click();
    const main = page.getByRole("main");
    for (const [index, name] of WEEKDAY_NAMES.entries()) {
      const chip = main.getByRole("button", { name, exact: true });
      await expect(chip, name).toHaveCount(1);
      await expect(chip).toHaveText("LMXJVSD"[index]);
    }
    await expect(main.getByRole("button", { name: "L", exact: true })).toHaveCount(0);
  });
});

test.describe("the end row of «¿Qué quieres sostener?»", () => {
  test("is a named radio group and ArrowRight checks and focuses «sin final»", async ({ page }) => {
    // Kills: the pair left outside any group, or arrows that do nothing.
    await visit(page, "/metas/nueva");
    const group = page.getByRole("radiogroup").filter({ has: page.getByRole("radio", { name: "sin final", exact: true }) });
    await expect(group).toHaveCount(1);
    await expect(group).toHaveAccessibleName(/\S/);
    const withEnd = group.getByRole("radio", { name: "con final", exact: true });
    const noEnd = group.getByRole("radio", { name: "sin final", exact: true });
    await expect(withEnd).toHaveAttribute("aria-checked", "true");
    await expect(withEnd).toHaveAttribute("tabindex", "0");
    await expect(noEnd).toHaveAttribute("tabindex", "-1");
    await withEnd.focus();
    await page.keyboard.press("ArrowRight");
    await expect(noEnd).toBeFocused();
    await expect(noEnd).toHaveAttribute("aria-checked", "true");
    await expect(withEnd).toHaveAttribute("aria-checked", "false");
  });
});
