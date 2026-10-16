import { randomUUID } from "node:crypto";

import type { Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import sources from "../messages/es/sources.json";

import { test, expect } from "./fixtures";
import { todayInZone } from "../lib/zone";
import plan from "../messages/es/plan.json";

// ICU's Spanish, never the catalogue's list the screen reads.
function weekLongName(civilDay: string): string {
  const date = new Date(`${civilDay}T12:00:00Z`);
  const weekday = new Intl.DateTimeFormat("es", { weekday: "long", timeZone: "UTC" }).format(date);
  return `${weekday} ${date.getUTCDate()}`;
}

// 23:30 in Bogotá, a fixed -05:00 offset: Colombia keeps no daylight-saving
// time, so this instant is always 04:30 UTC the *next* calendar day
// (docs/TRAPS.md "A timestamptz read as a day lands on tomorrow every
// evening in Bogotá"). `readReadingLookups` has to convert it back to `day`
// through its own `at time zone`, never a bare `::date`, or this whole test
// would see the row on the wrong side of midnight.
function eveningInBogota(day: string): Date {
  return new Date(`${day}T23:30:00-05:00`);
}

type CommitmentRow = { id: string; source_id: string | null; threshold: number | null };

async function commitmentByName(
  db: postgres.Sql,
  personId: string,
  name: string,
): Promise<CommitmentRow | null> {
  const [row] = await db<CommitmentRow[]>`
    select id, source_id, threshold from goals.commitments
    where user_id = ${personId} and name = ${name}
  `;
  return row ?? null;
}

// Same door `compromiso.spec.ts` already opens (RP-11): the horizon field
// keeps its own board default, only the name is this helper's.
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

async function deleteGoal(db: postgres.Sql, personId: string, goalId: string): Promise<void> {
  await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
}

// Inserted over the owner connection (`MIGRATION_DATABASE_URL`, RLS bypassed
// the same way every other probe in this suite writes), under the spec's own
// signed-in identity — a registered harness
// identity may own its own `reading.lookups` rows. One device, one local id
// per row: `lookups`' own primary key is `(user_id, device_id, local_id)`,
// never a surrogate `id` column.
async function insertLookup(
  db: postgres.Sql,
  personId: string,
  deviceId: string,
  localId: number,
  at: Date,
): Promise<void> {
  await db`insert into reading.lookups
    (user_id, device_id, local_id, at, text, normalised, kind, outcome, headword, rule, senses, translation, dictionary_ready, origin, record_schema)
    values (${personId}, ${deviceId}, ${localId}, ${at}, 'evidencia', 'evidencia', 'word', 'miss', null, null, 0, null, true, null, 2)`;
}

// Scoped to the exact device this spec minted — never a blanket delete by
// `personId` alone, and never by any other spec's rows (docs/TRAPS.md "A
// cleanup keyed by a fixture's name deletes every lane's fixtures").
// Idempotent: safe to run once from the test body and again from `finally`.
async function deleteLookups(db: postgres.Sql, personId: string, deviceId: string): Promise<void> {
  await db`delete from reading.lookups where user_id = ${personId} and device_id = ${deviceId}`;
}

async function lookupCountOf(db: postgres.Sql, personId: string): Promise<number> {
  const [row] = await db<{ count: number }[]>`
    select count(*)::int as count from reading.lookups where user_id = ${personId}
  `;
  return row.count;
}

// What the row draws besides its name, whitespace folded: its one meta line.
async function metaOf(row: Locator, name: string): Promise<string> {
  return (await row.innerText()).replace(name, "").replace(/\s+/g, " ").trim();
}

async function factCount(db: postgres.Sql, commitmentId: string): Promise<number> {
  const [row] = await db<{ count: number }[]>`
    select count(*)::int as count from goals.facts where commitment_id = ${commitmentId}
  `;
  return row.count;
}

test("an evidence commitment names diccionario at creation, stays empty below its threshold, marks and names the source at it undoable by nothing, and draws as evidence on /semana (RP-07, RP-08, RP-09)", async ({
  page,
  db,
  personId,
  person,
}) => {
  const goalName = `Meta evidencia ${Date.now()}`;
  const commitmentName = `Compromiso evidencia ${Date.now()}`;
  const day = todayInZone();
  const deviceId = randomUUID();
  const threshold = 2;

  // Two rows on today's evening: the threshold itself. If the first person's
  // evidence ever counted them, its «one fewer» step below would read satisfied.
  const otherRows = threshold;
  // The worker's own person, a harness identity other than the signed-in one.
  const otherId = person.id;
  const otherDevice = randomUUID();
  let goalId: string | undefined;

  try {
    for (let local = 1; local <= otherRows; local++) {
      await insertLookup(db, otherId, otherDevice, local, eveningInBogota(day));
    }
    expect(await lookupCountOf(db, otherId)).toBe(otherRows);

    goalId = await createGoal(page, goalName);
    await openNewCommitmentForm(page, goalId);
    await page.getByLabel("qué es").fill(commitmentName);

    await page.getByRole("button", { name: plan.commitmentForm.satisfaction.evidence, exact: true }).click();
    // The catalogue's one source, read by its own labelKey — never typed
    // here, `sources.json`'s own word.
    await expect(page.getByRole("button", { name: "diccionario", exact: true })).toBeVisible();

    const thresholdField = page.getByLabel(plan.commitmentForm.thresholdLabel);
    await expect(thresholdField).toHaveValue("1");
    await thresholdField.fill(String(threshold));

    await page.getByRole("button", { name: "Añadirlo" }).click();
    await page.waitForURL(`**/metas/${goalId}`);

    // The goal screen's own words for it (`commitment-list.tsx`'s
    // `satisfactionWords`): the threshold just typed, plural, over the
    // source's own name.
    await expect(page.getByText(`${threshold} búsquedas · ${sources.readingLookups}`)).toBeVisible();

    const commitment = await commitmentByName(db, personId, commitmentName);
    expect(commitment).not.toBeNull();
    expect(commitment!.threshold).toBe(threshold);
    expect(commitment!.source_id).not.toBeNull();
    const commitmentId = commitment!.id;

    // Before any lookup: the day's row is empty, names no act (no source
    // text yet), and there is no tap that could write a fact for it — the
    // row is a disabled button, and evidence never reaches `declareFact`
    // regardless (RP-05).
    await page.goto("/");
    const row = page.locator("button", { hasText: commitmentName });
    await expect(row).toBeVisible();
    await expect(row.locator("[data-state]")).toHaveAttribute("data-state", "empty");
    await expect(row).not.toContainText("diccionario");
    expect(await metaOf(row, commitmentName)).toBe(`${threshold} búsquedas`);
    await expect(row).toBeDisabled();
    expect(await factCount(db, commitmentId)).toBe(0);

    // One fewer than the threshold, stamped at 23:30 Bogotá: still empty.
    await insertLookup(db, personId, deviceId, 1, eveningInBogota(day));
    await page.reload();
    await expect(row.locator("[data-state]")).toHaveAttribute("data-state", "empty");
    await expect(row).not.toContainText("diccionario");
    expect(await metaOf(row, commitmentName)).toBe(`${threshold} búsquedas`);

    // The threshold itself, stamped the same evening: the evidence mark
    // (never the declared one), named, and still nothing to undo — the same
    // disabled row, never a second one that appears once satisfied.
    await insertLookup(db, personId, deviceId, 2, eveningInBogota(day));
    await page.reload();
    await expect(row.locator("[data-state]")).toHaveAttribute("data-state", "evidence");
    expect(await metaOf(row, commitmentName)).toBe(`${threshold} búsquedas · ${sources.readingLookups}`);
    await expect(row).not.toContainText("lo dijiste tú");
    await expect(row).not.toContainText("pide el número");
    await expect(row).toBeDisabled();
    expect(await factCount(db, commitmentId)).toBe(0);

    // /semana draws that same day's mark as evidence, named the way
    // `week.mark.evidence` composes it.
    await page.goto("/semana");
    const dot = page.getByRole("img", { name: `${commitmentName}, ${weekLongName(day)}: hecho, por evidencia` });
    await expect(dot).toHaveCount(1);
    await expect(dot).toHaveAttribute("data-state", "evidence");

    // The evidence counted this person's two rows alone, and the second
    // person's rows are exactly what they were before the flow.
    expect(await lookupCountOf(db, personId)).toBe(threshold);
    expect(await lookupCountOf(db, otherId)).toBe(otherRows);
  } finally {
    // Deleted by the exact ids this spec minted — the identity's own purge
    // (`dropRun`, `ON DELETE CASCADE`) is the backstop, not the
    // only door.
    await deleteLookups(db, personId, deviceId);
    if (goalId) await deleteGoal(db, personId, goalId);
    await deleteLookups(db, otherId, otherDevice);
  }
});
