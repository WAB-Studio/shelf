import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { todayInZone } from "@/lib/zone";

// Seeded by `harness:seed-goal`: target 10 `minutos`, daily (RP-03).
const QUANTITY_COMMITMENT = "Anki";
const TARGET = 10;
// One of `timeChipsAround(10)`'s own five (`lib/day/time-chips.ts`), never the
// target itself — proves the sheet writes the number picked, not the plan's
// own default.
const CHOSEN = TARGET + 5;

async function commitmentId(db: postgres.Sql, personId: string, name: string): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    select id from goals.commitments
    where user_id = ${personId} and name = ${name} and retired_at is null
  `;
  if (!row) {
    throw new Error(`no commitment named "${name}" for ${personId} — run harness:seed-goal first`);
  }
  return row.id;
}

async function clearFactsFor(db: postgres.Sql, commitmentId: string): Promise<void> {
  // `todayInZone()`, never `current_date`: see `dia.spec.ts`'s own comment.
  const rows = await db<{ id: string }[]>`
    select id from goals.facts where commitment_id = ${commitmentId} and day = ${todayInZone()}::date
  `;
  if (rows.length > 0) {
    await db`delete from goals.facts where id = any(${rows.map((row) => row.id)})`;
  }
}

async function latestQuantity(db: postgres.Sql, commitmentId: string): Promise<number | null> {
  const [row] = await db<{ quantity: number | null }[]>`
    select quantity from goals.facts
    where commitment_id = ${commitmentId} and day = ${todayInZone()}::date
    order by written_at desc
    limit 1
  `;
  return row?.quantity ?? null;
}

test("the quantity sheet writes the chip picked, not the plan's own target (RP-03, RP-04)", async ({
  page,
  db,
  personId,
}) => {
  const id = await commitmentId(db, personId, QUANTITY_COMMITMENT);
  await clearFactsFor(db, id);

  try {
    await page.goto("/");
    const row = page.locator("button", { hasText: QUANTITY_COMMITMENT });
    await row.click();

    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    await sheet.getByRole("button", { name: `${CHOSEN} min`, exact: true }).click();
    await sheet.getByRole("button", { name: "Anotar" }).click();

    await expect(sheet).toBeHidden();
    await expect(row.locator("svg")).toBeVisible();

    expect(await latestQuantity(db, id)).toBe(CHOSEN);
  } finally {
    await clearFactsFor(db, id);
  }
});
