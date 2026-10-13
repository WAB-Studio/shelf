import type { Locator, Page } from "@playwright/test";

import { dayBefore, horizonForWeeks } from "@/lib/day/weeks";

import { test, expect, type Person } from "./fixtures";
import { countActionPosts, dateWords, expectTitle, openAs, seedGoal, MINUTES, today, type Db } from "./meta-arbol-seed";

// Module 872 (RP-79), board `JerarquiaFinRechazado`: the end of a goal cannot pass the end of the
// goal above (RP-79) nor fall before the end of a goal inside it. The sheet «¿Cuántas semanas?» says
// which goal blocks it, by name and with its last day, before any request leaves; the server says the
// same if the tree changed in between. Goals open today, so a count of N weeks ends on
// `horizonForWeeks(today, N)`.

const WEEKS_LABEL = /^semanas, contando esta$/;

async function seedWeeks(db: Db, person: Person, stamp: number, weeks: { G: number; g1: number; p: number; g2: number }) {
  const names = {
    G: `General final ${stamp}`,
    g1: `Zeta final ${stamp}`,
    p: `Pequeña final ${stamp}`,
    g2: `Alfa final ${stamp}`,
  };
  const opened = new Date();
  const at = (n: number) => horizonForWeeks(today, n);
  const G = await seedGoal(db, person, { name: names.G, unit: MINUTES, horizon: at(weeks.G), created: opened });
  const g1 = await seedGoal(db, person, { name: names.g1, parent: G, unit: MINUTES, horizon: at(weeks.g1), created: opened });
  const p = await seedGoal(db, person, { name: names.p, parent: g1, unit: MINUTES, horizon: at(weeks.p), created: opened });
  const g2 = await seedGoal(db, person, { name: names.g2, parent: G, unit: MINUTES, horizon: at(weeks.g2), created: opened });
  return { G, g1, p, g2, names, at };
}

async function horizonOf(db: Db, id: string): Promise<string> {
  const [row] = await db<{ horizon: string }[]>`select horizon::text as horizon from goals.goals where id = ${id}`;
  return row.horizon;
}

async function openHorizon(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "mover el final" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const belowEndsLater = (name: string) =>
  new RegExp(`^«${escape(name)}» termina el .+, después de ese día\\. Mueve primero su final\\.$`);
const endPastAbove = (name: string) => new RegExp(`^Pasa del final de «${escape(name)}», el .+\\.$`);

test("shortening a general's end before a goal inside it lists that goal on the sheet, «Moverlo» is not available, and nothing leaves (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: not listing the goal that ends after (no recuadro), listing one that ends before, or leaving «Moverlo» enabled to write.
  const tree = await seedWeeks(db, person, Date.now(), { G: 30, g1: 12, p: 8, g2: 20 });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    const calls = countActionPosts(page);
    const sheet = await openHorizon(page);
    const weeks = sheet.getByLabel(WEEKS_LABEL);
    await expect(weeks).toHaveValue("30");
    await weeks.fill("15");

    // g1 ends in week 12 and does not pass 15; g2 ends in week 20 and does.
    await expect(sheet.getByText("1 meta termina después de esta fecha", { exact: true })).toBeVisible();
    await expect(sheet).toContainText(tree.names.g2);
    expect(dateWords(dayBefore(tree.at(20))).test(await sheet.innerText())).toBe(true);
    await expect(sheet.getByText(tree.names.g1)).toHaveCount(0);
    await expect(weeks).toHaveAttribute("aria-invalid", "true");
    const confirm = sheet.getByRole("button", { name: "Moverlo", exact: true });
    await expect(confirm).toBeDisabled();
    await confirm.dispatchEvent("click");

    await page.waitForTimeout(500);
    expect(calls).toEqual([]);
    expect(await horizonOf(db, tree.G)).toBe(tree.at(30));
  } finally {
    await context.close();
  }
});

