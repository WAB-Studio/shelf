import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `HoyDia.dc.html`: a row's second line names its days in three
// letters joined as a sentence, and never says «pide el número».

const SHORT = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
const today = todayInZone();
const isoWeekday = ((civilDateToDate(today).getUTCDay() + 6) % 7) + 1;

function plusDays(days: number): string {
  const date = civilDateToDate(today);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

// The sentence of the given ISO weekdays, ascending.
function sentence(weekdays: number[]): string {
  const names = [...weekdays].sort((a, b) => a - b).map((day) => SHORT[day - 1]);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

// Today's weekday plus the next ones, so the row is due today.
const others = (count: number) => Array.from({ length: count }, (_, i) => ((isoWeekday + i) % 7) + 1);

for (const width of [360, 1440]) {
  test(`at ${width}, days read in three letters as a sentence and no row asks «pide el número»`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${`Meta días ${width} ${stamp}`}, ${plusDays(90)}, now() - interval '30 days') returning id
    `;
    const two = [isoWeekday, others(2)[1]];
    const three = [isoWeekday, ...others(3).slice(0, 2)].sort((a, b) => a - b);
    const commit = async (name: string, weekdays: number[], satisfaction: string, target: number | null, unit: string | null) => {
      await db`
        insert into goals.commitments
          (user_id, goal_id, name, cadence_kind, cadence_weekdays, satisfaction, target_quantity, unit, created_at)
        values (${person.id}, ${goal.id}, ${name}, 'weekdays', ${weekdays}, ${satisfaction}, ${target}, ${unit},
                now() - interval '30 days')
      `;
    };
    const twoName = `Dos días ${width} ${stamp}`;
    const threeName = `Tres días ${width} ${stamp}`;
    const allName = `Siete días ${width} ${stamp}`;
    await commit(twoName, two, "quantity", 120, "minutos");
    await commit(threeName, three, "quantity", 5, "km");
    await commit(allName, [1, 2, 3, 4, 5, 6, 7], "tap", null, null);
    const dailyName = `Diaria ${width} ${stamp}`;
    await db`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
      values (${person.id}, ${goal.id}, ${dailyName}, 'daily', 'tap', now() - interval '30 days')
    `;

    const context = await browser.newContext({
      storageState: person.sessionFile,
      baseURL: baseURL!,
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto("/");
      await expect(page.locator("main")).toHaveCount(1);
      const row = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) });
      await expect(row(twoName)).toBeVisible();

      await expect(row(twoName)).toContainText(`${sentence(two)} · 2 h`);
      await expect(row(threeName)).toContainText(`${sentence(three)} · 5 km`);
      await expect(row(allName)).toContainText("todos los días");
      await expect(row(dailyName)).toContainText("todos los días");
      // The commitment's own line holds no initials.
      await expect(row(twoName)).not.toContainText(/\b[LMXJVSD], [LMXJVSD]\b/);

      await expect(page.getByText("pide el número")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

      // The amount row still opens its sheet.
      await row(twoName).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    } finally {
      await context.close();
      await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
    }
  });
}

test("at 360, Semana names its days in three letters and does not overflow", async ({ person, browser, baseURL, db }) => {
  const stamp = Date.now();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta semana días ${stamp}`}, ${plusDays(90)}, now() - interval '30 days') returning id
  `;
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_weekdays, satisfaction, created_at)
    values (${person.id}, ${goal.id}, ${`Semana dos ${stamp}`}, 'weekdays', ${[2, 4]}, 'tap', now() - interval '30 days')
  `;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 800 },
  });
  try {
    const page = await context.newPage();
    // Today is never a link (RP-06): on a Monday this week has no past day, so read last week's.
    await page.goto(isoWeekday === 1 ? `/semana?semana=${plusDays(-7)}` : "/semana");
    await expect(page.locator("main")).toHaveCount(1);
    // The week's header names each day in three letters, never an initial.
    const dayLinks = page.getByRole("link", { name: /^Abrir el (?!chat$)/ });
    // Today and the days to come are not links: the week holds at least one past day.
    await expect(dayLinks.first()).toBeVisible();
    const labels = (await dayLinks.allTextContents()).map((label) => label.replace(/\s*\d+.*$/, "").trim());
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).toEqual(SHORT.slice(0, labels.length));
    // Where the screen says a commitment's days, it says them as the sentence.
    await expect(page.getByText(/\b[LMXJVSD], [LMXJVSD]\b/)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
  }
});
