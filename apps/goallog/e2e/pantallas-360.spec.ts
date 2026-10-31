
import type { Browser, Page } from "@playwright/test";
import type postgres from "postgres";

import { test, expect, type Person, openMore } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import plan from "../messages/es/plan.json";

// RNP-07 over every built screen and every sheet: at 360 × 740 (the
// project's own viewport) nothing scrolls sideways, no two controls sit on
// top of each other, and every control's shorter side reaches 32 px.
//
// Named exceptions, and only these:
//   - a control inside a fixed element (the bottom nav) against one outside
//     it is not an overlap: the nav floats over the scroll, never over the
//     layout;
//   - a control that contains another (a row's own wrapper around its mark)
//     is not an overlap with it.
// The 32 px floor has no exception: the mark and the 44 px theme control
// both clear it.
const WIDTH = 360;
const MIN_SIDE = 32;

type Violation = string;

async function measure(page: Page, rootSelector: string | null): Promise<{ count: number; violations: Violation[] }> {
  return page.evaluate(
    ({ rootSelector, width, minSide }) => {
      const root = rootSelector ? document.querySelector(rootSelector) : document;
      const violations: string[] = [];
      const scrollWidth = document.documentElement.scrollWidth;
      if (scrollWidth > width) violations.push(`scrollWidth ${scrollWidth} > ${width}`);
      if (!root) return { count: 0, violations: [`no root ${rootSelector}`] };

      const describe = (el: Element) => {
        const label = el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 30);
        return `${el.tagName.toLowerCase()}[${label}]`;
      };
      const isFixed = (el: Element) => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          if (getComputedStyle(node).position === "fixed") return true;
        }
        return false;
      };

      const controls = Array.from(
        root.querySelectorAll(
          'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"]',
        ),
      )
        .map((el) => ({ el, rect: el.getBoundingClientRect(), style: getComputedStyle(el) }))
        .filter(({ rect, style }) => rect.width > 0 && rect.height > 0 && style.visibility !== "hidden");

      for (const { el, rect } of controls) {
        const side = Math.min(rect.width, rect.height);
        if (side < minSide) {
          violations.push(`${describe(el)} shorter side ${side.toFixed(1)} < ${minSide} (${rect.width.toFixed(1)}x${rect.height.toFixed(1)})`);
        }
        if (rect.right > width + 0.5 || rect.left < -0.5) {
          violations.push(`${describe(el)} leaves the viewport: left ${rect.left.toFixed(1)} right ${rect.right.toFixed(1)}`);
        }
      }
      for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
          const a = controls[i];
          const b = controls[j];
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          if (isFixed(a.el) !== isFixed(b.el)) continue;
          const x = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
          const y = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
          if (x > 0.5 && y > 0.5) {
            violations.push(
              `${describe(a.el)} overlaps ${describe(b.el)} by ${x.toFixed(1)}x${y.toFixed(1)}`,
            );
          }
        }
      }
      return { count: controls.length, violations };
    },
    { rootSelector, width: WIDTH, minSide: MIN_SIDE },
  );
}

// A screen with nothing to measure would pass by proving nothing.
async function expectHolds(page: Page, minControls: number, rootSelector: string | null = null): Promise<void> {
  const { count, violations } = await measure(page, rootSelector);
  expect(count).toBeGreaterThanOrEqual(minControls);
  expect(violations).toEqual([]);
}

async function openSheet(page: Page): Promise<void> {
  const sheet = page.getByRole("dialog");
  await expect(sheet).toBeVisible();
  // Its open animation has run out: a box measured mid-slide is not its own.
  await expect.poll(() => sheet.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
}

function dayFromToday(daysAhead: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + daysAhead);
  return dateToCivilDate(date);
}

const LONG_GOAL = "Meta de medición a 360 con un nombre bastante largo para forzar el ajuste";
const QUANTITY = "Leer páginas del libro con un nombre largo";
const TAP = "Repasar tarjetas";

// Rows are stamped by SQL on the real clock; under PULSAR_CLOCK a commitment
// created «now» would not exist yet on the server's today.
const createdBefore = (daysAgo: number) => new Date(`${dayFromToday(-daysAgo)}T12:00:00-05:00`);

type Seed = { goalId: string; oneOffName: string };

