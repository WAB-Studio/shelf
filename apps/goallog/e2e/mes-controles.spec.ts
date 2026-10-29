import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";
import { boxOf } from "./box";

// `MesTodas`, `Mes`, `MesSubtarea` (RP-43, RP-30): the goal's name
// is a heading link in ink with no underline, and every control on a month
// page reaches 44 px on its shorter side at 360.

const today = todayInZone();
const thisMonth = monthOf(today);
const lastMonth = monthOf(dayBefore(thisMonth));
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;
const seg = thisMonth.slice(0, 7);

test("the goal's name in «Mes» is an ink heading link with no underline that opens the goal's month; every control on a month page is 44 px or more at 360, with no sideways scroll (RP-43, RP-30)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta controles ${stamp}`}, ${horizon}::date, 'minutos', 'minutos', (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  await db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${person.id}, ${goal.id}, ${thisMonth}::date, 600)`;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${goal.id}, ${`Padre ${stamp}`}, ${thisMonth}::date)
  `;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goal.id}, ${`Propia ${stamp}`}, ${thisMonth}::date, 60)
  `;

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();

    for (const [width, height] of [
      [390, 844],
      [1280, 800],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto("/mes");
      const link = page.getByRole("heading", { level: 2 }).getByRole("link", { name: `Meta controles ${stamp}` });
      await expect(link).toBeVisible();
      const style = await link.evaluate((el) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--pulsar-ink)";
        document.body.append(probe);
        const ink = getComputedStyle(probe).color;
        probe.remove();
        const cs = getComputedStyle(el);
        return { color: cs.color, ink, line: cs.textDecorationLine };
      });
      expect.soft(style.color, `ink at ${width}`).toBe(style.ink);
      expect.soft(style.line, `no underline at ${width}`).toBe("none");
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/mes");
    await page.getByRole("heading", { level: 2 }).getByRole("link", { name: `Meta controles ${stamp}` }).click();
    await expect(page).toHaveURL(new RegExp(`/metas/${goal.id}/meses/${seg}$`));

    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/metas/${goal.id}/meses/${seg}`);
    await expect(page.getByRole("link", { name: /^Otra tarea de / })).toBeVisible();
    await expect(page.getByRole("link", { name: "Otra sub-tarea" })).toBeVisible();
    await expect(page.getByRole("link", { name: "de 10 h", exact: true })).toBeVisible();
    const sides = await page.evaluate(() =>
      [...document.querySelectorAll("main a, main button")]
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { label: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30), side: Math.min(r.width, r.height) };
        }),
    );
    expect(sides.length).toBeGreaterThan(3);
    expect(sides.filter((s) => s.side < 44), JSON.stringify(sides)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    // The add row is one link the row's full 48 px.
    const add = page.getByRole("link", { name: /^Otra tarea de / });
    expect((await boxOf(add)).height).toBeGreaterThanOrEqual(48);
  } finally {
    await context.close();
  }
});
