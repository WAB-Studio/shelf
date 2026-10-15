
import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { weekIndex } from "@/components/goal/phase-weeks";
import { civilDateInZone, dateToCivilDate } from "@/lib/zone";

import { test, expect, laneNumber } from "./fixtures";
import plan from "../messages/es/plan.json";

// Opens `/metas/nueva`, the least it takes to open a goal (RP-11) — the same
// helper `compromiso.spec.ts` and `varias-metas.spec.ts` each keep their own
// copy of, never a shared import: an e2e file owns its own fixtures.
async function createGoal(page: Page, name: string, horizonWeeks?: string): Promise<string> {
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(name);
  if (horizonWeeks) await page.getByLabel("final").fill(horizonWeeks);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  return page.url().split("/metas/")[1];
}

// The goal's own way into a phase (docs/pulsar/DESIGN.md "A goal adds a
// commitment from its own screen" — the same pattern, a phase): a real tap
// on the goal's own button, never a bare `page.goto`.
async function openNewPhaseForm(page: Page, goalId: string): Promise<void> {
  await page.goto(`/metas/${goalId}`);
  await page.getByRole("link", { name: "Añadir una fase" }).click();
  await page.waitForURL(`**/metas/${goalId}/fases/nueva`);
}

async function openNewCommitmentForm(page: Page, goalId: string): Promise<void> {
  await page.goto(`/metas/${goalId}`);
  await page.getByRole("link", { name: "Añadir un compromiso" }).click();
  await page.waitForURL(`**/metas/${goalId}/compromisos/nuevo`);
}

async function phaseCount(db: postgres.Sql, goalId: string): Promise<number> {
  const [row] = await db<{ count: string }[]>`
    select count(*)::text as count from goals.phases where goal_id = ${goalId}
  `;
  return Number(row.count);
}

test("a fresh goal draws its phase way in outlined and its commitment way in solid; the first phase added lists as semanas 1–4 and the day names it", async ({
  person,
  browser,
}) => {

  const context = await browser.newContext({
    storageState: person.sessionFile,
  });
  try {
    const page = await context.newPage();
    const goalName = `Meta fases desechable ${Date.now()}`;
    const aim = `Primer objetivo ${Date.now()}`;
    const goalId = await createGoal(page, goalName);

    // No phase yet: the way in is outlined all the same; on an empty goal the
    // only solid act is «Añadir un compromiso».
    const addPhaseLink = page.getByRole("link", { name: "Añadir una fase" });
    await expect(addPhaseLink).toBeVisible();
    await expect(addPhaseLink).toHaveClass(/\boutline\b/);
    await expect(page.getByRole("link", { name: "Añadir un compromiso" })).toHaveClass(/\bsolid\b/);
    await expect(page.getByText("cero fases")).toHaveCount(0);

    // A goal just opened has nothing before it: the first span defaults to
    // weeks 1–4, counted from its own opening (today).
    await openNewPhaseForm(page, goalId);
    await expect(page.getByLabel("desde la semana")).toHaveValue("1");
    await expect(page.getByLabel("hasta la semana")).toHaveValue("4");
    await page.getByLabel(plan.phaseForm.aimLabel).fill(aim);
    await page.getByRole("button", { name: plan.phaseForm.submit }).click();
    await page.waitForURL(`**/metas/${goalId}`);

    await expect(page.getByText(aim)).toBeVisible();
    await expect(page.getByText("semanas 1–4")).toBeVisible();
    await expect(page.getByText("una fase", { exact: true })).toBeVisible();

    // The day this phase covers names it (RP-15): a goal's own opening day
    // falls in week 1, so today's screen reads this phase's own aim.
    // A goal that asks nothing has no section on the phone (RP-47).
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.getByText(aim)).toBeVisible();
    await page.setViewportSize(viewport!);

    await page.goto(`/metas/${goalId}`);
    await expect(addPhaseLink).toHaveClass(/\boutline\b/);
  } finally {
    await context.close();
  }
});

