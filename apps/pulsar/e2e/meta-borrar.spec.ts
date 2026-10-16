import type { Browser, Locator, Page } from "@playwright/test";

import { weeksToPhaseSpan } from "@/components/goal/phase-weeks";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf } from "@/lib/plan/months";
import { civilDateInZone } from "@/lib/zone";

import goalMessages from "../messages/es/goal.json";
import planMessages from "../messages/es/plan.json";
import roadmapMessages from "../messages/es/roadmap.json";
import { test, expect, visit, type Person } from "./fixtures";
import { holdActions, monthsAhead, thisMonth, MINUTES, type Db } from "./meta-arbol-seed";
import { PAGES, dialog, monthLabel, postCounter, rhythmOfGoal, seedOpenGoal, seedTask } from "./metas-sin-final-seed";

// Module 1016, RP-127 and RP-134: the goal's own screen deletes a goal nothing has happened in, changes or removes a
// measure no fact feeds, drops its rhythm from the rhythm sheet, and opens a phase from its row. Written from the
// contract (private/asignaciones/1016.md, docs/pulsar/SPEC.md), not from the screen. Every test names the mutation that
// kills it.

test.use({ actionTimeout: 6000 });

const DAY_MS = 86_400_000;
const DAY_BACK = (days: number) => new Date(Date.now() - days * DAY_MS);
const lastMonth = monthOf(dayBefore(thisMonth));

const DELETE = goalMessages.delete.action;
const CONFIRM = goalMessages.delete.confirm;
const KEEP = goalMessages.delete.keep;
const CHANGE = goalMessages.measure.change;
const REMOVE_MEASURE = goalMessages.measure.remove;
const UNIT_CHANGE = goalMessages.measure.unitChangeBody;
const REMOVE_RHYTHM = roadmapMessages.rhythm.remove;
const BODY_OTHER = roadmapMessages.rhythm.removeBody;
const BODY_PLAN = roadmapMessages.rhythm.removeBodyPlan;
const NAME_LABEL = "qué cuenta";
const UNIT_LABEL = "en qué unidad";

async function open(browser: Browser, baseURL: string | undefined, person: Person, path: string, width = 360) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width, height: 900 } });
  const page = await context.newPage();
  await visit(page, path);
  return { page, context };
}

const deleteButton = (page: Page) => page.getByRole("button", { name: DELETE, exact: true });
const confirmDelete = (sheet: Locator) => sheet.getByRole("button", { name: CONFIRM, exact: true });
const keepGoal = (sheet: Locator) => sheet.getByRole("button", { name: KEEP, exact: true });
const nameField = (sheet: Locator) => sheet.getByLabel(NAME_LABEL, { exact: true });
const unitField = (sheet: Locator) => sheet.getByLabel(UNIT_LABEL, { exact: true });

async function goalRows(db: Db, id: string) {
  const [row] = await db<{ n: string }[]>`select count(*)::text as n from goals.goals where id = ${id}`;
  return Number(row.n);
}

async function rowsOf(db: Db, table: "month_budgets" | "commitments" | "phases" | "one_offs", id: string) {
  const [row] = await db<{ n: string }[]>`select count(*)::text as n from ${db("goals." + table)} where goal_id = ${id}`;
  return Number(row.n);
}

async function measureOf(db: Db, id: string) {
  const [row] = await db<{ name: string | null; unit: string | null; rhythm: number | null }[]>`
    select measure_name as name, measure_unit as unit, rhythm from goals.goals where id = ${id}`;
  return row;
}

async function budget(db: Db, person: Person, goalId: string, month: string, amount: number) {
  await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goalId}, ${month}::date, ${amount})`;
}

// A daily tap commitment born days ago: it asks today, so Hoy draws its goal.
async function seedAsk(db: Db, person: Person, goalId: string) {
  const [row] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${goalId}, 'Tocar la meta', 'daily', 'tap', now() - interval '3 days')
    returning id`;
  return row.id;
}

type Via = "commitment" | "task" | "subtask";

