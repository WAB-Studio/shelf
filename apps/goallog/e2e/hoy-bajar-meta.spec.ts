import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-148: a quantity written short of its target offers «Anotar y bajar la meta de este día»; taken, the day's
// own target becomes what was done, the row is done and the fact carries it. At the target the offer is absent.

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

test("a short day offers to lower its own target; taken, the row is done and the fact holds 4 (RP-148)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const name = `Correr ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta baja ${stamp}`}, ${plusDays(90)}, now() - interval '10 days') returning id
  `;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goal.id}, ${name}, 'daily', 'quantity', 5, 'km', now() - interval '10 days') returning id
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 390, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const row = page.getByRole("button", { name: new RegExp(`^${name}`) });
    await row.click();
    const sheet = page.getByRole("dialog");
    const lower = sheet.getByRole("button", { name: "Anotar y bajar la meta de este día" });

    // At the target: nothing to lower.
    await sheet.getByRole("radio", { name: "5", exact: true }).or(sheet.getByRole("button", { name: "5", exact: true })).first().click();
    await expect(lower).toHaveCount(0);

    // One short: offered, and taken.
    await sheet.getByRole("radio", { name: "4", exact: true }).or(sheet.getByRole("button", { name: "4", exact: true })).first().click();
    await expect(lower).toBeVisible();
    await lower.click();
    await expect(sheet).toBeHidden();
    await expect(row.locator("[data-part='mark'][data-state]")).toHaveAttribute("data-state", "declared");

    const [fact] = await db<{ quantity: number; day_target: number | null }[]>`
      select quantity, day_target from goals.facts where commitment_id = ${commitment.id} and day = ${todayInZone()}::date`;
    expect([fact.quantity, fact.day_target]).toEqual([4, 4]);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id}`;
  }
});
