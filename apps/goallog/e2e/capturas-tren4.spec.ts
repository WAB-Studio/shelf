import type { Page } from "@playwright/test";

import dayMessages from "../messages/es/day.json";
import exportMessages from "../messages/es/export.json";
import monthMessages from "../messages/es/month.json";
import roadmap from "../messages/es/roadmap.json";
import { test as base, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// Each test states what the
// board owes the person, at the width the capture was taken.

// `page` carries the suite's seeded person; these tests seed the disposable one.
const test = base.extend<{ mine: Page }>({
  mine: async ({ browser, baseURL, person, viewport }, provide) => {
    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: viewport ?? { width: 390, height: 844 },
      hasTouch: true,
    });
    await provide(await context.newPage());
    await context.close();
  },
});

const today = todayInZone();
const m0 = monthOf(today);
const lastMonth = monthOf(dayBefore(m0));
const horizon = [1, 2, 3, 4, 5, 6].reduce((month) => nextMonth(month), m0);
const stamp = Date.now();
const monthDone = "2 de 3 tareas hechas";
const escaped = monthDone.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Db = import("postgres").Sql;

async function seedPlan(db: Db, personId: string): Promise<string> {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
    values (${personId}, ${`IA aplicada ${stamp}`}, ${horizon}::date, 'estudio', 'minutos', 720, now() - interval '40 days')
    returning id`;
  let position = 0;
  for (const [name, estimate, done] of [
    ["Leer sobre embeddings", 180, true],
    ["Montar el entorno", 120, true],
    ["Proyecto final con RAG", 1800, false],
    ["Curso de LangChain", 1200, false],
    ["Evaluar modelos con un conjunto propio", 900, false],
    ["Informe del proyecto", 600, false],
    ["Revisar los apuntes", null, false],
  ] as const) {
    position += 1;
    const [task] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan)
      values (${personId}, ${goal.id}, ${name}, ${estimate}, ${position}, true) returning id`;
    if (done) {
      await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${personId}, ${goal.id}, ${task.id}, ${today}::date)`;
    }
  }
  return goal.id;
}

async function dropGoals(db: Db, personId: string, ids: string[]) {
  for (const id of ids) {
    await db`delete from goals.facts where goal_id = ${id} and user_id = ${personId}`;
    await db`delete from goals.month_budgets where goal_id = ${id} and user_id = ${personId}`;
    await db`delete from goals.one_offs where goal_id = ${id} and user_id = ${personId}`;
    await db`delete from goals.goals where id = ${id} and user_id = ${personId}`;
  }
}

// How many distinct text lines a range of this element's contents occupies.
function lines(page: Page, selector: string) {
  return page.evaluate((css) => {
    return [...document.querySelectorAll<HTMLElement>(css)].map((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top / 4)));
      return { text: el.textContent ?? "", lines: tops.size };
    });
  }, selector);
}

test.describe("the plan screen at 390 (RoadmapMesCifras, RoadmapMoverFinalFallo)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("A. a month's figure line is a sentence: not caps, not letter-spaced, words in the body face", async ({ mine: page, db, person }) => {
    const goalId = await seedPlan(db, person.id);
    try {
      await page.goto(`/metas/${goalId}/plan`);
      const line = page.locator("main *").filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`, "i") }).last();
      await expect(line).toBeVisible();
      const style = await line.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { transform: cs.textTransform, spacing: cs.letterSpacing, family: cs.fontFamily, size: cs.fontSize, rendered: (el as HTMLElement).innerText };
      });
      expect(style.transform).toBe("none");
      expect(style.spacing).toMatch(/^(normal|0px)$/);
      expect(style.family).not.toMatch(/mono/i);
      expect(style.size).toBe("14px");
      expect(style.rendered).toBe(monthDone);
    } finally {
      await dropGoals(db, person.id, [goalId]);
    }
  });

  test("B. a section header's figure never splits from its unit", async ({ mine: page, db, person }) => {
    const goalId = await seedPlan(db, person.id);
    try {
      await page.goto(`/metas/${goalId}/plan`);
      await expect(page.getByText(roadmap.pasaElFinal.afterEnd, { exact: false }).first()).toBeVisible();
      const figures = await lines(page, "main [data-part='figure']");
      expect(figures.length).toBeGreaterThan(4);
      // Section labels write «48 h» as plain text, not as a Figure: measure it by its characters.
      const plain = await page.evaluate(() => {
        const found: { text: string; lines: number }[] = [];
        const walker = document.createTreeWalker(document.querySelector("main")!, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent ?? "";
          for (const match of text.matchAll(/\d+(?:[.,]\d+)?[ \u00a0]+(?:h|min)(?![\p{L}])/gu)) {
            const range = document.createRange();
            range.setStart(node, match.index!);
            range.setEnd(node, match.index! + match[0].length);
            const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top / 4)));
            found.push({ text: `${text.trim()} → ${match[0]}`, lines: tops.size });
          }
        }
        return found;
      });
      expect(plain.some((f) => /tareas/.test(f.text))).toBe(true);
      const split = [...figures, ...plain].filter((f) => f.lines > 1).map((f) => f.text);
      expect(split).toEqual([]);
    } finally {
      await dropGoals(db, person.id, [goalId]);
    }
  });

  test("C. a failed «Mover el final» says so in a boxed sentence with role=alert", async ({ mine: page, db, person }) => {
    const goalId = await seedPlan(db, person.id);
    try {
      await page.goto(`/metas/${goalId}/plan`);
      await page.getByRole("button", { name: roadmap.moverFinal.title }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await page.route("**/*", (route) => {
        const request = route.request();
        if (request.method() === "POST" && request.headers()["next-action"]) return route.abort("failed");
        return route.continue();
      });
      await dialog.getByRole("button", { name: roadmap.moverFinal.move }).click();
      const alert = dialog.getByRole("alert").filter({ hasText: roadmap.moverFinal.failed });
      await expect(alert).toBeVisible();
      await expect(dialog).toBeVisible();
      const box = await alert.evaluate((el) => {
        const cs = getComputedStyle(el);
        const sheet = getComputedStyle(el.closest("[role=dialog]")!);
        const border = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
        const filled = cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== sheet.backgroundColor;
        return { border, filled, background: cs.backgroundColor, sheetBackground: sheet.backgroundColor };
      });
      expect(box.border || box.filled, JSON.stringify(box)).toBe(true);
    } finally {
      await dropGoals(db, person.id, [goalId]);
    }
  });
});

