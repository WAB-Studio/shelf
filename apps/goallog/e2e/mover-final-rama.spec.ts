import type { Locator, Page } from "@playwright/test";

import { dayBefore, horizonForWeeks } from "@/lib/day/weeks";

import { test, expect, type Person } from "./fixtures";
import { countActionPosts, openAs, seedGoal, MINUTES, today, type Db, MONTH_LONG } from "./meta-arbol-seed";

// Module 908 (RP-79), board `MoverFinalRama`: shortening a general's end past the ends of its goals
// offers «Mover también sus finales», the only way to shorten it (a general's end never moves alone
// past its goals'). The sheet lists the goals that end after the typed end, each with its end and
// its year; one tap moves them all; a phase past the new end refuses the whole move, naming the goal
// and the phase's last day. Goals open today, so N weeks ends on `horizonForWeeks(today, N)`.

const WEEKS_LABEL = /^semanas, contando esta$/;
const at = (n: number) => horizonForWeeks(today, n);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// «4 jul 2027»: the board's spelling of an end date, the year always there.
function dmy(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTH_LONG[Number(day.slice(5, 7)) - 1].slice(0, 3)} ${day.slice(0, 4)}`;
}
// The day of a refusal sentence in either spelling, «4 jul 2027» or «4 de julio de 2027».
function dayWithYear(day: string): RegExp {
  const month = MONTH_LONG[Number(day.slice(5, 7)) - 1];
  return new RegExp(`\\b${Number(day.slice(8, 10))} (?:de )?${month.slice(0, 3)}\\p{L}*(?: de)? ${day.slice(0, 4)}\\b`, "iu");
}

async function seedBranch(db: Db, person: Person, stamp: number) {
  const names = {
    G: `Product Designer ${stamp}`,
    c1: `Caso uno ${stamp}`,
    c1s: `Pequeña temprana ${stamp}`,
    c2: `Caso dos ${stamp}`,
    c3: `Caso tres ${stamp}`,
    ing: `Inglés ${stamp}`,
    ings: `Pequeña tardía ${stamp}`,
    emp: `Primer empleo ${stamp}`,
  };
  const opened = new Date(`${today}T12:00:00-05:00`);
  const goal = (name: string, weeks: number, parent?: string) =>
    seedGoal(db, person, { name, parent, unit: MINUTES, horizon: at(weeks), created: opened });
  const G = await goal(names.G, 52);
  const c1 = await goal(names.c1, 8, G);
  const c1s = await goal(names.c1s, 6, c1);
  const c2 = await goal(names.c2, 52, G);
  const c3 = await goal(names.c3, 52, G);
  const ing = await goal(names.ing, 52, G);
  const ings = await goal(names.ings, 46, ing);
  const emp = await goal(names.emp, 52, G);
  const late = [c2, c3, ing, ings, emp];
  return { G, c1, c1s, late, ids: { G, c1, c1s, c2, c3, ing, ings, emp }, names };
}

async function horizonsOf(db: Db, ids: string[]): Promise<Record<string, string>> {
  const rows = await db<{ id: string; horizon: string }[]>`
    select id, horizon::text as horizon from goals.goals where id in ${db(ids)}`;
  return Object.fromEntries(rows.map((r) => [r.id, r.horizon]));
}

async function openSheet(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "mover el final" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  return sheet;
}

test("a general's end typed before its goals' ends lists them, each with its end and year, and Moverlo is not available (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: not listing the goals (no recuadro), listing a goal that ends before the typed end, or leaving «Moverlo» enabled.
  const tree = await seedBranch(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`, 360, true);
  try {
    const calls = countActionPosts(page);
    const sheet = await openSheet(page);
    const weeks = sheet.getByLabel(WEEKS_LABEL);
    await expect(weeks).toHaveValue("52");
    await weeks.fill("40");

    // Large and small goals alike: five end after week 40.
    await expect(sheet.getByText("5 metas terminan después de esta fecha", { exact: true })).toBeVisible();
    for (const [name, weeksEnd] of [
      [tree.names.c2, 52],
      [tree.names.c3, 52],
      [tree.names.ing, 52],
      [tree.names.ings, 46],
      [tree.names.emp, 52],
    ] as const) {
      await expect(sheet).toContainText(new RegExp(`${escape(name)} · hasta el ${escape(dmy(dayBefore(at(weeksEnd))))}`));
    }
    // Goals that end before the typed end are not on the list.
    await expect(sheet.getByText(tree.names.c1)).toHaveCount(0);
    await expect(sheet.getByText(tree.names.c1s)).toHaveCount(0);
    await expect(sheet).toContainText(`Con «Mover también sus finales» las 5 terminan el ${dmy(dayBefore(at(40)))}.`);
    // The typed end itself carries its year.
    await expect(sheet).toContainText(`termina el ${dmy(dayBefore(at(40)))}`);

    await expect(sheet.getByRole("button", { name: "Mover también sus finales", exact: true })).toBeEnabled();
    const only = sheet.getByRole("button", { name: "Moverlo", exact: true });
    await expect(only).toBeDisabled();
    await only.dispatchEvent("click");
    await page.clock.runFor(30_000);
    expect(calls).toEqual([]);
    expect(await horizonsOf(db, Object.values(tree.ids))).toMatchObject({ [tree.G]: at(52), [tree.ids.c2]: at(52), [tree.ids.emp]: at(52) });
  } finally {
    await context.close();
  }
});

