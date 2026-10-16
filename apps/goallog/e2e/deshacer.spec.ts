import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { todayInZone } from "@/lib/zone";

// Each spec seeds its own goal and commitment through the screen — never the
// shared fixture `harness:seed-goal` writes — and drops it by id in `finally`
// (`deleteGoal`'s own cascade). The first round shared `harness:seed-goal`'s
// own commitments across two specs and `workers: 2` raced them: one test's
// `clearFactsFor` deleted the fact the other had just declared.

async function createGoal(page: Page, name: string): Promise<string> {
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(name);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  return page.url().split("/metas/")[1];
}

async function openNewCommitmentForm(page: Page, goalId: string): Promise<void> {
  await page.goto(`/metas/${goalId}`);
  await page.getByRole("link", { name: "Añadir un compromiso" }).click();
  await page.waitForURL(`**/metas/${goalId}/compromisos/nuevo`);
}

// The board's own default cadence and satisfaction (daily, tap): every tap
// test here is about the undo gesture, never about a cadence it does not
// touch.
async function addTapCommitment(page: Page, goalId: string, name: string): Promise<void> {
  await openNewCommitmentForm(page, goalId);
  await page.getByLabel("qué es").fill(name);
  await page.getByRole("button", { name: "Añadirlo" }).click();
  await page.waitForURL(`**/metas/${goalId}`);
}

async function addQuantityCommitment(
  page: Page,
  goalId: string,
  name: string,
  target: number,
  unit: string,
): Promise<void> {
  await openNewCommitmentForm(page, goalId);
  await page.getByLabel("qué es").fill(name);
  await page.getByRole("button", { name: "un número", exact: true }).click();
  await page.getByLabel("cantidad", { exact: true }).fill(String(target));
  await page.getByLabel("unidad").fill(unit);
  await page.getByRole("button", { name: "Añadirlo" }).click();
  await page.waitForURL(`**/metas/${goalId}`);
}

