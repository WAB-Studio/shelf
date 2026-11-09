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

test("the field behind the «+» adds a one-off with no browser dialog and no navigation, and its sheet closes (RP-19, RP-154)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Suelta de prueba ${Date.now()}`;
  await deleteOneOffsByName(db, personId, name);

  // `dialog` is the browser's alert or prompt; the sheet is not one.
  let dialogFired = false;
  page.on("dialog", (dialog) => {
    dialogFired = true;
    void dialog.dismiss();
  });

  try {
    await page.goto("/");
    const startingUrl = page.url();

    // At 360 the field is in the sheet the «+» opens (RP-154).
    await page.getByRole("button", { name: "Anotar algo suelto" }).click();
    const field = page.getByPlaceholder("Escribe una tarea…");
    await field.fill(name);
    await field.press("Enter");

    await expect(page.locator("button", { hasText: name })).toBeVisible();
    await expect(field).toBeHidden();

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
