import type postgres from "postgres";

import { test, expect } from "./fixtures";
import oneOffs from "../messages/es/oneOffs.json";
import roadmap from "../messages/es/roadmap.json";
import { todayInZone } from "@/lib/zone";

// `SueltaHoja` and `SueltaHojaHecha` (RP-57): a suelta's name opens a sheet
// that renames it; the mark still marks and undoes; a done one has no
// «Borrar la tarea»; on `/sueltas` its day is a row inside the sheet.

const WIDTHS = [390, 1440];
const DELETE = roadmap.fijar.delete;

async function seed(db: postgres.Sql, personId: string, name: string, day: string | null, goalId?: string) {
  const [row] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day, goal_id)
    values (${personId}, ${name}, ${day}, ${goalId ?? null}) returning id
  `;
  return row.id;
}

async function nameOf(db: postgres.Sql, id: string) {
  const [row] = await db<{ name: string }[]>`select name from goals.one_offs where id = ${id}`;
  return row.name;
}

for (const width of WIDTHS) {
  test(`Hoy at ${width}: a pending suelta is renamed from its sheet, which never opens «¿Borrarla?» (RP-57, RP-55)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Suelta renombrar ${width} ${Date.now()}`;
    const id = await seed(db, personId, name, todayInZone());
    try {
      await page.goto("/");
      await page.getByRole("button", { name, exact: true }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByRole("heading", { name })).toBeVisible();
      await expect(sheet).toContainText(oneOffs.sheet.eyebrow);
      await expect(sheet).not.toContainText(oneOffs.sheet.eyebrowDone);
      await expect(sheet).not.toContainText("¿Borrarla?");
      await expect(sheet.getByRole("button", { name: DELETE })).toBeVisible();
      await expect(sheet.getByRole("button", { name: oneOffs.sheet.giveDay })).toHaveCount(0);

      await sheet.getByLabel(roadmap.fijar.name).fill(`${name} nueva`);
      await sheet.getByRole("button", { name: roadmap.fijar.save }).click();
      await expect(sheet).toBeHidden();
      expect(await nameOf(db, id)).toBe(`${name} nueva`);
      await expect(page.getByRole("button", { name: `${name} nueva`, exact: true })).toBeVisible();
    } finally {
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });

  test(`Hoy at ${width}: a done suelta's name opens a sheet with no «Borrar» and no day; its mark undoes it (RP-57, RP-22)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Suelta hecha hoja ${width} ${Date.now()}`;
    const id = await seed(db, personId, name, todayInZone());
    try {
      await page.goto("/");
      await page
        .locator("div")
        .filter({ has: page.getByRole("button", { name, exact: true }) })
        .last()
        .getByRole("button", { name: "Marcar como hecho" })
        .click();
      const undo = page.getByRole("button", { name: `Deshacer: ${name}` });
      await expect(undo).toBeVisible();

      await page.getByText(name, { exact: true }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet).toContainText(oneOffs.sheet.eyebrowDone);
      await expect(sheet).toContainText(oneOffs.sheet.doneHint);
      await expect(sheet.getByRole("button", { name: DELETE })).toHaveCount(0);
      await expect(sheet.getByRole("button", { name: oneOffs.sheet.giveDay })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();

      await undo.click();
      await expect(undo).toHaveCount(0);
      await expect.poll(async () => (await db`select id from goals.facts where one_off_id = ${id}`).length).toBe(0);
    } finally {
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });

  test(`Hoy at ${width}: a done suelta is renamed from its sheet and stays done (RP-57)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Suelta hecha renombrar ${width} ${Date.now()}`;
    const renamed = `${name} nueva`;
    const id = await seed(db, personId, name, todayInZone());
    try {
      await page.goto("/");
      await page
        .locator("div")
        .filter({ has: page.getByRole("button", { name, exact: true }) })
        .last()
        .getByRole("button", { name: "Marcar como hecho" })
        .click();
      await expect(page.getByRole("button", { name: `Deshacer: ${name}` })).toBeVisible();

      await page.getByText(name, { exact: true }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet).toContainText(oneOffs.sheet.eyebrowDone);
      await sheet.getByLabel(roadmap.fijar.name).fill(renamed);
      await sheet.getByRole("button", { name: roadmap.fijar.save }).click();
      await expect(sheet).toBeHidden();

      expect(await nameOf(db, id)).toBe(renamed);
      expect((await db`select id from goals.facts where one_off_id = ${id}`).length).toBe(1);
      await expect(page.getByRole("button", { name: `Deshacer: ${renamed}` })).toBeVisible();
    } finally {
      await db`delete from goals.facts where one_off_id = ${id}`;
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });

  test(`Hoy at ${width}: «${roadmap.fijar.cancel}» closes the sheet and writes nothing (RP-57)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Suelta cancelar ${width} ${Date.now()}`;
    const id = await seed(db, personId, name, todayInZone());
    try {
      await page.goto("/");
      await page.getByRole("button", { name, exact: true }).click();
      const sheet = page.getByRole("dialog");
      await sheet.getByLabel(roadmap.fijar.name).fill(`${name} nueva`);
      await sheet.getByRole("button", { name: roadmap.fijar.cancel }).click();
      await expect(sheet).toBeHidden();

      expect(await nameOf(db, id)).toBe(name);
      await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    } finally {
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });

  test(`/sueltas at ${width}: the name opens the sheet and «${oneOffs.sheet.giveDay}» reaches its day (RP-57, W3-Q1)`, async ({
    page,
    db,
    personId,
  }) => {
    await page.setViewportSize({ width, height: width < 1024 ? 800 : 900 });
    const name = `Suelta sin día hoja ${width} ${Date.now()}`;
    const id = await seed(db, personId, name, null);
    try {
      await page.goto("/sueltas");
      await page.getByRole("button", { name, exact: true }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet.getByRole("heading", { name })).toBeVisible();
      await expect(sheet).not.toContainText("¿Borrarla?");
      await sheet.getByRole("button", { name: oneOffs.sheet.giveDay }).click();
      await expect(page.getByRole("dialog")).toContainText(oneOffs.schedule.title);
      await expect(page.getByRole("dialog").getByRole("button", { name: "Borrarla" })).toHaveCount(0);
      await page.getByRole("radio", { name: "hoy" }).click();
      await page.getByRole("button", { name: oneOffs.schedule.confirm }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const [row] = await db<{ day: string }[]>`select day::text as day from goals.one_offs where id = ${id}`;
      expect(row.day).toBe(todayInZone());
    } finally {
      await db`delete from goals.one_offs where id = ${id}`;
    }
  });
}

test("a goal's own dated one-off opens the same sheet, named for its goal, with the name alone (RP-57, W3-Q2)", async ({
  page,
  db,
  personId,
}) => {
  const stamp = Date.now();
  const goalName = `Meta suelta hoja ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${goalName}, (current_date + interval '90 days')::date, now() - interval '3 days')
    returning id
  `;
  const name = `Tarea con día ${stamp}`;
  const id = await seed(db, personId, name, todayInZone(), goal.id);
  try {
    await page.goto("/");
    await page.getByRole("button", { name, exact: true }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText(roadmap.fijar.eyebrow.replace("{goal}", goalName));
    await expect(sheet.getByLabel(roadmap.fijar.estimate)).toHaveCount(0);
    await expect(sheet.getByRole("radiogroup")).toHaveCount(0);
    await sheet.getByLabel(roadmap.fijar.name).fill(`${name} nueva`);
    await sheet.getByRole("button", { name: roadmap.fijar.save }).click();
    await expect(sheet).toBeHidden();
    expect(await nameOf(db, id)).toBe(`${name} nueva`);
  } finally {
    await db`delete from goals.one_offs where id = ${id}`;
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});
