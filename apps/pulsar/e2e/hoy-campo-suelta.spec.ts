import day from "../messages/es/day.json";
import goal from "../messages/es/goal.json";
import { test, expect } from "./fixtures";

// RP-19 on Hoy, RP-20 on the goal: the goal's suelta field fits whole at 1024 (the narrowest width that draws it)
// for a long name (`PalabrasDelPlan`), and a goal with no phase and no
// commitment draws no empty section label yet keeps «Añadir una fase».

const NAME = "Inglés B1/B2 → B2+ laboral";

test("at 1024 the suelta field of a long goal shows its whole placeholder (RP-19)", async ({ person, browser, db }) => {
  const [row] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${person.id}, ${NAME}, '2099-12-31') returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${person.id}, ${row.id}, 'Tocar', 'daily', 'tap')
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width: 1024, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const field = page.getByLabel(day.newOneOff.labelForGoal.replace("{goal}", NAME));
    const placeholder = day.newOneOff.placeholderForGoalShort.replace("{goal}", NAME);
    await expect(field).toHaveAttribute("placeholder", placeholder);
    // Chrome never overflows a placeholder, so measure its text in the input's own font,
    // once the layout has given the field a width and the font has loaded.
    await expect.poll(() => field.evaluate((input: HTMLInputElement) => input.clientWidth)).toBeGreaterThan(0);
    const { text, room } = await field.evaluate(async (input: HTMLInputElement, shown) => {
      await document.fonts.ready;
      const style = getComputedStyle(input);
      const context = document.createElement("canvas").getContext("2d")!;
      context.font = style.font;
      const inner = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { text: context.measureText(shown).width, room: inner };
    }, placeholder);
    expect(text).toBeLessThanOrEqual(room);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${row.id}`;
  }
});

test("a goal with no phase and no commitment draws no empty section label and keeps «Añadir una fase» (RP-20)", async ({
  person,
  browser,
  db,
}) => {
  const [row] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${person.id}, 'Meta vacía', '2099-12-31') returning id
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, viewport: { width: 390, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${row.id}`);
    await expect(page.getByRole("link", { name: goal.phases.add })).toBeVisible();
    await expect(page.getByRole("link", { name: goal.commitments.add })).toBeVisible();
    const empty = await page.locator("main").evaluate((main) =>
      [...main.querySelectorAll('[data-part="section-label"]')].filter((node) => node.textContent?.trim() === "").length,
    );
    expect(empty).toBe(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${row.id}`;
  }
});
