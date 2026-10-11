import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";

// `MesesListaDetalle.dc.html` (RP-32, RNP-17): the goal's months
// beside the open month keep the list at 320px. «sin monto» there reads on
// whole words at every width; at 1024 it may wrap and the chevron stays in its
// row, at 360 and from 1280 it keeps one line (826, decision 4).

const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));

for (const width of [360, 1280, 1440]) {
  test(`at ${width}px «sin monto» in the months list is one line and no note is narrower than its longest word (RP-32)`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
      values (${person.id}, ${`Meta angosta ${width} ${Date.now()}`}, ${thisMonth}::date + 62, 'minutos', 'minutos', (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
      returning id
    `;
    // A past month with reached time: the long figure is what squeezes the note.
    const [done] = await db<{ id: string }[]>`
      insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
      values (${person.id}, ${goal.id}, 'Hecha', ${lastMonth}::date, 6000) returning id
    `;
    await db`
      insert into goals.facts (user_id, goal_id, one_off_id, day)
      values (${person.id}, ${goal.id}, ${done.id}, ${lastMonth}::date + 14)
    `;
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/metas/${goal.id}/meses`);
      const notes = page.locator("main li span").filter({ hasText: /^sin monto$/ });
      await expect(notes.first()).toBeVisible();

      const measures = await notes.evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          // The same span with its words on one line: the height one line takes.
          const probe = node.cloneNode(true) as HTMLElement;
          probe.style.whiteSpace = "nowrap";
          probe.style.visibility = "hidden";
          node.after(probe);
          const { height: oneLine } = probe.getBoundingClientRect();
          probe.remove();
          const mono = document.createElement("span");
          mono.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
          mono.style.font = style.font;
          mono.style.letterSpacing = style.letterSpacing;
          mono.textContent = "monto";
          document.body.append(mono);
          const word = mono.getBoundingClientRect().width;
          mono.remove();
          const box = node.getBoundingClientRect();
          return { height: box.height, line: oneLine, width: box.width, word };
        }),
      );
      expect(measures.length).toBeGreaterThan(0);
      for (const m of measures) {
        expect(m.height).toBeLessThanOrEqual(m.line + 1);
        expect(m.width).toBeGreaterThanOrEqual(m.word - 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    } finally {
      await context.close();
    }
  });
}

test("at 1024px «sin monto» of a time goal may wrap: every chevron stays inside its row and no word is split (826)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${`Meta angosta 1024 ${Date.now()}`}, ${thisMonth}::date + 62, 'minutos', 'minutos', (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goal.id}, 'Hecha', ${lastMonth}::date, 6000) returning id
  `;
  await db`
    insert into goals.facts (user_id, goal_id, one_off_id, day)
    values (${person.id}, ${goal.id}, ${done.id}, ${lastMonth}::date + 14)
  `;
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(`/metas/${goal.id}/meses`);
    const notes = page.locator("main li span").filter({ hasText: /^sin monto$/ });
    await expect(notes.first()).toBeVisible();

    const rows = await page.locator("main ol > li").evaluateAll((items) =>
      items.map((li) => {
        const box = li.getBoundingClientRect();
        const chevron = li.querySelector("svg")?.getBoundingClientRect();
        return { chevronPast: chevron ? chevron.right - box.right : null };
      }),
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.chevronPast).not.toBeNull();
      expect(row.chevronPast!).toBeLessThanOrEqual(0.5);
    }

    // A wrap falls between words: the note is never narrower than «monto».
    const widths = await notes.evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        const mono = document.createElement("span");
        mono.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
        mono.style.font = style.font;
        mono.style.letterSpacing = style.letterSpacing;
        mono.textContent = "monto";
        document.body.append(mono);
        const word = mono.getBoundingClientRect().width;
        mono.remove();
        return { width: node.getBoundingClientRect().width, word };
      }),
    );
    for (const m of widths) expect(m.width).toBeGreaterThanOrEqual(m.word - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
