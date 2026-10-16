import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { todayInZone } from "../lib/zone";
import { test, expect, laneNumber } from "./fixtures";
import plan from "../messages/es/plan.json";

// Reused per lane, never one per run (RP-23, RP-24): `goals.goals` grants no
// DELETE (`scripts/check-policies.ts`'s own P37), so a fresh goal every run
// would grow this lane's own count without bound the same way `fases.spec.ts`
// measured before its own fix. Found by this exact marker, scoped to the
// lane's own `personId`; created only the first time this spec ever runs for
// that lane.
function goalMarker(lane: number): string {
  return `Meta archivar · fixture lane ${lane}`;
}

async function createGoal(page: Page, name: string): Promise<string> {
  await page.goto("/metas/nueva");
  await page.getByLabel("nombre").fill(name);
  await page.getByRole("button", { name: "Abrirla" }).click();
  await page.waitForURL(/\/metas\/[0-9a-f-]{36}$/);
  return page.url().split("/metas/")[1];
}

async function findOrCreateGoal(
  page: Page,
  db: postgres.Sql,
  personId: string,
  name: string,
): Promise<string> {
  const [existing] = await db<{ id: string }[]>`
    select id from goals.goals where user_id = ${personId} and name = ${name}`;
  if (existing) return existing.id;
  return createGoal(page, name);
}

async function askToday(db: postgres.Sql, personId: string, goalId: string): Promise<string> {
  // Below 1024px Hoy draws a goal's section only when it asks something
  // today: a daily tap commitment, born days ago, asks.
  const [row] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goalId}, 'Tocar la meta de archivar', 'daily', 'tap', now() - interval '3 days')
    returning id`;
  return row.id;
}

test("renaming a goal on screen reads everywhere: its own screen, Hoy and Semana (RP-23)", async ({
  page,
  db,
  personId,
}) => {
  const lane = laneNumber();
  const marker = goalMarker(lane);
  const goalId = await findOrCreateGoal(page, db, personId, marker);
  // Defensive: a previous run that crashed mid-test could have left the
  // fixture archived or mid-renamed. Every test in this file starts from the
  // one known state its own marker names.
  await db`update goals.goals set archived_at = null, name = ${marker} where id = ${goalId}`;

  const renamed = `${marker} · renombrada ${Date.now()}`;
  const commitmentId = await askToday(db, personId, goalId);

  try {
    await page.goto(`/metas/${goalId}`);
    await page.getByRole("button", { name: "Renombrar" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await sheet.getByLabel("nombre").fill(renamed);
    await sheet.getByRole("button", { name: "Guardarlo" }).click();
    await expect(sheet).toBeHidden();

    await expect(page.getByRole("main").getByText(renamed, { exact: true })).toBeVisible();

    await page.goto("/");
    await expect(page.getByRole("main").getByText(renamed, { exact: true })).toBeVisible();

    await page.goto("/semana");
    // A goal that asks today heads the wide table (hidden on a phone) and its
    // folded group: the heading is the one drawn at every width.
    await expect(page.getByRole("main").getByRole("heading", { name: renamed })).toBeVisible();
  } finally {
    await db`delete from goals.commitments where id = ${commitmentId}`;
    // Restored: the marker this spec's own `findOrCreateGoal` looks for on
    // its next run, on this lane or any other.
    await db`update goals.goals set name = ${marker} where id = ${goalId}`;
  }
});

test("archiving a goal drops it from Hoy and Semana, lists it under Archivadas, and keeps its facts (RP-24)", async ({
  page,
  db,
  personId,
}) => {
  const lane = laneNumber();
  const marker = goalMarker(lane);
  const goalId = await findOrCreateGoal(page, db, personId, marker);
  await db`update goals.goals set archived_at = null, name = ${marker} where id = ${goalId}`;

  // Open, before archiving: `listGoalsForMetas` (`lib/queries/goal.ts`)
  // draws the open list in its own «abiertas» `<section>`, never the "Archivadas" one
  // (`app/metas/page.tsx`) — a swapped open/archived split would instead
  // land this goal inside that section while it is still open.
  await page.goto("/metas");
  const openLink = page.getByRole("link", { name: marker });
  await expect(openLink).toBeVisible();
  await expect(openLink.locator("xpath=ancestor::section[.//span[normalize-space()='Archivadas']]")).toHaveCount(0);

  // A fact this goal carries, so "its facts stay" has something real to
  // check — a one-off's, never a commitment's: this goal may or may not
  // carry a commitment depending on which other spec ran against it first,
  // and a one-off never asks for one.
  const [oneOff] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name)
    values (${personId}, ${goalId}, 'hecho de prueba para archivar') returning id`;
  const [fact] = await db<{ id: string }[]>`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${personId}, ${goalId}, ${oneOff.id}, ${todayInZone()}) returning id`;

  try {
    await page.goto(`/metas/${goalId}`);
    await page.getByRole("button", { name: "Archivar esta meta" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Archivarla" }).click();
    await expect(sheet).toBeHidden();

    // The block is gone from its own screen, replaced by the way back in.
    await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Archivar esta meta" })).toHaveCount(0);

    await page.goto("/");
    await expect(page.getByText(marker, { exact: true })).toHaveCount(0);

    await page.goto("/semana");
    await expect(page.getByText(marker, { exact: true })).toHaveCount(0);

    await page.goto("/metas");
    await expect(page.getByText("Archivadas")).toBeVisible();
    // Not just present somewhere on the screen: inside the "Archivadas"
    // `<section>` specifically, never among the open buttons above it — the
    // same split `listGoalsForMetas` draws its two arrays from.
    const archivedLink = page.getByRole("link", { name: marker });
    await expect(archivedLink).toBeVisible();
    const archivedSection = archivedLink.locator("xpath=ancestor::section[1]");
    await expect(archivedSection).toHaveCount(1);
    await expect(archivedSection.getByText("Archivadas")).toBeVisible();

    const stillThere = await db<{ id: string }[]>`select id from goals.facts where id = ${fact.id}`;
    expect(stillThere.length).toBe(1);
  } finally {
    // The one-off and its fact are this test's own; the goal itself stays,
    // reopened for the next run and for the reopen test below.
    await db`delete from goals.facts where id = ${fact.id}`;
    await db`delete from goals.one_offs where id = ${oneOff.id}`;
    await db`update goals.goals set archived_at = null, name = ${marker} where id = ${goalId}`;
  }
});

