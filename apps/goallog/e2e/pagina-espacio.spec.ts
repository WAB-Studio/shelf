import type { Page } from "@playwright/test";

import { horizonForWeeks } from "@/lib/day/weeks";
import { civilDateInZone } from "@/lib/zone";

import { test, expect } from "./fixtures";
import { boxOf } from "./box";

// The page's column spaces its children 32 apart (40 from 1024) by
// its own gap, and the header's controls sit on the eyebrow's line.

async function gapAfterHeader(page: Page) {
  return page.locator("main > header:visible").first().evaluate((header) => {
    // A wrapper with `display: contents` has no box: its first child with one is the section.
    let next: Element = header.nextElementSibling!;
    while (next.getBoundingClientRect().height === 0 && next.firstElementChild) next = next.firstElementChild;
    return {
      gap: Math.round(next.getBoundingClientRect().top - header.getBoundingClientRect().bottom),
      rowGap: getComputedStyle(header.parentElement!).rowGap,
    };
  });
}

for (const [width, expected] of [
  [360, 32],
  [1280, 40],
] as const) {
  test(`at ${width} Hoy and a goal leave ${expected} px between the header and the first section`, async ({
    page,
    db,
    personId,
  }) => {
    const createdAt = new Date(Date.now() - 2 * 86_400_000);
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${personId}, ${`Meta espacio ${Date.now()}`}, ${horizonForWeeks(civilDateInZone(createdAt), 12)}, ${createdAt})
      returning id
    `;
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
      values (${personId}, ${goal.id}, 'Compromiso espacio', 'daily', 'tap')
    `;
    try {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ["/", `/metas/${goal.id}`]) {
        await page.goto(path);
        await expect(page.getByText("Compromiso espacio", { exact: true }).first()).toBeVisible();
        const measured = await gapAfterHeader(page);
        expect(measured.rowGap, path).toBe(`${expected}px`);
        // A goal lays out its own columns under its header, so only Hoy's first box is measured.
        if (path === "/") expect(measured.gap, path).toBe(expected);
      }
    } finally {
      await db`delete from goals.goals where id = ${goal.id} and user_id = ${personId}`;
    }
  });
}

// `\w` is ASCII: on a miércoles or a sábado it skips the date and lands on the tally.
const WEEKDAY_DATE = /^(Lunes|Martes|Miércoles|Jueves|Viernes|Sábado|Domingo) \d+ de \p{L}+$/u;
const LONGEST_DATE = "miércoles 30 de septiembre";

// `longest` swaps the date's words in the page, so the line is measured on the
// widest date the app can draw whatever day the suite runs.
for (const width of [360, 390]) {
  for (const longest of [false, true]) {
    test(`Hoy's controls row stands on the eyebrow's line at ${width}, the eyebrow ${longest ? "the longest date" : "today's date"}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 740 });
      await page.goto("/");
      const dateLocator = page.locator("main > header:visible").getByText(WEEKDAY_DATE).first();
      await expect(dateLocator).toBeVisible();
      if (longest) await dateLocator.evaluate((node, text) => void (node.textContent = text), LONGEST_DATE);
      const toggle = (await boxOf(page.getByRole("button", { name: /modo (oscuro|claro)/ })));
      const date = (await boxOf(dateLocator));
      // The toggle and the date share one line, the toggle at its end.
      expect(Math.abs(toggle.y + toggle.height / 2 - (date.y + date.height / 2))).toBeLessThan(6);
      expect(toggle.x).toBeGreaterThan(date.x + date.width);
    });
  }
}

// No screen draws a linked eyebrow yet, so this reads the rule the primitive ships.
async function ruleOf(page: Page, fragment: string) {
  return page.evaluate((needle) => {
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule instanceof CSSStyleRule && rule.selectorText.includes(needle)) {
          return {
            minBlockSize: rule.style.getPropertyValue("min-block-size"),
            marginBlock: rule.style.getPropertyValue("margin-block"),
          };
        }
      }
    }
    return null;
  }, fragment);
}

test("the header's linked eyebrow is a 44 px target", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main > header:visible").first()).toBeVisible();
  const rule = await ruleOf(page, "eyebrowLink");
  expect(rule?.minBlockSize).toBe("44px");
  // The negative margin cancels the 44 px box's excess: the link adds no height to the header.
  expect(rule?.marginBlock).toBe("calc(0.6em - 22px)");
});