test("«Mover también sus finales» moves every goal past the new end to it, leaves the others, and the screen says so (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: moving only the general, moving only the large goals (not the small one), moving the goals that end earlier, or no after-state sentence.
  const tree = await seedBranch(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    const calls = countActionPosts(page);
    const sheet = await openSheet(page);
    await sheet.getByLabel(WEEKS_LABEL).fill("40");
    await sheet.getByRole("button", { name: "Mover también sus finales", exact: true }).click();
    await expect(sheet).toBeHidden();

    expect(calls).toHaveLength(1);
    await expect(page.getByText("Se movió el final de la meta y el de 5 metas dentro.", { exact: true })).toBeVisible();
    await expect(page.locator("main").first()).toContainText(`hasta el ${dmy(dayBefore(at(40)))}`);

    const now = await horizonsOf(db, Object.values(tree.ids));
    expect(now[tree.G]).toBe(at(40));
    for (const id of tree.late) expect(now[id]).toBe(at(40));
    expect(now[tree.c1]).toBe(at(8));
    expect(now[tree.c1s]).toBe(at(6));
  } finally {
    await context.close();
  }
});

test("a goal below with a phase past the new end refuses the whole move, naming it and the phase's last day; nothing moves (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: moving the branch around a phase that would then end past its goal, or a refusal that names no goal or no day.
  const tree = await seedBranch(db, person, Date.now());
  const phaseEnds = dayBefore(at(46));
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${tree.ids.c2}, 'Fase tardía', ${today}::date, ${phaseEnds}::date)`;
  const before = await horizonsOf(db, Object.values(tree.ids));
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`, 360, true);
  try {
    const calls = countActionPosts(page);
    const sheet = await openSheet(page);
    await sheet.getByLabel(WEEKS_LABEL).fill("40");
    const all = sheet.getByRole("button", { name: "Mover también sus finales", exact: true });
    await expect(all).toBeEnabled();
    await all.click();

    const sentence = sheet.getByText(new RegExp(`«${escape(tree.names.c2)}»`));
    await expect(sentence).toBeVisible();
    expect(await sentence.innerText()).toMatch(dayWithYear(phaseEnds));
    await expect(sheet).toBeVisible();
    // The refusal is the one request; none follows it once every timer has run.
    await page.clock.runFor(30_000);
    expect(calls).toHaveLength(1);
    expect(await horizonsOf(db, Object.values(tree.ids))).toEqual(before);
  } finally {
    await context.close();
  }
});

test("a phase that ends before the new end does not stop the move (RP-79)", async ({ person, browser, baseURL, db }) => {
  // Kills: refusing on any phase of a goal that passes, instead of one that ends after the new end.
  const tree = await seedBranch(db, person, Date.now());
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${tree.ids.c2}, 'Fase a tiempo', ${today}::date, ${dayBefore(at(30))}::date)`;
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    const sheet = await openSheet(page);
    await sheet.getByLabel(WEEKS_LABEL).fill("40");
    await sheet.getByRole("button", { name: "Mover también sus finales", exact: true }).click();
    await expect(sheet).toBeHidden();
    const now = await horizonsOf(db, [tree.G, tree.ids.c2]);
    expect(now).toEqual({ [tree.G]: at(40), [tree.ids.c2]: at(40) });
  } finally {
    await context.close();
  }
});

test("an end no goal passes shows no list and no «Mover también…», and «Moverlo» moves the general alone, with the year on the end (RP-79)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  // Kills: showing the list or the button when nothing passes, or breaking the plain «Moverlo».
  const tree = await seedBranch(db, person, Date.now());
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${tree.G}`);
  try {
    const before = await horizonsOf(db, Object.values(tree.ids));
    const sheet = await openSheet(page);
    // Lengthening the general: no goal can end after it.
    await sheet.getByLabel(WEEKS_LABEL).fill("60");
    await expect(sheet).toContainText(`termina el ${dmy(dayBefore(at(60)))}`);
    await expect(sheet.getByText(/terminan después de esta fecha|termina después de esta fecha/)).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Mover también sus finales" })).toHaveCount(0);
    const only = sheet.getByRole("button", { name: "Moverlo", exact: true });
    await expect(only).toBeEnabled();
    await only.click();
    await expect(sheet).toBeHidden();

    const now = await horizonsOf(db, Object.values(tree.ids));
    expect(now[tree.G]).toBe(at(60));
    for (const id of Object.values(tree.ids)) if (id !== tree.G) expect(now[id]).toBe(before[id]);
    await expect(page.getByText(/^Se movió el final de la meta/)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a general whose goals all end at or before the new end gets the plain sheet (RP-79)", async ({ person, browser, baseURL, db }) => {
  // Kills: counting a goal that ends exactly on the new end (`>=` for «after»).
  const names = { G: `General plano ${Date.now()}`, a: `Hija plana ${Date.now()}` };
  const opened = new Date();
  const G = await seedGoal(db, person, { name: names.G, unit: MINUTES, horizon: at(30), created: opened });
  await seedGoal(db, person, { name: names.a, parent: G, unit: MINUTES, horizon: at(20), created: opened });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${G}`);
  try {
    const sheet = await openSheet(page);
    await sheet.getByLabel(WEEKS_LABEL).fill("20");
    await expect(sheet.getByRole("button", { name: "Mover también sus finales" })).toHaveCount(0);
    await expect(sheet.getByText(/después de esta fecha/)).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Moverlo", exact: true })).toBeEnabled();
  } finally {
    await context.close();
  }
});
