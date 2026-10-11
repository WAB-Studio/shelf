import type postgres from "postgres";

import { dayBefore, weekIndexOf } from "@/lib/day/weeks";
import { addWeeksToCivilDate, civilDateInZone, civilDateLabel, todayInZone, weekOf } from "@/lib/zone";

import { test, expect } from "./fixtures";

// RP-27, RP-25: a goal whose horizon has arrived says it ended, offers to
// move the end or archive it, and adds nothing. `createGoal` refuses such a
// horizon, so the goal is seeded by SQL under this spec's own identity and
// deleted by id in `finally`.

const DAY_MS = 86_400_000;

async function seedEnded(
  db: postgres.Sql,
  personId: string,
  name: string,
): Promise<{ goalId: string; openedOn: string }> {
  const createdAt = new Date(Date.now() - 20 * DAY_MS);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${todayInZone()}, ${createdAt})
    returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${personId}, ${goal.id}, 'Compromiso terminado', 'daily', 'tap')
  `;
  return { goalId: goal.id, openedOn: civilDateInZone(createdAt) };
}

async function horizonOf(db: postgres.Sql, goalId: string): Promise<string> {
  const [row] = await db<{ horizon: string }[]>`
    select horizon::text as horizon from goals.goals where id = ${goalId}
  `;
  return row.horizon;
}

test("an ended goal reads «terminó el» and yesterday, offers both acts and neither «Añadir» (RP-27)", async ({
  page,
  db,
  personId,
}) => {
  const { goalId } = await seedEnded(db, personId, `Meta terminada ${Date.now()}`);
  try {
    await page.goto(`/metas/${goalId}`);
    // «terminó el lunes 28 de septiembre»: weekday, day and month, no comma.
    const yesterday = new Intl.DateTimeFormat("es-CO", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).formatToParts(new Date(`${dayBefore(todayInZone())}T12:00:00Z`));
    const part = (type: string) => yesterday.find((p) => p.type === type)!.value;
    await expect(
      page.getByText(`terminó el ${part("weekday")} ${part("day")} de ${part("month")} de ${part("year")}`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/semanas? · hasta el /)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "mover el final", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Archivar", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Añadir un compromiso" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Añadir una fase" })).toHaveCount(0);
    await expect(page.getByText("Compromiso terminado")).toBeVisible();
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("moving the end of an ended goal opens on a count that ends this Sunday and brings it back (RP-25)", async ({
  page,
  db,
  personId,
}) => {
  const { goalId, openedOn } = await seedEnded(db, personId, `Meta mover ${Date.now()}`);
  try {
    await page.goto(`/metas/${goalId}`);
    await page.getByRole("button", { name: "mover el final", exact: true }).click();
    const sheet = page.getByRole("dialog");
    const field = sheet.getByLabel(/^semanas, contando la del /i);
    const weeks = weekIndexOf(openedOn, todayInZone());
    await expect(field).toHaveValue(String(weeks));
    const sunday = weekOf(todayInZone())[6];
    await expect(sheet.getByText(`termina el ${civilDateLabel(sunday, true)}`)).toBeVisible();

    await sheet.getByRole("button", { name: "Moverlo" }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByText(/^terminó el /)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Añadir un compromiso" })).toBeVisible();
    expect(await horizonOf(db, goalId)).toBe(addWeeksToCivilDate(weekOf(todayInZone())[0], 1));
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("archiving an ended goal moves it to «Archivadas» (RP-24)", async ({ page, db, personId }) => {
  const name = `Meta archivar ${Date.now()}`;
  const { goalId } = await seedEnded(db, personId, name);
  try {
    await page.goto(`/metas/${goalId}`);
    await page.getByRole("button", { name: "Archivar", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Archivarla" }).click();
    await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Mover el final" })).toHaveCount(0);

    await page.goto("/metas");
    const archived = page.locator("section", { hasText: "Archivadas" });
    await expect(archived.getByRole("link", { name })).toBeVisible();
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("an archived goal keeps «Reabrir» and nothing else: no «Renombrar», no «Archivar» (RP-24)", async ({
  page,
  db,
  personId,
}) => {
  const { goalId } = await seedEnded(db, personId, `Meta archivada ${Date.now()}`);
  await db`update goals.goals set archived_at = now() where id = ${goalId}`;
  try {
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/metas/${goalId}`);
      await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Renombrar" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Archivar/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /mover el final/i })).toHaveCount(0);
    }
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});