// One fact, reached from the goal by one of the three roads the delete rule follows (RP-127): its commitment, its task,
// the task's sub-task. The fact itself names no goal, so only the road can find it.
async function seedFact(db: Db, person: Person, goalId: string, via: Via) {
  const day = civilDateInZone(new Date());
  if (via === "commitment") {
    const commitment = await seedAsk(db, person, goalId);
    await db`insert into goals.facts (user_id, commitment_id, day) values (${person.id}, ${commitment}, ${day}::date)`;
    return;
  }
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name) values (${person.id}, ${goalId}, 'Tarea hecha') returning id`;
  let target = task.id;
  if (via === "subtask") {
    const [sub] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, parent_id, name) values (${person.id}, ${goalId}, ${task.id}, 'Parte hecha') returning id`;
    target = sub.id;
  }
  await db`insert into goals.facts (user_id, one_off_id, day) values (${person.id}, ${target}, ${day}::date)`;
}

// A fact that feeds the measure (RP-14): a quantity of a commitment in the measure's own unit.
async function seedFeeding(db: Db, person: Person, goalId: string, unit: string, quantity: number | null) {
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goalId}, 'Ronda', 'daily', ${quantity === null ? "tap" : "quantity"}, ${quantity === null ? null : 5},
            ${quantity === null ? null : unit}, now() - interval '30 days')
    returning id`;
  await db`
    insert into goals.facts (user_id, commitment_id, goal_id, day, quantity)
    values (${person.id}, ${commitment.id}, ${goalId}, ${civilDateInZone(new Date())}::date, ${quantity})`;
}

const mudanza = (db: Db, person: Person) => seedOpenGoal(db, person, { name: "Mudanza", unit: null, created: DAY_BACK(3) });
const leer = (db: Db, person: Person, rhythm: number | null = null) =>
  seedOpenGoal(db, person, { name: "Leer", unit: { measure: "Páginas leídas", unit: "páginas" }, rhythm, created: DAY_BACK(3) });

// ---------------------------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------------------------

test("a goal nothing has happened in offers «Borrar la meta»; a goal with a fact does not, whichever road the fact took (RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: `deletable` read as `facts.length === 0` or any partial road (commitment only, task only, no sub-task), or the
  // action drawn always. One goal per road, because each road is a different join in the rule.
  const bare = await mudanza(db, person);
  const seeded: [Via, string][] = [];
  for (const via of ["commitment", "task", "subtask"] as const) {
    const id = await seedOpenGoal(db, person, { name: `Con hecho ${via}`, unit: null, created: DAY_BACK(3) });
    await seedFact(db, person, id, via);
    seeded.push([via, id]);
  }

  const a = await open(browser, baseURL, person, `/metas/${bare}`);
  try {
    await expect(deleteButton(a.page)).toBeVisible();
  } finally {
    await a.context.close();
  }
  for (const [via, id] of seeded) {
    const b = await open(browser, baseURL, person, `/metas/${id}`);
    try {
      await expect(b.page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(deleteButton(b.page), via).toHaveCount(0);
    } finally {
      await b.context.close();
    }
  }
});

test("a goal that holds a goal, open or archived, offers no «Borrar la meta» (RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: `deletable` ignoring children, or counting only the open ones.
  const openHolder = await seedOpenGoal(db, person, { name: "Casa", unit: null, created: DAY_BACK(5) });
  const leaf = await seedOpenGoal(db, person, { name: "Cocina", parent: openHolder, unit: null, created: DAY_BACK(5) });
  const archivedHolder = await seedOpenGoal(db, person, { name: "Jardín", unit: null, created: DAY_BACK(5) });
  const kid = await seedOpenGoal(db, person, { name: "Rosas", parent: archivedHolder, unit: null, created: DAY_BACK(5) });
  await db`update goals.goals set archived_at = now() where id = ${kid}`;
  // The goal inside holds nothing and offers the delete, so the holders' lack is the rule, not a missing screen.
  const inside = await open(browser, baseURL, person, `/metas/${leaf}`);
  try {
    await expect(deleteButton(inside.page)).toBeVisible();
  } finally {
    await inside.context.close();
  }
  for (const id of [openHolder, archivedHolder]) {
    const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
    try {
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(deleteButton(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
});

test("the delete sheet names the goal and what goes; «Dejarla como está» closes it, the goal stays and nothing is sent (RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: deleting on dismiss; a sheet that does not name the goal.
  const id = await mudanza(db, person);
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
  try {
    const posts = postCounter(page);
    await deleteButton(page).click();
    const sheet = dialog(page);
    await expect(sheet.getByText(goalMessages.delete.body.replace("{goal}", "Mudanza"), { exact: true })).toBeVisible();
    await keepGoal(sheet).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(posts).toEqual([]);
    expect(await goalRows(db, id)).toBe(1);
    await expect(page.getByRole("heading", { level: 1, name: "Mudanza" })).toBeVisible();
    expect(page.url()).toContain(`/metas/${id}`);
  } finally {
    await context.close();
  }
});

test("«Borrarla» pends with both buttons disabled and a second tap sends nothing more (RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: dropping `pending` from the delete (a double delete, or a stale sheet that stays enabled).
  const id = await mudanza(db, person);
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
  try {
    const posts = postCounter(page);
    await deleteButton(page).click();
    const sheet = dialog(page);
    await holdActions(page, 1500);
    await confirmDelete(sheet).click();
    await expect(confirmDelete(sheet)).toBeDisabled();
    await expect(keepGoal(sheet)).toBeDisabled();
    await confirmDelete(sheet).dispatchEvent("click");
    await expect(page).toHaveURL(/\/metas$/);
    expect(posts).toHaveLength(1);
    expect(await goalRows(db, id)).toBe(0);
  } finally {
    await context.close();
  }
});

test("deleting lands on /metas, the goal is in no list, Hoy does not draw it, and its phases, commitments, tasks and amounts are gone (RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: no redirect (the screen of a goal that no longer exists); a delete that leaves the goal's children behind; a
  // list or Hoy that keeps the goal from a stale cache.
  const id = await seedOpenGoal(db, person, { name: "Mudanza", unit: PAGES, horizon: monthsAhead(5), created: DAY_BACK(10) });
  await seedAsk(db, person, id);
  await seedTask(db, person, id, "Empacar", false);
  await budget(db, person, id, thisMonth, 30);
  const span = weeksToPhaseSpan(civilDateInZone(DAY_BACK(10)), 1, 2, null);
  await db`insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
           values (${person.id}, ${id}, 'Cajas', ${span.startsOn}::date, ${span.endsOn}::date)`;

  const hoy = await open(browser, baseURL, person, "/");
  try {
    await expect(hoy.page.getByRole("main").getByText("Mudanza", { exact: true }).first()).toBeVisible();
  } finally {
    await hoy.context.close();
  }

  const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
  try {
    await deleteButton(page).click();
    await confirmDelete(dialog(page)).click();
    await expect(page).toHaveURL(/\/metas$/);
    await expect(page.locator("main:visible")).toHaveCount(1);
    await expect(page.locator(`main a[href="/metas/${id}"]`)).toHaveCount(0);
    expect(await goalRows(db, id)).toBe(0);
    for (const table of ["month_budgets", "commitments", "phases", "one_offs"] as const) {
      expect(await rowsOf(db, table, id), table).toBe(0);
    }
    await visit(page, "/");
    await expect(page.getByRole("main").getByText("Mudanza", { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a fact that arrives while the sheet is open is refused with «ya tiene hechos» and the goal stays (RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: swallowing the server's refusal (the sheet closes, or leaves, as if it had deleted); deleting a goal with facts.
  const id = await mudanza(db, person);
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
  try {
    await deleteButton(page).click();
    const sheet = dialog(page);
    await seedFact(db, person, id, "task");
    await confirmDelete(sheet).click();
    await expect(sheet.getByText(planMessages.errors.goalHasFacts, { exact: true })).toBeVisible();
    await expect(dialog(page)).toBeVisible();
    await expect(confirmDelete(sheet)).toBeEnabled();
    expect(page.url()).toContain(`/metas/${id}`);
    expect(await goalRows(db, id)).toBe(1);
  } finally {
    await context.close();
  }
});

test("a goal that arrives inside while the sheet is open is refused with «metas dentro» and the goal stays (RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: swallowing the holder refusal; a delete that takes the new goal along.
  const id = await mudanza(db, person);
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
  try {
    await deleteButton(page).click();
    const sheet = dialog(page);
    const kid = await seedOpenGoal(db, person, { name: "Cocina", parent: id, unit: null, created: DAY_BACK(1) });
    await confirmDelete(sheet).click();
    await expect(sheet.getByText(planMessages.errors.goalHoldsGoals, { exact: true })).toBeVisible();
    expect(await goalRows(db, id)).toBe(1);
    expect(await goalRows(db, kid)).toBe(1);
  } finally {
    await context.close();
  }
});

test("a fact-less archived goal offers «Borrar la meta» beside «Reabrir» and its phase rows stay plain text (RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: hiding the delete on an archived goal; linking phase rows of a closed goal.
  const id = await seedOpenGoal(db, person, { name: "Vieja", unit: null, created: DAY_BACK(30) });
  const span = weeksToPhaseSpan(civilDateInZone(DAY_BACK(30)), 1, 2, null);
  await db`insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
           values (${person.id}, ${id}, 'Cimientos viejos', ${span.startsOn}::date, ${span.endsOn}::date)`;
  await db`update goals.goals set archived_at = now() where id = ${id}`;
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
  try {
    const reopen = page.getByRole("button", { name: "Reabrir", exact: true });
    await expect(reopen).toBeVisible();
    await expect(deleteButton(page)).toBeVisible();
    await expect(page.getByText("Cimientos viejos", { exact: false })).toBeVisible();
    await expect(page.getByRole("link", { name: /Cimientos viejos/ })).toHaveCount(0);
    const [r, d] = [await reopen.boundingBox(), await deleteButton(page).boundingBox()];
    expect(Math.abs(d!.x - r!.x)).toBeLessThan(2);
    expect(d!.y).toBeGreaterThan(r!.y);

    await deleteButton(page).click();
    await confirmDelete(dialog(page)).click();
    await expect(page).toHaveURL(/\/metas$/);
    expect(await goalRows(db, id)).toBe(0);
  } finally {
    await context.close();
  }
});

for (const [width, label] of [[360, "phone"], [1280, "desktop"]] as const) {
  test(`at ${width} «Borrar la meta» sits ${label === "phone" ? "under «Archivar esta meta»" : "beside «Archivar»"} and nothing scrolls sideways, sheet open or shut (RP-127)`, async ({ person, browser, baseURL, db }) => {
    // Kills: the delete drawn on the wrong face, or wider than the screen (a class drawn outside `components/ui`).
    const id = await mudanza(db, person);
    const { page, context } = await open(browser, baseURL, person, `/metas/${id}`, width);
    try {
      const archive = page.getByRole("button", { name: label === "phone" ? "Archivar esta meta" : "Archivar", exact: true });
      await expect(archive).toBeVisible();
      await expect(deleteButton(page)).toBeVisible();
      await expect(deleteButton(page)).toHaveCount(1);
      const [a, d] = [await archive.boundingBox(), await deleteButton(page).boundingBox()];
      if (label === "phone") {
        expect(d!.y).toBeGreaterThanOrEqual(a!.y + a!.height - 1);
      } else {
        expect(Math.abs(d!.y - a!.y)).toBeLessThan(a!.height);
        expect(d!.x).not.toBe(a!.x);
      }
      const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(await overflow()).toBeLessThanOrEqual(0);
      await deleteButton(page).click();
      await expect(dialog(page)).toBeVisible();
      const sheet = await page.evaluate(() => {
        const box = (document.querySelector('[role="dialog"]') as HTMLElement).getBoundingClientRect();
        return { right: box.right - window.innerWidth, left: box.left };
      });
      expect(sheet.right).toBeLessThanOrEqual(0);
      expect(sheet.left).toBeGreaterThanOrEqual(0);
      expect(await overflow()).toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Measure
// ---------------------------------------------------------------------------------------------------------------

test("«Cambiar la medida» opens prefilled with the measure's name and unit (RP-127, RP-134)", async ({ person, browser, baseURL, db }) => {
  // Kills: the edit sheet opening blank (the old «Ponerle medida» sheet reused as it was).
  const id = await leer(db, person);
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
  try {
    await page.getByRole("button", { name: CHANGE, exact: true }).click();
    const sheet = dialog(page);
    await expect(nameField(sheet)).toHaveValue("Páginas leídas");
    await expect(unitField(sheet)).toHaveValue("páginas");
    await expect(sheet.getByRole("button", { name: REMOVE_MEASURE, exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a measure's new name shows at once without reload, keeps the unit, the rhythm and the month amounts, and says nothing about losing them (RP-127, RP-134)", async ({ person, browser, baseURL, db }) => {
  // Kills: a name change that clears the rhythm or the amounts (the unit-change rule applied always); a screen not
  // refreshed after the save; saving through `setGoalMeasure` (refused: the goal already measures).
  const id = await leer(db, person, 40);
  await budget(db, person, id, thisMonth, 25);
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
  try {
    await page.getByRole("button", { name: CHANGE, exact: true }).click();
    const sheet = dialog(page);
    await nameField(sheet).fill("Hojas leídas");
    await expect(sheet.getByText(UNIT_CHANGE, { exact: true })).toHaveCount(0);
    await sheet.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText("mide Hojas leídas, en páginas", { exact: true })).toBeVisible();
    await expect(page.getByText("mide Páginas leídas, en páginas", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /40 páginas al mes/ })).toBeVisible();
    expect(await measureOf(db, id)).toEqual({ name: "Hojas leídas", unit: "páginas", rhythm: 40 });
    expect(await rowsOf(db, "month_budgets", id)).toBe(1);
  } finally {
    await context.close();
  }
});

test("typing another unit says the rhythm and the amounts go; typing the old one back takes the sentence away; saving the new unit clears them (RP-127, RP-134)", async ({ person, browser, baseURL, db }) => {
  // Kills: omitting `unitChangeBody`; showing it for a name-only change; a unit change that keeps a rhythm written in
  // the old unit.
  const id = await leer(db, person, 40);
  await budget(db, person, id, thisMonth, 25);
  await budget(db, person, id, monthsAhead(1), 25);
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
  try {
    await page.getByRole("button", { name: CHANGE, exact: true }).click();
    const sheet = dialog(page);
    const says = sheet.getByText(UNIT_CHANGE, { exact: true });
    await expect(says).toHaveCount(0);
    await unitField(sheet).fill("hojas");
    await expect(says).toBeVisible();
    await unitField(sheet).fill("páginas");
    await expect(says).toHaveCount(0);
    await unitField(sheet).fill("hojas");
    await expect(says).toBeVisible();
    await sheet.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText("mide Páginas leídas, en hojas", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /40 páginas al mes/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Poner un ritmo/ })).toBeVisible();
    expect(await measureOf(db, id)).toEqual({ name: "Páginas leídas", unit: "hojas", rhythm: null });
    expect(await rowsOf(db, "month_budgets", id)).toBe(0);
  } finally {
    await context.close();
  }
});

test("saving the measure with the name empty says «Escribe qué cuenta.» and sends nothing (RP-134)", async ({ person, browser, baseURL, db }) => {
  // Kills: no client validation on the edit mode; a blank name written over the measure.
  const id = await leer(db, person, 40);
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
  try {
    const posts = postCounter(page);
    await page.getByRole("button", { name: CHANGE, exact: true }).click();
    const sheet = dialog(page);
    await nameField(sheet).fill("  ");
    await sheet.getByRole("button", { name: "Guardar", exact: true }).click();
    await expect(sheet.getByText("Escribe qué cuenta.", { exact: true })).toBeVisible();
    expect(posts).toEqual([]);
    expect(await measureOf(db, id)).toEqual({ name: "Páginas leídas", unit: "páginas", rhythm: 40 });
  } finally {
    await context.close();
  }
});

test("a measure a fact feeds offers neither «Cambiar la medida» nor «Quitar la medida»; a fact in another unit, or a tap, does not feed it (RP-14, RP-134)", async ({ person, browser, baseURL, db }) => {
  // Kills: offering the change when `measureFed` is true; or reading `fed` as «any fact» (the tap and the other-unit goals
  // would lose an act they are owed).
  const fed = await leer(db, person);
  await seedFeeding(db, person, fed, "páginas", 3);
  const tap = await leer(db, person);
  await seedFeeding(db, person, tap, "páginas", null);
  const other = await leer(db, person);
  await seedFeeding(db, person, other, "minutos", 3);

  const a = await open(browser, baseURL, person, `/metas/${fed}`);
  try {
    await expect(a.page.getByText("mide Páginas leídas, en páginas", { exact: true })).toBeVisible();
    await expect(a.page.getByRole("button", { name: CHANGE, exact: true })).toHaveCount(0);
    await expect(a.page.getByRole("button", { name: REMOVE_MEASURE, exact: true })).toHaveCount(0);
    await expect(deleteButton(a.page)).toHaveCount(0);
  } finally {
    await a.context.close();
  }
  for (const [label, id] of [["tap", tap], ["other unit", other]] as const) {
    const b = await open(browser, baseURL, person, `/metas/${id}`);
    try {
      await expect(b.page.getByRole("button", { name: CHANGE, exact: true }), label).toBeVisible();
      // A fact on the goal: it cannot be deleted, yet its measure is still the person's to change.
      await expect(deleteButton(b.page), label).toHaveCount(0);
    } finally {
      await b.context.close();
    }
  }
});

test("a goal that holds goals offers no «Cambiar la medida» (RP-134)", async ({ person, browser, baseURL, db }) => {
  // Kills: offering the change to a holder, whose measure is the sum of its goals'.
  const holder = await leer(db, person);
  await seedOpenGoal(db, person, { name: "Capítulo", parent: holder, unit: { measure: "Páginas leídas", unit: "páginas" }, created: DAY_BACK(3) });
  const leafGoal = await leer(db, person);
  const leafPage = await open(browser, baseURL, person, `/metas/${leafGoal}`);
  try {
    // A goal that holds nothing is offered the change, so the holder's lack is the rule, not a missing screen.
    await expect(leafPage.page.getByRole("button", { name: CHANGE, exact: true })).toBeVisible();
  } finally {
    await leafPage.context.close();
  }
  const { page, context } = await open(browser, baseURL, person, `/metas/${holder}`);
  try {
    await expect(page.getByRole("heading", { level: 1, name: "Leer" })).toBeVisible();
    await expect(page.getByRole("button", { name: CHANGE, exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("«Quitar la medida» says what goes with it, in the right number, before anything is written (RP-134)", async ({ person, browser, baseURL, db }) => {
  // Kills: a sentence that ignores the rhythm or the months; a wrong plural; writing on opening the sheet.
  const both = await leer(db, person, 40);
  await budget(db, person, both, thisMonth, 25);
  await budget(db, person, both, monthsAhead(1), 25);
  const one = await leer(db, person);
  await budget(db, person, one, monthsAhead(1), 25);
  const none = await leer(db, person);
  const cases: [string, string, string][] = [
    ["rhythm and two months", both, "Deja de medir. Se quita también su ritmo y los montos de 2 meses."],
    ["one month", one, "Deja de medir. Se quita el monto de 1 mes."],
    ["nothing", none, "Deja de medir."],
  ];
  for (const [label, id, sentence] of cases) {
    const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
    try {
      const posts = postCounter(page);
      await page.getByRole("button", { name: CHANGE, exact: true }).click();
      const sheet = dialog(page);
      await expect(sheet.getByText(sentence, { exact: true }), label).toBeVisible();
      await sheet.getByRole("button", { name: "Cancelar", exact: true }).click();
      await expect(dialog(page)).toHaveCount(0);
      expect(posts).toEqual([]);
      expect((await measureOf(db, id)).unit, label).toBe("páginas");
    } finally {
      await context.close();
    }
  }
});

test("«Quitar la medida» leaves the goal measuring nothing, with «Ponerle medida» offered, no rhythm and no amounts (RP-127, RP-134)", async ({ person, browser, baseURL, db }) => {
  // Kills: a removal that keeps the rhythm or the amounts (a «40 páginas al mes» row on a goal that measures nothing);
  // a screen not refreshed.
  const id = await leer(db, person, 40);
  await budget(db, person, id, thisMonth, 25);
  await budget(db, person, id, monthsAhead(1), 25);
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
  try {
    await page.getByRole("button", { name: CHANGE, exact: true }).click();
    await dialog(page).getByRole("button", { name: REMOVE_MEASURE, exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText("esta meta no mide nada", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ponerle medida", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /al mes/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: CHANGE, exact: true })).toHaveCount(0);
    expect(await measureOf(db, id)).toEqual({ name: null, unit: null, rhythm: null });
    expect(await rowsOf(db, "month_budgets", id)).toBe(0);
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Rhythm
// ---------------------------------------------------------------------------------------------------------------

async function monthRows(page: Page): Promise<Map<string, string>> {
  const texts = await page.locator("main ol li:visible").allInnerTexts();
  return new Map(texts.map((text) => [text.replace(/\s+/g, " ").trim().split(" ").slice(0, 2).join(" "), text.replace(/\s+/g, " ").trim()]));
}

test("removing a rhythm in a unit other than time: the sheet says the closed months keep their plan, the offer returns, and «Por mes» reads the closed month as before (RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: skipping the freeze of the closed months (last month would lose its «40» and read «sin monto»), or keeping
  // the rhythm for the months to come.
  const id = await seedOpenGoal(db, person, {
    name: "Leer",
    unit: { measure: "Páginas leídas", unit: "páginas" },
    rhythm: 40,
    horizon: monthsAhead(5),
    created: new Date(`${lastMonth}T12:00:00Z`),
  });
  const last = monthLabel(lastMonth);
  const later = monthLabel(monthsAhead(2));
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}/meses`);
  let before: string;
  try {
    const rows = await monthRows(page);
    before = rows.get(last)!;
    expect(before).toContain("40");
    expect(rows.get(later)).toContain("40");
    await visit(page, `/metas/${id}`);
    await page.getByRole("button", { name: /40 páginas al mes/ }).click();
    const sheet = dialog(page);
    await expect(sheet.getByText(BODY_OTHER, { exact: true })).toBeVisible();
    await expect(sheet.getByText(BODY_PLAN, { exact: true })).toHaveCount(0);
    await sheet.getByRole("button", { name: REMOVE_RHYTHM, exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Poner un ritmo/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /40 páginas al mes/ })).toHaveCount(0);
    expect(await rhythmOfGoal(db, id)).toBeNull();

    await visit(page, `/metas/${id}/meses`);
    const after = await monthRows(page);
    expect(after.get(last)).toBe(before);
    expect(after.get(later) ?? "").not.toContain("40");
  } finally {
    await context.close();
  }
});