test("reopening an archived goal through its own screen brings it back to Hoy (RP-24)", async ({
  page,
  db,
  personId,
}) => {
  const lane = laneNumber();
  const marker = goalMarker(lane);
  const goalId = await findOrCreateGoal(page, db, personId, marker);
  // Archived here, bare, so this test proves «Reabrir» itself rather than
  // repeating the archive test above.
  await db`update goals.goals set archived_at = now(), name = ${marker} where id = ${goalId}`;
  const commitmentId = await askToday(db, personId, goalId);

  try {
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();
    await page.getByRole("button", { name: "Reabrir" }).click();

    await expect(page.getByRole("button", { name: "Archivar esta meta" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reabrir" })).toHaveCount(0);

    await page.goto("/");
    await expect(page.getByRole("main").getByText(marker, { exact: true })).toBeVisible();
  } finally {
    await db`delete from goals.commitments where id = ${commitmentId}`;
  }
});

test("an archived goal offers no way to add a phase, direct visit included (RP-24)", async ({
  page,
  db,
  personId,
}) => {
  const lane = laneNumber();
  const marker = goalMarker(lane);
  const goalId = await findOrCreateGoal(page, db, personId, marker);

  try {
    // On its own screen: `goal-screen.tsx` draws no "Añadir una fase" link
    // once archived.
    await db`update goals.goals set archived_at = now(), name = ${marker} where id = ${goalId}`;
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByRole("link", { name: "Añadir una fase" })).toHaveCount(0);

    // Typed straight into the address bar, the door `loadGoal`'s own
    // `archivedAt` guard (`app/metas/[goalId]/fases/nueva/page.tsx`) is what
    // refuses — not merely a link nowhere drawing it. The status itself
    // stays 200 (Next's own streamed shell already committed it, `next/
    // dist/docs/.../not-found.md` "Status codes"); what proves the guard
    // fired is Next's own not-found boundary in the body, the phase form
    // nowhere in it.
    await page.goto(`/metas/${goalId}/fases/nueva`);
    await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
    await expect(page.getByText(plan.phaseForm.title)).toHaveCount(0);
  } finally {
    await db`update goals.goals set archived_at = null, name = ${marker} where id = ${goalId}`;
  }
});

test("an archived goal offers no way to add a commitment, direct visit included (RP-24)", async ({
  page,
  db,
  personId,
}) => {
  const lane = laneNumber();
  const marker = goalMarker(lane);
  const goalId = await findOrCreateGoal(page, db, personId, marker);

  try {
    await db`update goals.goals set archived_at = now(), name = ${marker} where id = ${goalId}`;
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByRole("link", { name: "Añadir un compromiso" })).toHaveCount(0);

    // `listGoals` (`lib/queries/goal.ts`) is this route's own lookup
    // `app/metas/[goalId]/compromisos/nuevo/page.tsx`: open-only, an
    // archived goal is absent from it and `notFound()` fires — read off the
    // body, never the status (see the phase test above).
    await page.goto(`/metas/${goalId}/compromisos/nuevo`);
    await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
    await expect(page.getByText("Compromiso nuevo")).toHaveCount(0);
  } finally {
    await db`update goals.goals set archived_at = null, name = ${marker} where id = ${goalId}`;
  }
});