// Deletes the goal and, by `goals_id`'s own cascade, every commitment and
// fact it carried — scoped to this run's own id, never by name (other
// pulsar lanes share this identity).
async function deleteGoal(db: postgres.Sql, personId: string, goalId: string): Promise<void> {
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

async function commitmentId(db: postgres.Sql, personId: string, name: string): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    select id from goals.commitments where user_id = ${personId} and name = ${name}
  `;
  if (!row) throw new Error(`no commitment named "${name}" for ${personId}`);
  return row.id;
}

async function factsFor(
  db: postgres.Sql,
  commitmentId: string,
): Promise<{ id: string; quantity: number | null }[]> {
  return db<{ id: string; quantity: number | null }[]>`
    select id, quantity from goals.facts
    where commitment_id = ${commitmentId} and day = ${todayInZone()}::date
  `;
}

test("a done tap row undoes on its second tap: tap, tap again, tap a third time — one fact, zero, one (RP-05)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Compromiso deshacer ${Date.now()}`;
  const goalId = await createGoal(page, `Meta deshacer ${Date.now()}`);
  await addTapCommitment(page, goalId, name);

  try {
    const id = await commitmentId(db, personId, name);
    await page.goto("/");
    const row = page.locator("button", { hasText: name });

    await row.click();
    await expect(row.locator("svg")).toBeVisible();
    await expect.poll(() => factsFor(db, id).then((rows) => rows.length)).toBe(1);

    await row.click();
    await expect(row.locator("svg")).toHaveCount(0);
    await expect.poll(() => factsFor(db, id).then((rows) => rows.length)).toBe(0);

    await row.click();
    await expect(row.locator("svg")).toBeVisible();
    await expect.poll(() => factsFor(db, id).then((rows) => rows.length)).toBe(1);
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("two rapid taps on an undone row leave exactly one fact (RNP-02's own guard)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Compromiso doble toque ${Date.now()}`;
  const goalId = await createGoal(page, `Meta doble toque ${Date.now()}`);
  await addTapCommitment(page, goalId, name);

  try {
    const id = await commitmentId(db, personId, name);
    await page.goto("/");
    const row = page.locator("button", { hasText: name });

    // The first tap's action is held in flight, so the second tap lands while
    // the row is pending whatever the database's speed. Racing two clicks
    // proved nothing: Playwright's second click waits for the button to be
    // enabled and, on a fast database, undoes the first.
    const actionCalls: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) {
        await route.continue();
        return;
      }
      actionCalls.push(request.url());
      if (actionCalls.length === 1) await held;
      await route.continue();
    });

    await row.click();
    await expect(row).toBeDisabled();
    await expect.poll(() => actionCalls.length).toBe(1);
    await row.click({ force: true });
    release();

    await expect(row.locator("svg")).toBeVisible();
    await expect.poll(() => factsFor(db, id).then((rows) => rows.length)).toBe(1);
    expect(actionCalls).toHaveLength(1);
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("a quantity row shows what was logged, with its note, and undoes from the sheet (RP-04, RP-05)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Compromiso cantidad ${Date.now()}`;
  const goalId = await createGoal(page, `Meta cantidad ${Date.now()}`);
  await addQuantityCommitment(page, goalId, name, 10, "minutos");
  const note = `nota de prueba ${Date.now()}`;
  // Off the 10-minute spread's chips, so the sheet reopens on its own field.
  const chosen = 27;

  try {
    const id = await commitmentId(db, personId, name);
    await page.goto("/");
    const row = page.locator("button", { hasText: name });

    await row.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    await sheet.getByRole("button", { name: "Escribir otra cantidad" }).click();
    await sheet.getByLabel("otro número, en minutos").fill(String(chosen));
    await sheet.getByLabel("Una línea, si quieres").fill(note);
    await sheet.getByRole("button", { name: "Anotar" }).click();
    await expect(sheet).toBeHidden();

    // What was logged, never the plan's own target (RP-04's own "done row").
    await expect(row).toContainText(`${chosen} min`);
    await expect(page.getByText(note)).toBeVisible();
    await expect.poll(() => factsFor(db, id).then((rows) => rows.length)).toBe(1);

    // Reopen: the sheet reads the logged figure and note back, and offers
    // «Deshacer» beside «Cambiar».
    await row.click();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel("otro número, en minutos")).toHaveValue(String(chosen));
    await expect(sheet.getByLabel("Una línea, si quieres")).toHaveValue(note);
    await expect(sheet.getByRole("button", { name: "Cambiar" })).toBeVisible();

    await sheet.getByRole("button", { name: "Deshacer" }).click();
    await expect(sheet).toBeHidden();

    await expect.poll(() => factsFor(db, id).then((rows) => rows.length)).toBe(0);
    await expect(page.getByText(note)).toHaveCount(0);
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("changing a done quantity row's amount replaces the fact, never adds beside it — one row at 30, not two at 25 and 30 (RP-03, the goal total)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Compromiso cambiar ${Date.now()}`;
  const goalId = await createGoal(page, `Meta cambiar ${Date.now()}`);
  // The goal's first quantity commitment names its measure (RP-14): the
  // goal's own total below reads this commitment's unit alone.
  await addQuantityCommitment(page, goalId, name, 10, "minutos");

  try {
    const id = await commitmentId(db, personId, name);
    await page.goto("/");
    const row = page.locator("button", { hasText: name });

    await row.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Escribir otra cantidad" }).click();
    await sheet.getByLabel("otro número, en minutos").fill("25");
    await sheet.getByRole("button", { name: "Anotar" }).click();
    await expect(sheet).toBeHidden();

    // No wait between the close and the reopen: a closed sheet must already
    // stand on a row carrying the fact, and any read here would hide a sheet
    // that reopens stale, as undone.

    // Reopen and change the amount through «Cambiar», the sheet's own
    // primary once a fact already stands for today — never a second
    // `declareFact` beside the first (the defect the validator proved live:
    // 25 and 30 both landing in `goals.facts`, the day reading 30 and the
    // goal reading 55).
    await row.click();
    await expect(sheet).toBeVisible();
    // 25 is one of the 10-minute spread's chips, so the sheet reopens on chips.
    await sheet.getByRole("button", { name: "Escribir otra cantidad" }).click();
    await sheet.getByLabel("otro número, en minutos").fill("30");
    await sheet.getByRole("button", { name: "Cambiar" }).click();
    await expect(sheet).toBeHidden();

    const rows = await factsFor(db, id);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(30);

    await expect(row).toContainText("30 min");

    await page.goto(`/metas/${goalId}`);
    // The goal's total, in hours and minutes (RP-35): the figure reads the
    // one fact, never both summed into «55 min».
    // First of the two: the total, then the month's reached figure under it (RP-28).
    await expect(page.getByText("30 min", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("55 min", { exact: true })).toHaveCount(0);
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});