test("«Quitar el ritmo» pends with both buttons disabled and a second tap sends nothing more (RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: dropping `pending` from the removal (two removals, one freezing over the other).
  const id = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, rhythm: 40, horizon: monthsAhead(5), created: DAY_BACK(3) });
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}`);
  try {
    const posts = postCounter(page);
    await page.getByRole("button", { name: /40 páginas al mes/ }).click();
    const sheet = dialog(page);
    await holdActions(page, 1500);
    const remove = sheet.getByRole("button", { name: REMOVE_RHYTHM, exact: true });
    await remove.click();
    await expect(remove).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Cancelar", exact: true })).toBeDisabled();
    await remove.dispatchEvent("click");
    await expect(dialog(page)).toHaveCount(0);
    expect(posts).toHaveLength(1);
    expect(await rhythmOfGoal(db, id)).toBeNull();
  } finally {
    await context.close();
  }
});

test("cancelling the rhythm sheet closes it, sends nothing and leaves the rhythm; the first rhythm's sheet has no «Quitar el ritmo» (RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: removing on dismiss; offering the removal when there is no rhythm to remove (`initial === null`).
  const set = await seedOpenGoal(db, person, { name: "Leer", unit: PAGES, rhythm: 40, horizon: monthsAhead(5), created: DAY_BACK(3) });
  const none = await seedOpenGoal(db, person, { name: "Escribir", unit: PAGES, horizon: monthsAhead(5), created: DAY_BACK(3) });
  const a = await open(browser, baseURL, person, `/metas/${set}`);
  try {
    const posts = postCounter(a.page);
    await a.page.getByRole("button", { name: /40 páginas al mes/ }).click();
    await expect(dialog(a.page).getByRole("button", { name: REMOVE_RHYTHM, exact: true })).toBeVisible();
    await dialog(a.page).getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect(dialog(a.page)).toHaveCount(0);
    expect(posts).toEqual([]);
    expect(await rhythmOfGoal(db, set)).toBe(40);
    await expect(a.page.getByRole("button", { name: /40 páginas al mes/ })).toBeVisible();
  } finally {
    await a.context.close();
  }
  const b = await open(browser, baseURL, person, `/metas/${none}`);
  try {
    await b.page.getByRole("button", { name: /Poner un ritmo/ }).click();
    await expect(dialog(b.page).getByRole("heading")).toBeVisible();
    await expect(dialog(b.page).getByRole("button", { name: REMOVE_RHYTHM, exact: true })).toHaveCount(0);
  } finally {
    await b.context.close();
  }
});

test("removing the rhythm of a goal in time: the plan's sheet says the tasks lose their month, and after it the plan reads «sin mes todavía» (RP-50, RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: the plan screen's sheet lacking the removal; `removeBodyPlan` swapped for the other unit's sentence; tasks that
  // keep a month after the rhythm is gone.
  const id = await seedOpenGoal(db, person, { name: "Estudio", unit: MINUTES, rhythm: 1200, horizon: monthsAhead(5), created: DAY_BACK(3) });
  await seedTask(db, person, id, "Capítulo uno", true);
  const { page, context } = await open(browser, baseURL, person, `/metas/${id}/plan`);
  try {
    await expect(page.getByText("tareas, sin mes todavía", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /Ritmo 20 h al mes/ }).click();
    const sheet = dialog(page);
    await expect(sheet.getByText(BODY_PLAN, { exact: true })).toBeVisible();
    await expect(sheet.getByText(BODY_OTHER, { exact: true })).toHaveCount(0);
    await sheet.getByRole("button", { name: REMOVE_RHYTHM, exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByText("Dile al plan cuántas horas al mes le das a esta meta, y él pone cada tarea en su mes.")).toBeVisible();
    await expect(page.getByText("tareas, sin mes todavía", { exact: true })).toBeVisible();
    await expect(page.getByText("Capítulo uno", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Ritmo 20 h al mes/ })).toHaveCount(0);
    expect(await rhythmOfGoal(db, id)).toBeNull();
  } finally {
    await context.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------------------------------------------

test("an open goal's phase row opens its form; an ended goal's row does not (RP-127)", async ({ person, browser, baseURL, db }) => {
  // Kills: a phase row left `disabled`; linking the rows of an ended goal.
  const openedAt = DAY_BACK(14);
  const span = weeksToPhaseSpan(civilDateInZone(openedAt), 1, 2, null);
  const live = await seedOpenGoal(db, person, { name: "Viva", unit: null, horizon: null, created: openedAt });
  const [phase] = await db<{ id: string }[]>`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${person.id}, ${live}, 'Cimientos vivos', ${span.startsOn}::date, ${span.endsOn}::date) returning id`;
  const ended = await seedOpenGoal(db, person, { name: "Cerrada", unit: null, horizon: civilDateInZone(DAY_BACK(2)), created: DAY_BACK(40) });
  const endedSpan = weeksToPhaseSpan(civilDateInZone(DAY_BACK(40)), 1, 2, null);
  await db`insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
           values (${person.id}, ${ended}, 'Cimientos cerrados', ${endedSpan.startsOn}::date, ${endedSpan.endsOn}::date)`;

  const a = await open(browser, baseURL, person, `/metas/${live}`);
  try {
    await a.page.getByRole("link", { name: /Cimientos vivos/ }).click();
    await expect(a.page).toHaveURL(new RegExp(`/metas/${live}/fases/${phase.id}$`));
    await expect(a.page.locator("main:visible")).toHaveCount(1);
  } finally {
    await a.context.close();
  }
  const b = await open(browser, baseURL, person, `/metas/${ended}`);
  try {
    await expect(b.page.getByText("Cimientos cerrados", { exact: false })).toBeVisible();
    await expect(b.page.getByRole("link", { name: /Cimientos cerrados/ })).toHaveCount(0);
  } finally {
    await b.context.close();
  }
});
