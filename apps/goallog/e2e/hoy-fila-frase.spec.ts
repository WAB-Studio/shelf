import { test, expect, visit } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";
import { noonFromToday } from "./reloj";

// A commitment row's second line is a sentence in Archivo whose
// figures and hours are DM Mono, and a pair in one unit says the unit once.

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

for (const width of [390, 1440]) {
  test(`at ${width} a partial row's words are Archivo, its figures and hour DM Mono, the unit said once`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const minutes = `Hablar ${width} ${stamp}`;
    const distance = `Correr ${width} ${stamp}`;
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${`Meta frase ${width} ${stamp}`}, ${plusDays(90)}, now() - interval '40 days') returning id
    `;
    const commit = async (name: string, target: number, unit: string, logged: number) => {
      const [row] = await db<{ id: string }[]>`
        insert into goals.commitments
          (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
        values (${person.id}, ${goal.id}, ${name}, 'daily', 'quantity', ${target}, ${unit}, now() - interval '40 days')
        returning id
      `;
      await db`
        insert into goals.facts (user_id, goal_id, commitment_id, day, quantity, written_at)
        values (${person.id}, ${goal.id}, ${row.id}, ${todayInZone()}::date, ${logged}, ${noonFromToday(0)})
      `;
    };
    await commit(minutes, 10, "min", 5);
    await commit(distance, 90, "kilómetros", 7);

    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      await visit(page, "/");

      const fonts = async (name: string) =>
        page.getByRole("button", { name: new RegExp(`^${name}`) }).evaluate((row) => {
          const sentence = [...row.querySelectorAll("span")].find((el) => /lo dijiste tú/.test(el.textContent ?? "") && el.children.length > 0 && /^(todos los días · )?\d/.test(el.textContent ?? ""))!;
          const family = (el: Element) => getComputedStyle(el).fontFamily;
          return {
            text: sentence.textContent,
            sentence: family(sentence),
            figures: [...sentence.children].map((el) => ({ text: el.textContent, family: family(el) })),
          };
        });

      const km = await fonts(distance);
      expect(km.text).toMatch(/^todos los días · 7 de 90 kilómetros · \d\d:\d\d · lo dijiste tú$/);
      expect(km.sentence).not.toMatch(/mono/i);
      expect(km.figures.map((f) => f.text)).toEqual(["7", "90 kilómetros", expect.stringMatching(/^\d\d:\d\d$/)]);
      for (const figure of km.figures) expect(figure.family).toMatch(/mono/i);

      const min = await fonts(minutes);
      expect(min.text).toMatch(/^todos los días · 5 de 10 min · \d\d:\d\d · lo dijiste tú$/);
      expect(min.sentence).not.toMatch(/mono/i);
      expect(min.figures.map((f) => f.text)).toEqual(["5", "10 min", expect.stringMatching(/^\d\d:\d\d$/)]);
      for (const figure of min.figures) expect(figure.family).toMatch(/mono/i);
    } finally {
      await context.close();
    }
  });
}
