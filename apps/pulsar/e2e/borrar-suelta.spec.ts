import type { Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// The civil day `daysAgo` days before today, in the person's own zone
// (RNP-06) — never Postgres's `current_date` (`compromiso.spec.ts`'s own
// helper, word for word).
function pastDay(daysAgo: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return dateToCivilDate(date);
}

async function oneOffIdByName(db: postgres.Sql, personId: string, name: string): Promise<string | null> {
  const [row] = await db<{ id: string }[]>`
    select id from goals.one_offs where user_id = ${personId} and name = ${name}
  `;
  return row?.id ?? null;
}

async function deleteOneOffsByName(db: postgres.Sql, personId: string, name: string): Promise<void> {
  const rows = await db<{ id: string }[]>`
    select id from goals.one_offs where user_id = ${personId} and name = ${name}
  `;
  if (rows.length > 0) {
    await db`delete from goals.one_offs where id = any(${rows.map((row) => row.id)})`;
  }
}

// The field at the foot of "Sueltas" (RP-19), the one belonging to no goal —
// the one «Escribe una tarea…» field at 360, exactly `suelta.spec.ts`'s own
// way in.
async function addOneOff(page: Page, name: string): Promise<void> {
  await page.goto("/");
  const field = page.getByPlaceholder("Escribe una tarea…");
  await field.fill(name);
  await field.press("Enter");
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
}

test("deleting an undone one-off through the sheet leaves no row in one_offs or facts (RP-22)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta a borrar ${Date.now()}`;
  await deleteOneOffsByName(db, personId, name);

  try {
    await addOneOff(page, name);
    const oneOffId = await oneOffIdByName(db, personId, name);
    expect(oneOffId).not.toBeNull();

    await page.getByRole("button", { name, exact: true }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    await expect(sheet).not.toContainText("¿Borrarla?");

    await sheet.getByRole("button", { name: "Borrar la tarea" }).click();
    await expect(sheet).toContainText("¿Borrarla?");
    await sheet.getByRole("button", { name: "Borrarla" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole("button", { name, exact: true })).toBeHidden();

    const oneOffRows = await db<{ id: string }[]>`select id from goals.one_offs where id = ${oneOffId}`;
    expect(oneOffRows).toHaveLength(0);
    const factRows = await db<{ id: string }[]>`select id from goals.facts where one_off_id = ${oneOffId}`;
    expect(factRows).toHaveLength(0);
  } finally {
    await deleteOneOffsByName(db, personId, name);
  }
});

test("a one-off that already carries a fact is refused on screen, and nothing is deleted (RP-22)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta con hecho ${Date.now()}`;
  await deleteOneOffsByName(db, personId, name);

  try {
    await addOneOff(page, name);
    const oneOffId = await oneOffIdByName(db, personId, name);
    expect(oneOffId).not.toBeNull();

    // `completeOneOff` always writes today's own day (`todayInZone()`), so a
    // one-off still on today's list and already carrying a fact is not a
    // state today's screen reaches through its own field and mark alone
    // (`loadDay` drops a one-off whose fact's day matches today's own
    // query). Seeded directly, on a day before today, for the one thing
    // `deleteOneOff`'s own check has to refuse regardless of how the fact
    // got there: RP-22 says a fact means that day happened.
    await db`
      insert into goals.facts (user_id, one_off_id, day)
      values (${personId}, ${oneOffId}, ${pastDay(1)})
    `;

    await page.getByRole("button", { name, exact: true }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    await sheet.getByRole("button", { name: "Borrar la tarea" }).click();
    await sheet.getByRole("button", { name: "Borrarla" }).click();
    await expect(sheet).toContainText("Eso ya se hizo, y lo hecho no se borra.");
    await expect(sheet).toBeVisible();

    const oneOffRows = await db<{ id: string }[]>`select id from goals.one_offs where id = ${oneOffId}`;
    expect(oneOffRows).toHaveLength(1);
    const factRows = await db<{ id: string }[]>`select id from goals.facts where one_off_id = ${oneOffId}`;
    expect(factRows).toHaveLength(1);
  } finally {
    await deleteOneOffsByName(db, personId, name);
  }
});

test("\"Dejarla\" closes the sheet and leaves the one-off exactly as it was (RP-22)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta a dejar ${Date.now()}`;
  await deleteOneOffsByName(db, personId, name);

  try {
    await addOneOff(page, name);
    const oneOffId = await oneOffIdByName(db, personId, name);

    await page.getByRole("button", { name, exact: true }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();

    await sheet.getByRole("button", { name: "Borrar la tarea" }).click();
    await sheet.getByRole("button", { name: "Dejarla" }).click();
    await expect(sheet).toBeHidden();

    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();

    const oneOffRows = await db<{ id: string }[]>`select id from goals.one_offs where id = ${oneOffId}`;
    expect(oneOffRows).toHaveLength(1);
  } finally {
    await deleteOneOffsByName(db, personId, name);
  }
});

test("tapping the mark still marks a one-off done, and never opens the delete sheet (RP-22)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta a marcar ${Date.now()}`;
  await deleteOneOffsByName(db, personId, name);

  try {
    await addOneOff(page, name);

    const nameButton = page.getByRole("button", { name, exact: true });
    // The row's own wrapper, the nearest ancestor `<div>` — `Row`'s split
    // shape (`components/ui/row.tsx`'s `onLeadingClick`) — scoped so this
    // never picks up another row's mark.
    const rowContainer = nameButton.locator("xpath=ancestor::div[1]");
    const markButton = rowContainer.getByRole("button", { name: "Marcar como hecho" });

    await markButton.click();

    // A snapshot, not a retrying assertion: `completeOneOff` eventually
    // removes this very row (RP-19: "done, it leaves the list"), and with
    // it any sheet mounted beside it — a retrying `toBeHidden()` would still
    // pass on a dialog that opened and was only later unmounted by that
    // removal, never catching the mark's tap opening it in the first place.
    expect(await page.getByRole("dialog").count()).toBe(0);

    // It moves to «hechas hoy», drawn with an undo mark instead: that is what
    // proves the mark's tap finished it rather than reaching the name's act.
    await expect(page.getByRole("button", { name: `Deshacer: ${name}` })).toBeVisible();

    const oneOffId = await oneOffIdByName(db, personId, name);
    expect(oneOffId).not.toBeNull();
    const factRows = await db<{ id: string }[]>`
      select id from goals.facts
      where user_id = ${personId} and one_off_id = ${oneOffId} and day = ${todayInZone()}::date
    `;
    expect(factRows).toHaveLength(1);
  } finally {
    await deleteOneOffsByName(db, personId, name);
  }
});
