import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `HoyEnParte.dc.html`, `HoyCuentaEnParte.dc.html` (RP-16): a quantity row
// logged under its target draws the half-filled mark, says what was logged,
// opens the number sheet on a tap, and the count names the partial rows.

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

test("a 29 of 30 min row draws the half mark, its meta line and the count «hechos 1 de 3 · 1 en parte», and at 30 the count drops it (RP-16)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const tapDone = `Tocar hecho ${stamp}`;
  const speak = `Hablar ${stamp}`;
  const tapOpen = `Tocar abierto ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta en parte ${stamp}`}, ${plusDays(90)}, now() - interval '40 days') returning id
  `;
  const commit = async (name: string, kind: "tap" | "quantity") => {
    const [row] = await db<{ id: string }[]>`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (
        ${person.id}, ${goal.id}, ${name}, 'daily', ${kind},
        ${kind === "quantity" ? 30 : null}, ${kind === "quantity" ? "min" : null}, now() - interval '40 days'
      ) returning id
    `;
    return row.id;
  };
  const doneId = await commit(tapDone, "tap");
  const speakId = await commit(speak, "quantity");
  await commit(tapOpen, "tap");
  await db`
    insert into goals.facts (user_id, goal_id, commitment_id, day)
    values (${person.id}, ${goal.id}, ${doneId}, ${todayInZone()}::date)
  `;
  const [fact] = await db<{ id: string }[]>`
    insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
    values (${person.id}, ${goal.id}, ${speakId}, ${todayInZone()}::date, 29) returning id
  `;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const row = page.getByRole("button", { name: new RegExp(`^${speak}`) });
    await expect(row).toContainText(/29 de 30 min · \d\d:\d\d · lo dijiste tú/);

    const mark = row.locator("[data-state]");
    await expect(mark).toHaveAttribute("data-state", "partial");
    await expect(mark.locator("svg")).toHaveCount(0);
    const paint = await mark.evaluate((el) => {
      const cs = getComputedStyle(el);
      const probe = document.createElement("i");
      probe.style.color = "var(--pulsar-accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return { image: cs.backgroundImage, ring: cs.boxShadow, accent };
    });
    expect(paint.image).toContain("linear-gradient");
    expect(paint.image).toContain(paint.accent);
    expect(paint.ring).toContain(paint.accent);
    await expect(page.getByRole("button", { name: new RegExp(`^${tapDone}`) }).locator("[data-state]")).toHaveAttribute(
      "data-state",
      "declared",
    );
    await expect(page.getByRole("button", { name: new RegExp(`^${tapOpen}`) }).locator("[data-state]")).toHaveAttribute(
      "data-state",
      "empty",
    );

    // The seeded identity's own goal adds its rows; the partial one is the one named.
    await expect(page.getByText(/^hechos \d+ de \d+ · 1 en parte$/)).toBeVisible();

    // Tapping opens the number sheet like any row that asks a number.
    await row.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");

    // Meeting the target is done: the mark fills and the count loses «en parte».
    await db`update goals.facts set quantity = 30 where id = ${fact.id}`;
    await page.reload();
    await expect(row.locator("[data-state]")).toHaveAttribute("data-state", "declared");
    await expect(page.getByText(/^hechos \d+ de \d+$/)).toBeVisible();
    await expect(page.getByText(/· \d+ en parte/)).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
  }
});