// A goal with a phase, a quantity commitment, a tap commitment and a
// one-off, all under this spec's own identity and gone in `finally`.
async function withSeed(
  db: postgres.Sql,
  personId: string,
  run: (seed: Seed) => Promise<void>,
): Promise<void> {
  const stamp = Date.now();
  const created = createdBefore(7);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${`${LONG_GOAL} ${stamp}`}, ${dayFromToday(90)}, ${created}) returning id
  `;
  const oneOffName = `Suelta de medición ${stamp}`;
  try {
    await db`
      insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
      values (${personId}, ${goal.id}, 'Sostener el ritmo diario sin saltarse ninguno', ${dayFromToday(-7)}, ${dayFromToday(30)})
    `;
    await db`
      insert into goals.commitments
        (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
      values (${personId}, ${goal.id}, ${QUANTITY}, 'daily', 'quantity', 20, 'páginas', ${created})
    `;
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
      values (${personId}, ${goal.id}, ${TAP}, 'daily', 'tap', ${created})
    `;
    await db`insert into goals.one_offs (user_id, name, day) values (${personId}, ${oneOffName}, ${todayInZone()})`;
    await run({ goalId: goal.id, oneOffName });
  } finally {
    await db`delete from goals.one_offs where user_id = ${personId} and name = ${oneOffName}`;
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${personId}`;
  }
}

test("/metas holds at 360 (RNP-07)", async ({ page, db, personId }) => {
  await withSeed(db, personId, async () => {
    await page.goto("/metas");
    await expect(page.getByRole("link", { name: "Abrir otra meta" })).toBeVisible();
    await expectHolds(page, 3);
  });
});

test("/metas/nueva holds at 360 (RNP-07)", async ({ page }) => {
  await page.goto("/metas/nueva");
  await expect(page.getByLabel("nombre")).toBeVisible();
  await expectHolds(page, 3);
});

test("/metas/<id> holds at 360 (RNP-07)", async ({ page, db, personId }) => {
  await withSeed(db, personId, async ({ goalId }) => {
    await page.goto(`/metas/${goalId}`);
    await openMore(page);
    await expect(page.getByRole("button", { name: "Renombrar" })).toBeVisible();
    await expectHolds(page, 6);
  });
});

test("/metas/<id>/compromisos/nuevo holds at 360 (RNP-07)", async ({ page, db, personId }) => {
  await withSeed(db, personId, async ({ goalId }) => {
    await page.goto(`/metas/${goalId}/compromisos/nuevo`);
    await expect(page.getByText("Compromiso nuevo")).toBeVisible();
    await expectHolds(page, 4);
  });
});

test("/metas/<id>/fases/nueva holds at 360 (RNP-07)", async ({ page, db, personId }) => {
  await withSeed(db, personId, async ({ goalId }) => {
    await page.goto(`/metas/${goalId}/fases/nueva`);
    await expect(page.getByText(plan.phaseForm.title)).toBeVisible();
    await expectHolds(page, 3);
  });
});

test("/metas/<id>/revision holds at 360 (RNP-07)", async ({ page, db, personId }) => {
  await withSeed(db, personId, async ({ goalId }) => {
    await page.goto(`/metas/${goalId}/revision`);
    await expect(page.locator("main")).toHaveCount(1);
    await expectHolds(page, 1);
  });
});

test("the not-found holds at 360 (RNP-07)", async ({ page }) => {
  await page.goto("/no-existe");
  await expect(page.getByRole("heading", { name: "Esta página no existe" })).toBeVisible();
  await expectHolds(page, 1);
});

test.describe("signed out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  // Loaded only: never typed into, never submitted — it sends a real email.
  test("/entrar holds at 360, loaded only (RNP-07)", async ({ page }) => {
    await page.goto("/entrar");
    await expect(page.locator("input").first()).toBeVisible();
    await expectHolds(page, 2);
  });
});

test("the quantity sheet holds at 360 (RNP-07)", async ({ page, db, personId }) => {
  await withSeed(db, personId, async () => {
    await page.goto("/");
    await page.locator("button", { hasText: QUANTITY }).click();
    await openSheet(page);
    await expectHolds(page, 3, '[role="dialog"]');
  });
});

test("the retire sheet holds at 360 (RNP-07)", async ({ page, db, personId }) => {
  await withSeed(db, personId, async ({ goalId }) => {
    await page.goto(`/metas/${goalId}`);
    // The row opens the commitment's own screen, whose «Retirarlo o borrarlo» opens the sheet.
    await page.locator("main a", { hasText: TAP }).click();
    await page.getByRole("button", { name: "Retirarlo o borrarlo", exact: true }).click();
    await openSheet(page);
    await expectHolds(page, 2, '[role="dialog"]');
  });
});

test("the delete-one-off sheet holds at 360 (RNP-07)", async ({ page, db, personId }) => {
  await withSeed(db, personId, async ({ oneOffName }) => {
    await page.goto("/");
    await page.locator("button", { hasText: oneOffName }).click();
    await openSheet(page);
    await expectHolds(page, 2, '[role="dialog"]');
  });
});

test("the rename sheet holds at 360 (RNP-07)", async ({ page, db, personId }) => {
  await withSeed(db, personId, async ({ goalId }) => {
    await page.goto(`/metas/${goalId}`);
    await openMore(page);
    await page.getByRole("button", { name: "Renombrar" }).click();
    await openSheet(page);
    await expectHolds(page, 3, '[role="dialog"]');
  });
});

test("the archive sheet holds at 360 (RNP-07)", async ({ page, db, personId }) => {
  await withSeed(db, personId, async ({ goalId }) => {
    await page.goto(`/metas/${goalId}`);
    await openMore(page);
    await page.getByRole("button", { name: "Archivar esta meta" }).click();
    await openSheet(page);
    await expectHolds(page, 2, '[role="dialog"]');
  });
});

// RNP-17 · RP-59 · RP-27: this slice's new states at 360. A person of their
// own, since an ended goal and a scheduled one-off are states the shared
// identity's siblings would count.
async function withNewStates(
  browser: Browser,
  baseURL: string | undefined,
  person: Person,
  db: postgres.Sql,
  run: (page: Page, seed: { endedId: string; scheduledName: string }) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext({ baseURL, storageState: person.sessionFile });
  const stamp = Date.now();
  const scheduledName = `Programada de medición ${stamp}`;
  const created = new Date(Date.now() - 20 * 86_400_000);
  const [open] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`${LONG_GOAL} ${stamp}`}, ${dayFromToday(90)}, ${created}) returning id
  `;
  const [ended] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta terminada con un nombre bastante largo ${stamp}`}, ${todayInZone()}, ${created}) returning id
  `;
  try {
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
      values (${person.id}, ${ended.id}, ${TAP}, 'daily', 'tap', ${created}),
             (${person.id}, ${open.id}, ${TAP}, 'daily', 'tap', ${created})
    `;
    await db`
      insert into goals.one_offs (user_id, goal_id, name, day)
      values (${person.id}, ${open.id}, ${scheduledName}, ${dayFromToday(2)})
    `;
    await run(await context.newPage(), { endedId: ended.id, scheduledName });
  } finally {
    await context.close();
    await db`delete from goals.one_offs where user_id = ${person.id}`;
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
}

test("the programadas list holds at 360 (RNP-07)", async ({ browser, baseURL, person, db }) => {
  await withNewStates(browser, baseURL, person, db, async (page, { scheduledName }) => {
    await page.goto("/sueltas");
    await expect(page.getByRole("button", { name: new RegExp(`^${scheduledName}`) })).toBeVisible();
    await expectHolds(page, 3);
  });
});

test("an ended goal holds at 360 (RNP-07)", async ({ browser, baseURL, person, db }) => {
  await withNewStates(browser, baseURL, person, db, async (page, { endedId }) => {
    await page.goto(`/metas/${endedId}`);
    await expect(page.getByRole("button", { name: "Renombrar" })).toBeVisible();
    await expectHolds(page, 4);
  });
});

test("/metas with «terminadas» holds at 360 (RNP-07)", async ({ browser, baseURL, person, db }) => {
  await withNewStates(browser, baseURL, person, db, async (page) => {
    await page.goto("/metas");
    await expect(page.getByText("Terminadas", { exact: false }).first()).toBeVisible();
    await expectHolds(page, 3);
  });
});

test("/ holds at 360 (RNP-07)", async ({ page, db, personId }) => {
  await withSeed(db, personId, async () => {
    await page.goto("/");
    await expect(page.getByText(new RegExp(`^${LONG_GOAL}`)).first()).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    await expectHolds(page, 4);
  });
});
