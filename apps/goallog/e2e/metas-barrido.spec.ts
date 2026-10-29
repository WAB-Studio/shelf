import type postgres from "postgres";

import { test, expect, visit } from "./fixtures";
import { todayInZone } from "@/lib/zone";

// The sweep of `/metas` and the goal screen (RNP-07, RNP-17).
async function seedGoal(db: postgres.Sql, personId: string, name: string) {
  const [row] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, (current_date + 60), now() - interval '20 days')
    returning id
  `;
  return row.id;
}

async function open(browser: import("@playwright/test").Browser, sessionFile: string, width: number, height: number) {
  const context = await browser.newContext({ storageState: sessionFile, viewport: { width, height } });
  return { context, page: await context.newPage() };
}

test("/metas with no goal draws no eyebrow above its title", async ({ person, browser, db }) => {
  await db`delete from goals.goals where user_id = ${person.id}`;
  const { context, page } = await open(browser, person.sessionFile, 390, 800);
  try {
    await page.goto("/metas");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Todavía no hay metas");
    await expect(page.getByText("metas", { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

for (const width of [360, 1280]) {
  test(`a goal with nothing at ${width}: one solid act, a sentence in Archivo, a refusal in its field`, async ({
    person,
    browser,
    db,
  }) => {
    const goalId = await seedGoal(db, person.id, `Vacía ${Date.now()}`);
    const { context, page } = await open(browser, person.sessionFile, width, 900);
    try {
      await visit(page, `/metas/${goalId}`);
      const solid = (name: string) =>
        page.getByRole("link", { name }).evaluateAll((links) => {
          const link = links[0] as HTMLElement;
          return getComputedStyle(link).backgroundColor;
        });
      const commitment = await solid("Añadir un compromiso");
      expect(commitment).not.toBe("rgba(0, 0, 0, 0)");
      if (width === 360) {
        // From 1024 the phase is a text link; the phone draws the button.
        expect(await solid("Añadir una fase")).not.toBe(commitment);
      } else {
        const link = page.getByRole("link", { name: "Añadir una fase" }).first();
        expect(await link.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("500");
      }
      // The horizon line is a sentence: Archivo, not the figure face.
      const horizon = page.getByText(/semanas? · hasta el/);
      // The custom property is raw text; only a probe resolves it the way the browser writes `fontFamily`.
      const mono = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.fontFamily = "var(--font-mono)";
        document.body.append(probe);
        const resolved = getComputedStyle(probe).fontFamily;
        probe.remove();
        return resolved;
      });
      const family = await horizon.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(mono).toMatch(/mono/i);
      expect(family).not.toBe(mono);

      await page.getByRole("button", { name: "Renombrar" }).first().click();
      const sheet = page.getByRole("dialog");
      await sheet.getByRole("textbox").fill("");
      await sheet.getByRole("button", { name: "Guardarlo" }).click();
      await expect(sheet.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    } finally {
      await context.close();
      await db`delete from goals.goals where user_id = ${person.id}`;
    }
  });
}

test("a goal with no measure at 1280: its month sits in a card and «Ver por mes» is the one link style", async ({
  person,
  browser,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Sin medida ${stamp}`);
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${goalId}, ${`Tarea ${stamp}`}, ${`${todayInZone().slice(0, 7)}-01`}::date)
  `;
  const { context, page } = await open(browser, person.sessionFile, 1280, 900);
  try {
    await page.goto(`/metas/${goalId}`);
    // The count carries a no-break space, so «1» never strands from «tarea» at a line end.
    const line = page.getByText(/^1\u00a0tarea\b/).locator("visible=true");
    await expect(line).toHaveCount(1);
    const inCard = await line.evaluate((el) => {
      for (let node: Element | null = el; node; node = node.parentElement) {
        if (getComputedStyle(node).borderTopWidth !== "0px" && getComputedStyle(node).borderRadius === "14px") return true;
      }
      return false;
    });
    expect(inCard).toBe(true);

    const link = page.getByRole("link", { name: "Ver por mes" });
    const box = await link.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(48);
    expect(await link.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("500");
    await link.hover();
    expect(await link.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("underline");
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
