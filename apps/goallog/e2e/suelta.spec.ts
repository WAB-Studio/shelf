import type postgres from "postgres";

import { test, expect } from "./fixtures";
import { todayInZone } from "@/lib/zone";

async function deleteOneOffsByName(db: postgres.Sql, personId: string, name: string): Promise<void> {
  const rows = await db<{ id: string }[]>`
    select id from goals.one_offs where user_id = ${personId} and name = ${name}
  `;
  if (rows.length > 0) {
    await db`delete from goals.one_offs where id = any(${rows.map((row) => row.id)})`;
  }
}

test("the field at the foot of the day adds a one-off with no dialog and no navigation (RP-19)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta de prueba ${Date.now()}`;
  await deleteOneOffsByName(db, personId, name);

  let dialogFired = false;
  page.on("dialog", (dialog) => {
    dialogFired = true;
    void dialog.dismiss();
  });

  try {
    await page.goto("/");
    const startingUrl = page.url();

    // At 360 Hoy has one task field, the one under "Sueltas" (day-screen.tsx).
    const field = page.getByPlaceholder("Escribe una tarea…");
    await field.fill(name);
    await field.press("Enter");

    await expect(page.locator("button", { hasText: name })).toBeVisible();
    await expect(field).toHaveValue("");

    expect(dialogFired).toBe(false);
    expect(page.url()).toBe(startingUrl);

    // `todayInZone()`, never `current_date`: the field writes the Bogotá
    // civil day, and `current_date` renders in the session's own zone (UTC).
    const rows = await db<{ id: string }[]>`
      select id from goals.one_offs
      where user_id = ${personId} and name = ${name} and day = ${todayInZone()}::date
    `;
    expect(rows).toHaveLength(1);
  } finally {
    await deleteOneOffsByName(db, personId, name);
  }
});
