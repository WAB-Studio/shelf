import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "../lib/zone";

// The civil day `daysAgo` days before today, in the person's own zone
// (RNP-06) — never Postgres's `current_date`, which the day-after-retire
// specs on another lane are proving wrong against this same clock.
function pastDay(daysAgo: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return dateToCivilDate(date);
}

type CommitmentRow = {
  id: string;
  cadence_kind: string;
  cadence_n: number | null;
  cadence_weekdays: number[] | null;
  satisfaction: string;
  target_quantity: number | null;
  unit: string | null;
  retired_at: string | null;
};

async function commitmentByName(
  db: postgres.Sql,
  personId: string,
  name: string,
): Promise<CommitmentRow | null> {
  const [row] = await db<CommitmentRow[]>`
    select id, cadence_kind, cadence_n, cadence_weekdays, satisfaction,
           target_quantity, unit, retired_at
    from goals.commitments
    where user_id = ${personId} and name = ${name}
  `;
  return row ?? null;
}

// Opens `/metas/nueva`, the least it takes to open a goal (RP-11): the
// horizon field keeps its own board default, only the name is this helper's.
// Lands on the goal's own screen, exactly where `commitment-list.tsx`'s own
// button lives.
async function createGoal(page: Page, name: string): Promise<string> {
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(name);
  await page.getByRole("button", { name: "Abrirla" }).click();
  // A uuid, never `/metas/nueva` itself: that path already matches a bare
  // `[^/]+$`, so `waitForURL` would resolve before the redirect even fires.
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  return page.url().split("/metas/")[1];
}

// The goal's own way in (docs/pulsar/DESIGN.md "A goal adds a commitment from
// its own screen"): a real tap on the list's own button, never a bare
// `page.goto` to the form's route — that route has no other door today.
async function openNewCommitmentForm(page: Page, goalId: string): Promise<void> {
  await page.goto(`/metas/${goalId}`);
  await page.getByRole("link", { name: "Añadir un compromiso" }).click();
  await page.waitForURL(`**/metas/${goalId}/compromisos/nuevo`);
}

