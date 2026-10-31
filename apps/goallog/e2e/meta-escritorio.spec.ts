import type { Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import { horizonForWeeks } from "@/lib/day/weeks";
import { civilDateInZone } from "@/lib/zone";

import { test, expect, settled as pageSettled, openMore } from "./fixtures";
import { boxOf as visibleBox } from "./box";

// RNP-17: the goal opens in two columns from 1024 — the commitments left, the
// end, the figure and the phases right — and «Renombrar» and «Archivar» sit
// beside the title. Below 1024 the order is the phone's own.

async function seedGoal(db: postgres.Sql, personId: string, name: string): Promise<string> {
  const createdAt = new Date(Date.now() - 2 * 86_400_000);
  const openedOn = civilDateInZone(createdAt);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, ${name}, ${horizonForWeeks(openedOn, 12)}, ${createdAt})
    returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${personId}, ${goal.id}, 'Compromiso ancho', 'daily', 'tap')
  `;
  await db`
    insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
    values (${personId}, ${goal.id}, 'Fase ancha', ${openedOn}, ${openedOn})
  `;
  return goal.id;
}

// `load` fires with the loading fallback still standing, so a box read
// straight after `goto` measures the skeleton or nothing.
async function settled(page: Page) {
  await expect(page.getByText("Compromiso ancho", { exact: true })).toBeVisible();
  await expect(page.getByText("Fase ancha", { exact: true })).toBeVisible();
  await pageSettled(page);
}

async function boxOf(page: Page, text: string) {
  return page.getByRole("main").getByText(text, { exact: true }).evaluate((el) => {
    const { x, y } = el.getBoundingClientRect();
    return { x, y };
  });
}

test("at 1280 the commitments sit left, the end right and the phases under both, one of each act visible (RNP-17)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Meta ancha ${Date.now()}`;
  const goalId = await seedGoal(db, personId, name);
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/metas/${goalId}`);
    await settled(page);

    const commitment = await boxOf(page, "Compromiso ancho");
    const phase = await boxOf(page, "Fase ancha");
    const end = await page.getByText(/^12 semanas · hasta el /).evaluate((el) => {
      const { x, y } = el.getBoundingClientRect();
      return { x, y };
    });
    // From 1024 the phases stand under both columns.
    expect(phase.x).toBeLessThan(commitment.x + 100);
    expect(end.x).toBeGreaterThan(commitment.x + 300);
    expect(phase.y).toBeGreaterThan(end.y);

    // Each group sits in a bordered white card: commitments, the end, the phases.
    for (const text of ["Compromiso ancho", "Fase ancha", "El final"]) {
      const card = await page.getByText(text, { exact: true }).evaluate((el) => {
        for (let node = el.parentElement; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.borderTopWidth === "1px" && style.borderTopLeftRadius === "14px") {
            return { radius: style.borderTopLeftRadius, padding: style.paddingLeft };
          }
        }
        return null;
      });
      expect(card, text).toEqual({ radius: "14px", padding: "24px" });
    }

    await expect(page.getByRole("button", { name: "Renombrar" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Archivar" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "mover el final" })).toHaveCount(1);
    const title = await boxOf(page, name);
    const rename = await page.getByRole("button", { name: "Renombrar" }).boundingBox();
    expect(rename!.x).toBeGreaterThan(title.x);
    expect(Math.abs(rename!.y - title.y)).toBeLessThan(40);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

// Elements drawing the Panel card: a 1px border with a 14px radius.
async function panelCards(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      [...document.querySelectorAll("body *")].filter((el) => {
        const style = getComputedStyle(el);
        return style.borderTopWidth === "1px" && style.borderTopLeftRadius === "14px";
      }).length,
  );
}

test("at 767 the goal draws no Panel card (RNP-17)", async ({ page, db, personId }) => {
  const goalId = await seedGoal(db, personId, `Meta media ${Date.now()}`);
  try {
    await page.setViewportSize({ width: 767, height: 800 });
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText("Compromiso ancho", { exact: true })).toBeVisible();
    expect(await panelCards(page)).toBe(0);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("at 360 the order is the phone's: commitments, end, phases, then «Archivar esta meta» (RNP-17)", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seedGoal(db, personId, `Meta angosta ${Date.now()}`);
  try {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/metas/${goalId}`);
    await settled(page);

    await openMore(page);
    // Opening the fold scrolls the page: read every place from the document's top.
    const top = (locator: Locator) => locator.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const end = await top(page.getByText(/^12 semanas · hasta el /));
    const commitment = await top(page.getByText("Compromiso ancho", { exact: true }));
    const phase = await top(page.getByText("Fase ancha", { exact: true }));
    const archive = await top(page.getByRole("button", { name: "Archivar esta meta" }));
    // The part a person came for leads: the commitments, then the end, the phases and the foot (`Split`'s `mainFirst`).
    expect(commitment).toBeLessThan(end);
    expect(end).toBeLessThan(phase);
    expect(phase).toBeLessThan(archive);

    expect(await panelCards(page)).toBe(0);
    await expect(page.getByRole("button", { name: "Renombrar" })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

test("at 1280 a goal with no measure draws no empty card (RNP-17)", async ({
  page,
  db,
  personId,
}) => {
  const goalId = await seedGoal(db, personId, `Meta sin cifra ${Date.now()}`);
  await db`delete from goals.phases where goal_id = ${goalId}`;
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/metas/${goalId}`);
    await expect(page.getByText("Cero fases", { exact: true })).toHaveCount(0);
    await expect(page.locator("main")).toHaveCount(1);

    const cards = await page.locator("main").evaluate((main) =>
      Array.from(main.querySelectorAll("*"))
        .filter((el) => {
          const style = getComputedStyle(el);
          return style.borderTopWidth === "1px" && style.borderTopLeftRadius === "14px";
        })
        .map((el) => (el as HTMLElement).innerText.trim()),
    );
    // The end (with «esta meta no mide nada»), the commitments and the phases: a goal with no measure
    // and no task this month draws no month card (RP-73).
    expect(cards).toHaveLength(3);
    for (const text of cards) expect(text).not.toBe("");
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});

// `MetaRiel.dc.html`: the name is the page's one h1, the actions
// sit on its line, and the rail marks this goal.
test("at 1280 and 1440 the goal's name is the one h1, «Renombrar» and «Archivar» sit on its line, the rail marks the goal (RP-23, RNP-16)", async ({
  page,
  db,
  personId,
}) => {
  const name = `Meta encabezado ${Date.now()}`;
  const goalId = await seedGoal(db, personId, name);
  try {
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/metas/${goalId}`);
      await settled(page);

      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      const h1 = page.getByRole("heading", { level: 1, name });
      await expect(h1).toBeVisible();
      const title = (await visibleBox(h1));
      for (const action of ["Renombrar", "Archivar"]) {
        const box = (await visibleBox(page.getByRole("button", { name: action })));
        expect(box.x, action).toBeGreaterThan(title.x);
        const gap = Math.abs(box.y + box.height / 2 - (title.y + title.height / 2));
        expect(gap, action).toBeLessThan(title.height);
      }
      await expect(page.getByRole("link", { name: "Volver a Metas" })).toHaveAttribute("href", "/metas");
      await expect(page.getByRole("navigation").getByRole("link", { name, exact: true })).toHaveAttribute(
        "aria-current",
        "page",
      );
    }
  } finally {
    await db`delete from goals.goals where id = ${goalId} and user_id = ${personId}`;
  }
});