test("D. Hoy at 390 with three moved plans: «Ver el plan» is one line (RoadmapHoyMovidoVarios)", async ({ mine: page, db, person }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ids: string[] = [];
  try {
    for (const [name, done, big] of [
      ["IA aplicada", 540, 1800],
      ["Inglés B1/B2 → B2+ laboral", 300, 2400],
      ["Curso de piano", 200, 1200],
    ] as const) {
      const [goal] = await db<{ id: string }[]>`
        insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, rhythm, created_at)
        values (${person.id}, ${`${name} ${stamp}`}, ${horizon}::date, 'estudio', 'minutos', 720, '2020-01-01T00:00:00Z')
        returning id`;
      ids.push(goal.id);
      const [first] = await db<{ id: string }[]>`
        insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan, created_at)
        values (${person.id}, ${goal.id}, ${`Hecha ${name}`}, ${done}, 1, true, '2020-01-01T00:00:00Z') returning id`;
      await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goal.id}, ${first.id}, ${lastMonth}::date)`;
      await db`
        insert into goals.one_offs (user_id, goal_id, name, estimate, position, in_plan, created_at)
        values (${person.id}, ${goal.id}, ${`Grande ${name}`}, ${big}, 2, true, '2020-01-02T00:00:00Z')`;
      await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goal.id}, ${lastMonth}::date, 720)`;
    }
    await page.goto("/");
    const links = page.getByRole("link", { name: roadmap.hoyMovido.seePlan });
    await expect(links).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      const link = links.nth(i);
      const { height, lineHeight } = await link.evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      }));
      const rows = await link.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top / 4))).size;
      });
      expect(rows, `«Ver el plan» ${i} (height ${height}, line ${lineHeight})`).toBe(1);
    }
  } finally {
    await dropGoals(db, person.id, ids);
  }
});