// Deletes the goal and, by `goals_id`'s own cascade (db/schema/goals.ts,
// commitments.ts, facts.ts), every commitment and fact it carried — the one
// statement this suite needs to leave no probe behind.
async function deleteGoal(db: postgres.Sql, personId: string, goalId: string): Promise<void> {
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

test("a weekdays commitment with an untyped goal's first quantity lands in goals.commitments and names the goal's measure by its unit (RP-12, RP-14, RP-121)", async ({
  page,
  db,
  personId,
}) => {
  const goalName = `Meta compromiso ${Date.now()}`;
  const commitmentName = `Compromiso días sueltos ${Date.now()}`;
  const goalId = await createGoal(page, goalName);

  try {
    await openNewCommitmentForm(page, goalId);
    await page.getByLabel("qué es").fill(commitmentName);

    await page.getByRole("button", { name: "días sueltos", exact: true }).click();
    // Tuesday and Thursday: two toggles, never one, so the array the row
    // writes is provably the two picked, not a single default.
    await page.getByRole("button", { name: "M", exact: true }).click();
    await page.getByRole("button", { name: "J", exact: true }).click();

    await page.getByRole("button", { name: "un número", exact: true }).click();
    await page.getByLabel("cantidad", { exact: true }).fill("15");
    await page.getByLabel("unidad").fill("minutos");

    // The goal has no measure yet: this is the note this screen draws only
    // then, and the sentence naming it (RP-14) has to be visible before submit.
    await expect(page.getByText("Esta meta todavía no tiene cifra")).toBeVisible();

    await page.getByRole("button", { name: "Añadirlo" }).click();
    await page.waitForURL(`**/metas/${goalId}`);

    const commitment = await commitmentByName(db, personId, commitmentName);
    expect(commitment).not.toBeNull();
    expect(commitment!.cadence_kind).toBe("weekdays");
    expect(commitment!.cadence_weekdays).toEqual([2, 4]);
    expect(commitment!.satisfaction).toBe("quantity");
    expect(commitment!.target_quantity).toBe(15);
    expect(commitment!.unit).toBe("minutos");

    const [goal] = await db<{ measure_name: string | null; measure_unit: string | null }[]>`
      select measure_name, measure_unit from goals.goals where id = ${goalId}
    `;
    expect(goal.measure_name).toBe("minutos");
    expect(goal.measure_unit).toBe("minutos");
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("a quantity this large is refused on screen, with no navigation and no row written (lib/validation/plan.ts's .max())", async ({
  page,
  db,
  personId,
}) => {
  const goalName = `Meta cantidad imposible ${Date.now()}`;
  const commitmentName = `Compromiso imposible ${Date.now()}`;
  const goalId = await createGoal(page, goalName);

  try {
    const formUrl = `/metas/${goalId}/compromisos/nuevo`;
    await openNewCommitmentForm(page, goalId);
    await page.getByLabel("qué es").fill(commitmentName);
    await page.getByRole("button", { name: "un número", exact: true }).click();
    // Twelve digits: past `integer`'s own ceiling and past the schema's
    // `.max(1_000_000)` alike — the crash this schema now refuses before the
    // request ever reaches `addCommitment`.
    await page.getByLabel("cantidad", { exact: true }).fill("999999999999");
    await page.getByLabel("unidad").fill("unidades");

    await page.getByRole("button", { name: "Añadirlo" }).click();

    await expect(page.getByText("Escribe un número entero entre 1 y 1 000 000.")).toBeVisible();
    expect(page.url()).toContain(formUrl);

    expect(await commitmentByName(db, personId, commitmentName)).toBeNull();
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("retiring a commitment through the sheet sets retired_at, names its done-day count, and the goal's own list reflects it (RP-13)", async ({
  page,
  db,
  personId,
}) => {
  const goalName = `Meta retiro ${Date.now()}`;
  const commitmentName = `Compromiso a retirar ${Date.now()}`;
  const goalId = await createGoal(page, goalName);

  try {
    // The board's own default cadence and satisfaction (daily, tap): this
    // test is about the retire sentence, never about a cadence it does not
    // touch, so nothing else is picked.
    await openNewCommitmentForm(page, goalId);
    await page.getByLabel("qué es").fill(commitmentName);
    await page.getByRole("button", { name: "Añadirlo" }).click();
    await page.waitForURL(`**/metas/${goalId}`);

    const commitment = await commitmentByName(db, personId, commitmentName);
    expect(commitment).not.toBeNull();
    const commitmentId = commitment!.id;

    // Three distinct past days, never today: the day this fact landed on is
    // its own business, and "today" is the one civil day another lane's
    // fix still owns (the evening "asks tomorrow" defect never enters here —
    // this only reads a plain count of distinct days already declared).
    for (const daysAgo of [1, 2, 3]) {
      await db`
        insert into goals.facts (user_id, commitment_id, goal_id, day)
        values (${personId}, ${commitmentId}, ${goalId}, ${pastDay(daysAgo)})
      `;
    }

    await page.reload();
    const row = page.locator("button", { hasText: commitmentName });
    await row.click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("3 días");

    await sheet.getByRole("button", { name: "Retirarlo" }).click();
    await expect(sheet).toBeHidden();

    await expect(row).toContainText("retirado");
    await expect(row).toBeDisabled();

    const retired = await commitmentByName(db, personId, commitmentName);
    expect(retired!.retired_at).not.toBeNull();
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("a goal with no commitment yet draws its own way in solid, the one thing the screen asks for (docs/pulsar/DESIGN.md)", async ({
  page,
  db,
  personId,
}) => {
  const goalName = `Meta vacía ${Date.now()}`;
  const goalId = await createGoal(page, goalName);

  try {
    const link = page.getByRole("link", { name: "Añadir un compromiso" });
    await expect(link).toBeVisible();
    await expect(link).toHaveClass(/\bsolid\b/);
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});

test("a goal that already carries a commitment draws its own way in outlined, not the only thing left to do", async ({
  page,
  db,
  personId,
}) => {
  const goalName = `Meta con compromiso ${Date.now()}`;
  const commitmentName = `Compromiso ya puesto ${Date.now()}`;
  const goalId = await createGoal(page, goalName);

  try {
    await openNewCommitmentForm(page, goalId);
    await page.getByLabel("qué es").fill(commitmentName);
    await page.getByRole("button", { name: "Añadirlo" }).click();
    await page.waitForURL(`**/metas/${goalId}`);

    const link = page.getByRole("link", { name: "Añadir un compromiso" });
    await expect(link).toBeVisible();
    await expect(link).toHaveClass(/\boutline\b/);
  } finally {
    await deleteGoal(db, personId, goalId);
  }
});