test("a count ending exactly where the last goal inside ends is accepted and written (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: refusing a tie (`>=` where the rule is «after»), which would make the end unmovable to its natural floor.
  const tree = await seedWeeks(db, person, Date.now(), { G: 30, g1: 12, p: 8, g2: 20 });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    const calls = countActionPosts(page);
    const sheet = await openHorizon(page);
    await sheet.getByLabel(WEEKS_LABEL).fill("20");
    const confirm = sheet.getByRole("button", { name: "Moverlo", exact: true });
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(sheet).toBeHidden();

    expect(calls).toHaveLength(1);
    expect(await horizonOf(db, tree.G)).toBe(tree.at(20));
    await expect(page.getByText(/^20 semanas · hasta el /)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("when two goals end on the same last day, the list names the first of the plan first (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: listing the goals out of plan order on a tie (here Alfa before Zeta).
  const tree = await seedWeeks(db, person, Date.now(), { G: 30, g1: 20, p: 8, g2: 20 });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    const calls = countActionPosts(page);
    const sheet = await openHorizon(page);
    await sheet.getByLabel(WEEKS_LABEL).fill("15");
    await expect(sheet.getByText("2 metas terminan después de esta fecha", { exact: true })).toBeVisible();
    const text = await sheet.innerText();
    expect(text.indexOf(tree.names.g1)).toBeGreaterThan(-1);
    expect(text.indexOf(tree.names.g1)).toBeLessThan(text.indexOf(tree.names.g2));
    await expect(sheet.getByRole("button", { name: "Moverlo", exact: true })).toBeDisabled();
    expect(calls).toEqual([]);
    expect(await horizonOf(db, tree.G)).toBe(tree.at(30));
  } finally {
    await context.close();
  }
});

test("a goal inside cannot end after the goal above: the sentence names it and its last day, and nothing leaves (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: letting a large goal's end pass the general's, or naming a different goal than the one directly above.
  const tree = await seedWeeks(db, person, Date.now(), { G: 30, g1: 12, p: 8, g2: 20 });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.g1}`);
  try {
    const calls = countActionPosts(page);
    const sheet = await openHorizon(page);
    const weeks = sheet.getByLabel(WEEKS_LABEL);
    await expect(weeks).toHaveValue("12");

    await weeks.fill("31");
    const sentence = sheet.getByText(endPastAbove(tree.names.G));
    await expect(sentence).toBeVisible();
    expect(dateWords(dayBefore(tree.at(30))).test(await sentence.innerText())).toBe(true);
    await expect(weeks).toHaveAttribute("aria-invalid", "true");
    const confirm = sheet.getByRole("button", { name: "Moverlo", exact: true });
    await expect(confirm).toBeDisabled();
    await confirm.dispatchEvent("click");
    await page.waitForTimeout(500);
    expect(calls).toEqual([]);
    expect(await horizonOf(db, tree.g1)).toBe(tree.at(12));

    // The general's own last week is allowed.
    await weeks.fill("30");
    await expect(sheet.getByText(endPastAbove(tree.names.G))).toHaveCount(0);
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(sheet).toBeHidden();
    expect(await horizonOf(db, tree.g1)).toBe(tree.at(30));
  } finally {
    await context.close();
  }
});

test("a goal that ended up in the way after the page loaded: saving shows the server's sentence naming it and writes nothing (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: showing a generic or untranslated error for a refusal the server made (the tree changed in another tab).
  const tree = await seedWeeks(db, person, Date.now(), { G: 30, g1: 12, p: 8, g2: 14 });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    const calls = countActionPosts(page);
    const sheet = await openHorizon(page);
    await sheet.getByLabel(WEEKS_LABEL).fill("15");
    const confirm = sheet.getByRole("button", { name: "Moverlo", exact: true });
    // On the page's own data nothing blocks 15 weeks.
    await expect(confirm).toBeEnabled();
    await expect(sheet.getByText(belowEndsLater(tree.names.g2))).toHaveCount(0);

    await db`update goals.goals set horizon = ${tree.at(18)}::date where id = ${tree.g2}`;
    await confirm.click();

    const sentence = sheet.getByText(belowEndsLater(tree.names.g2));
    await expect(sentence).toBeVisible();
    expect(dateWords(dayBefore(tree.at(18))).test(await sentence.innerText())).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await horizonOf(db, tree.G)).toBe(tree.at(30));
    await expect(page.getByRole("dialog").getByText(belowEndsLater(tree.names.g2))).toBeVisible();
    await sheet.getByRole("button", { name: "Dejarlo como está" }).click();
    await expect(sheet).toBeHidden();
    await expectTitle(page, tree.names.G);
  } finally {
    await context.close();
  }
});
