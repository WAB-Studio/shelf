import { test, expect } from "./fixtures";
import { todayInZone } from "@/lib/zone";

// A row wraps by word (RNP-07): a name never breaks inside a word,
// a phrase in `trailing` keeps its longest word whole on one line, and no row
// overflows at 360px. Meta's commitment rows carry the case: «conversaciones».
// The 26-character unit exists because the old 45 % cap on `trailing` bites only
// a word wider than 45 % of the row. A trailing block that cannot sit beside the
// name's longest word drops under it, one line, start-aligned; a short one stays.

const today = todayInZone();
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;

test("on Meta at 360 a commitment's «conversaciones» sits whole on one line and no row overflows", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta ajuste ${stamp}`}, ${horizon}::date, now() - interval '3 days') returning id
  `;
  await db`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goal.id}, ${`Conversaciones de práctica con hablantes nativos ${stamp}`},
            'daily', 'quantity', 15, 'conversaciones', now() - interval '3 days')
  `;
  await db`
    insert into goals.commitments
      (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goal.id}, ${`Autoconversacionesdiarias ${stamp}`},
            'daily', 'quantity', 4, 'microconversacionesdiarias', now() - interval '3 days')
  `;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto(`/metas/${goal.id}`);
    for (const unit of ["conversaciones", "microconversacionesdiarias"]) {
      // The unit is its own quiet span inside the mono figure (369).
      const phrase = page.getByText(unit, { exact: true }).first();
      await expect(phrase).toBeVisible();
      const word = await phrase.evaluate((el, unit) => {
        const node = el.firstChild as Text;
        const start = (node.textContent ?? "").indexOf(unit);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + unit.length);
        const box = el.parentElement!.parentElement!.parentElement!.parentElement!.getBoundingClientRect();
        const rect = range.getBoundingClientRect();
        console.log(JSON.stringify({ l: rect.left, r: rect.right, bl: box.left, br: box.right, w: window.innerWidth }));
        return { lines: range.getClientRects().length, inside: rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 };
      }, unit);
      expect([word.lines, word.inside]).toEqual([1, true]);
    }

    const place = async (name: RegExp, trailing: RegExp) =>
      page.evaluate(
        ({ name, trailing }) => {
          const find = (source: string) =>
            Array.from(document.querySelectorAll("span")).find(
              (el) => el.children.length <= 1 && new RegExp(source).test(el.textContent ?? ""),
            )!;
          const n = find(name).getBoundingClientRect();
          const t = find(trailing).getBoundingClientRect();
          return { below: t.top >= n.bottom - 0.5, beside: t.top < n.bottom - 0.5, oneLine: t.height < 24 };
        },
        { name: name.source, trailing: trailing.source },
      );
    const dropped = await place(/^Autoconversacionesdiarias/, /^4\smicroconversacionesdiarias$/);
    expect([dropped.below, dropped.oneLine]).toEqual([true, true]);
    const stays = await place(/^Conversaciones de práctica/, /^15\sconversaciones$/);
    expect([stays.beside, stays.oneLine]).toEqual([true, true]);

    const overflowing = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button, a"))
        .filter((el) => el.scrollWidth > el.clientWidth + 0.5)
        .map((el) => (el.textContent ?? "").trim().slice(0, 40)),
    );
    expect(overflowing).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
  }
});