// `goals.phases` grants no DELETE (`scripts/check-policies.ts`'s own P38):
// a fresh goal every run would grow this lane's own count without bound —
// measured at 30 goals and 24 phases before this fix. One goal is reused
// per lane instead, found by an exact marker in its name, scoped to this
// lane's own `personId`, created only the first time this spec ever runs
// for that lane — with a 500-week horizon, so the one real phase this test
// adds each run (four weeks, right after the last one already there) has
// well over a hundred reruns of headroom before it could ever reach that
// horizon for real; the deliberate horizon-refusal attempt below asks for
// week 501, past it on purpose, and is refused before it ever writes a row.
test("a goal that already has a phase prefills the next span right after it, refuses one that overlaps, and refuses one past its own horizon", async ({
  page,
  db,
  personId,
}) => {
  const lane = laneNumber();
  const goalName = `Meta fases · fixture lane ${lane}`;

  const [existingGoal] = await db<{ id: string }[]>`
    select id from goals.goals where user_id = ${personId} and name = ${goalName}
  `;
  const goalId = existingGoal ? existingGoal.id : await createGoal(page, goalName, "500");

  const before = await phaseCount(db, goalId);

  // Outlined with a phase and without one alike.
  await page.goto(`/metas/${goalId}`);
  const addPhaseLink = page.getByRole("link", { name: "Añadir una fase" });
  await expect(addPhaseLink).toHaveClass(/\boutline\b/);

  // The prefill, proved against the goal's own last phase rather than a
  // hardcoded number: right after it, four weeks long — 1–4 the first time,
  // whatever comes after on every rerun.
  const [openedRow] = await db<{ created_at: Date }[]>`
    select created_at from goals.goals where id = ${goalId}
  `;
  const openedOn = civilDateInZone(openedRow.created_at);
  const [lastPhaseRow] = await db<{ ends_on: Date }[]>`
    select ends_on from goals.phases where goal_id = ${goalId} order by ends_on desc limit 1
  `;
  const expectedFrom = lastPhaseRow ? weekIndex(openedOn, dateToCivilDate(lastPhaseRow.ends_on)) + 1 : 1;
  // 500 weeks of horizon, four weeks a run: proof the lane's own goal has
  // not silently drifted onto the horizon-refusal path this test also
  // exercises on purpose below.
  expect(expectedFrom).toBeLessThan(500);

  await openNewPhaseForm(page, goalId);
  const fromField = page.getByLabel("desde la semana");
  const toField = page.getByLabel("hasta la semana");
  await expect(fromField).toHaveValue(String(expectedFrom));
  const from = Number(await fromField.inputValue());
  const to = Number(await toField.inputValue());
  expect(to).toBeGreaterThanOrEqual(from);

  const aim = `Objetivo lane ${lane} ${Date.now()}`;
  await page.getByLabel(plan.phaseForm.aimLabel).fill(aim);
  await page.getByRole("button", { name: plan.phaseForm.submit }).click();
  await page.waitForURL(`**/metas/${goalId}`);

  await expect(page.getByText(aim)).toBeVisible();
  await expect(page.getByText(`semanas ${from}–${to}`)).toBeVisible();
  expect(await phaseCount(db, goalId)).toBe(before + 1);

  // Overlapping the phase just added: the day would no longer name a single
  // phase, so this is refused on screen, with no navigation and no extra row.
  await openNewPhaseForm(page, goalId);
  await page.getByLabel(plan.phaseForm.aimLabel).fill(`Objetivo solapado ${Date.now()}`);
  await page.getByLabel("desde la semana").fill(String(from));
  await page.getByLabel("hasta la semana").fill(String(to));
  await page.getByRole("button", { name: plan.phaseForm.submit }).click();

  await expect(page.getByText(new RegExp(`ya son de «${aim}»`))).toBeVisible();
  expect(page.url()).toContain(`/metas/${goalId}/fases/nueva`);
  expect(await phaseCount(db, goalId)).toBe(before + 1);

  // Past the goal's own 500-week horizon: refused the same way, never a
  // silent acceptance.
  await openNewPhaseForm(page, goalId);
  await page.getByLabel(plan.phaseForm.aimLabel).fill(`Objetivo tardío ${Date.now()}`);
  await page.getByLabel("desde la semana").fill("501");
  await page.getByLabel("hasta la semana").fill("504");
  await page.getByRole("button", { name: plan.phaseForm.submit }).click();

  await expect(page.getByText(/La meta llega hasta la semana 500, el /)).toBeVisible();
  expect(page.url()).toContain(`/metas/${goalId}/fases/nueva`);
  expect(await phaseCount(db, goalId)).toBe(before + 1);
});

// The goal's own header (`commitment-list.tsx`'s section label) counts what
// is still active, never the whole history the list itself keeps (RP-13):
// no phase involved, so this goal is deleted at the end like `compromiso.
// spec.ts`'s own commitment specs.
test("the goal's own commitment count drops when one is retired, though the row itself stays in the list", async ({
  page,
  db,
  personId,
}) => {
  const goalName = `Meta conteo ${Date.now()}`;
  const commitmentName = `Compromiso a contar ${Date.now()}`;
  const goalId = await createGoal(page, goalName);

  try {
    await openNewCommitmentForm(page, goalId);
    await page.getByLabel("qué es").fill(commitmentName);
    await page.getByRole("button", { name: "Añadirlo" }).click();
    await page.waitForURL(`**/metas/${goalId}`);

    await expect(page.getByText("un compromiso", { exact: true })).toBeVisible();

    const row = page.locator("button", { hasText: commitmentName });
    await row.click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Retirarlo" }).click();
    await expect(sheet).toBeHidden();

    await expect(page.getByText("cero compromisos", { exact: true })).toHaveCount(0);
    await expect(page.getByText("un compromiso", { exact: true })).not.toBeVisible();
    // Retired, never hidden (RP-13): the row itself stays, marked, out of
    // the count above it.
    await expect(row).toContainText("retirado");
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});