test("E. the report's months table in print: «hecho» holds the reached figure alone and «planeado» the plan, both mono and one size", async ({ browser, baseURL, db, person }) => {
  const goalId = await seedPlan(db, person.id);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL!, viewport: { width: 794, height: 1123 } });
  try {
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goalId}, ${lastMonth}::date, 720)`;
    const page = await context.newPage();
    await page.goto("/exportar");
    await expect(page.getByText(/por mes/).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    const cell = await page.evaluate(([doneHeader, plannedHeader]) => {
      const lower = (th: Element) => th.textContent?.trim().toLowerCase();
      const table = [...document.querySelectorAll("table")].find((t) => [...t.querySelectorAll("th")].some((th) => lower(th) === doneHeader));
      if (!table) return null;
      const heads = [...table.querySelectorAll("th")];
      const doneCol = heads.findIndex((th) => lower(th) === doneHeader);
      const plannedCol = heads.findIndex((th) => lower(th) === plannedHeader);
      const figuresOf = (td: Element | undefined) =>
        [...(td?.querySelectorAll<HTMLElement>("[data-part='figure']") ?? [])].map((f) => ({
          size: parseFloat(getComputedStyle(f).fontSize),
          own: getComputedStyle(f).fontFamily,
        }));
      const row = [...table.querySelectorAll("tbody tr")].find(
        (tr) => figuresOf(tr.children[doneCol]).length > 0 && figuresOf(tr.children[plannedCol]).length > 0,
      );
      if (!row) return null;
      const doneCell = row.children[doneCol] as HTMLElement;
      return {
        done: figuresOf(doneCell),
        planned: figuresOf(row.children[plannedCol]),
        doneText: doneCell.textContent ?? "",
      };
    }, [exportMessages.columns.done, exportMessages.columns.planned]);
    expect(cell).not.toBeNull();
    expect(cell!.done).toHaveLength(1);
    expect(cell!.planned).toHaveLength(1);
    expect(cell!.doneText).not.toMatch(/\bde\b/);
    expect(cell!.done[0].size).toBe(cell!.planned[0].size);
    for (const figure of [cell!.done[0], cell!.planned[0]]) expect(figure.own).toMatch(/mono/i);
  } finally {
    await context.close();
    await dropGoals(db, person.id, [goalId]);
  }
});

test.describe("F. a closed month that carried nothing reads «cerrado» alone", () => {
  test.use({ viewport: { width: 390, height: 900 } });
  const zero = /\b0 % pasó/;
  let goalId = "";

  test.beforeEach(async ({ db, person }) => {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${`Meta cerrada ${stamp}`}, ${nextMonth(m0)}::date, 'minutos', 'minutos', (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
      returning id`;
    goalId = goal.id;
    await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goalId}, ${lastMonth}::date, 600)`;
    const [done] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate, in_plan)
      values (${person.id}, ${goalId}, 'Hecha entera', ${lastMonth}::date, 100, true) returning id`;
    await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${goalId}, ${done.id}, ${lastMonth}::date + 14)`;
  });
  test.afterEach(async ({ db, person }) => {
    await dropGoals(db, person.id, [goalId]);
  });

  const body = async (page: Page) => (await page.locator("body").innerText()).replace(/\s+/g, " ");

  test("report on screen", async ({ mine: page }) => {
    await page.goto("/exportar");
    await expect(page.getByText(exportMessages.closed, { exact: true }).first()).toBeVisible();
    expect(await body(page)).not.toMatch(zero);
  });

  test("report in print", async ({ mine: page }) => {
    await page.goto("/exportar");
    await expect(page.getByText(exportMessages.closed, { exact: true }).first()).toBeVisible();
    await page.emulateMedia({ media: "print" });
    expect(await body(page)).not.toMatch(zero);
  });

  test("the goal's Mes page", async ({ mine: page }) => {
    await page.goto(`/metas/${goalId}/meses/${lastMonth.slice(0, 7)}`);
    await expect(page.getByText(monthMessages.list.closed, { exact: true }).first()).toBeVisible();
    expect(await body(page)).not.toMatch(zero);
  });

  test("the goal's Meses list", async ({ mine: page }) => {
    await page.goto(`/metas/${goalId}/meses`);
    await expect(page.getByRole("main").getByText(`Meta cerrada ${stamp}`).first()).toBeVisible();
    // The list's own title, which /metas and the goal's other pages do not draw.
    await expect(page.getByText(monthMessages.months.title, { exact: true }).first()).toBeVisible();
    expect(await body(page)).not.toMatch(zero);
  });

  test("the Mes tab on the closed month", async ({ mine: page }) => {
    await page.goto(`/mes?mes=${lastMonth.slice(0, 7)}`);
    // «Mes» opens the closed month `?mes=` names (RP-142): its heading names that month.
    const closed = dayMessages.monthLong[Number(lastMonth.slice(5, 7)) - 1];
    await expect(page.getByRole("heading", { level: 1, name: new RegExp(`^${closed}( \\d{4})?$`, "i") })).toBeVisible();
    await expect(page.getByRole("main").getByText(`Meta cerrada ${stamp}`).first()).toBeVisible();
    expect(await body(page)).not.toMatch(zero);
  });
});
