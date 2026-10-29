import { horizonForWeeks } from "@/lib/day/weeks";
import { civilDateInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";

// An archived goal that holds no task this month draws no month
// block, and still offers «Ver por mes».

test("an archived measureless goal with no task this month draws no «0 tareas» line and offers «Ver por mes»", async ({
  page,
  db,
  personId,
}) => {
  const createdAt = new Date(Date.now() - 2 * 86_400_000);
  const openedOn = civilDateInZone(createdAt);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at, archived_at)
    values (${personId}, ${`Meta archivada ${Date.now()}`}, ${horizonForWeeks(openedOn, 12)}, ${createdAt}, now())
    returning id
  `;
  try {
    await page.goto(`/metas/${goal.id}`);
    await expect(page.getByRole("button", { name: "Reabrir" })).toBeVisible();
    await expect(page.getByText(/0 tareas/)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Ver por mes" })).toBeVisible();
  } finally {
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${personId}`;
  }
});
