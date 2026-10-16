import type { Browser, Locator, Page } from "@playwright/test";
import type postgres from "postgres";

import messages from "@/messages/es/week.json";

import { test, expect, type Person } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// RP-16, RP-44 on Semana: a day logged under its target draws the half dot and
// reads «en parte»; the phone footer names it apart from «hechos»
// (`SemanaEnParte.dc.html`); a week before the first goal's lands on the first
// week (`SemanaPrimera.dc.html`).

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

const today = todayInZone();
const thisMonday = shift(today, -((civilDateToDate(today).getUTCDay() + 6) % 7));
const lastMonday = shift(thisMonday, -7);
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const FULL_MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function rangeOf(monday: string): string {
  const sunday = shift(monday, 6);
  const day = (d: string) => String(Number(d.slice(8, 10)));
  const name = (d: string) => MONTHS[Number(d.slice(5, 7)) - 1];
  if (monday.slice(0, 7) !== sunday.slice(0, 7)) {
    return messages.range.replace("{start}", `${day(monday)} ${name(monday)}`).replace("{end}", `${day(sunday)} ${name(sunday)}`);
  }
  return messages.rangeWithMonth
    .replace("{start}", day(monday))
    .replace("{end}", day(sunday))
    .replace("{month}", FULL_MONTHS[Number(sunday.slice(5, 7)) - 1]);
}

const GOAL = "Inglés semana";
const ROW = "Monólogo";

async function seed(db: postgres.Sql, person: Person, createdDaysAgo: number) {
  const created = new Date(`${shift(today, -createdDaysAgo)}T17:00:00Z`);
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${GOAL}, ${shift(today, 60)}, ${created}) returning id
  `;
  const [commitment] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit, created_at)
    values (${person.id}, ${goal.id}, ${ROW}, 'daily', 'quantity', 30, 'minutos', ${created}) returning id
  `;
  for (const [day, quantity] of [[lastMonday, 29], [shift(lastMonday, 1), 30]] as const) {
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${person.id}, ${goal.id}, ${commitment.id}, ${day}::date, ${quantity})
    `;
  }
  return goal.id;
}

async function withPage(
  browser: Browser,
  baseURL: string | undefined,
  person: Person,
  width: number,
  run: (page: Page) => Promise<void>,
) {
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: 900 });
    await run(page);
  } finally {
    await context.close();
  }
}

const markOf = (page: Page, day: string) =>
  page.getByRole("img", { name: new RegExp(`^${ROW}, \\S+ ${Number(day.slice(8, 10))}: `) });

for (const width of [390, 1280]) {
  test(`at ${width}, 29 of 30 min draws «en parte», 30 draws hecho, none draws empty (RP-16)`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    const goalId = await seed(db, person, 40);
    try {
      await withPage(browser, baseURL, person, width, async (page) => {
        await page.goto(`/semana?semana=${lastMonday}`);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(lastMonday));

        const partial = markOf(page, lastMonday);
        await expect(partial).toHaveAttribute("data-state", "partial");
        await expect(partial).toHaveAccessibleName(/: en parte$/);
        await expect(markOf(page, shift(lastMonday, 1))).toHaveAttribute("data-state", "declared");
        await expect(markOf(page, shift(lastMonday, 2))).toHaveAttribute("data-state", "empty");

        // The real dot paints the half fill and the ring, unlike an empty one.
        const paint = (day: string) =>
          markOf(page, day).evaluate((el) => {
            const cs = getComputedStyle(el);
            return {
              image: cs.backgroundImage,
              ring: cs.boxShadow,
              accent: getComputedStyle(document.documentElement).getPropertyValue("--pulsar-accent").trim(),
            };
          });
        const half = await paint(lastMonday);
        const empty = await paint(shift(lastMonday, 2));
        expect(half.image).toContain("linear-gradient");
        expect(half.image).toContain("to top");
        expect(half.ring).not.toBe("none");
        expect(empty.image).toBe("none");
        expect(half.ring).not.toBe(empty.ring);
      });
    } finally {
      await db`delete from goals.goals where id = ${goalId}`;
    }
  });
}

test("the phone footer names the partial apart from «hechos» and draws the four-dot legend (RP-16)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  const goalId = await seed(db, person, 40);
  try {
    await withPage(browser, baseURL, person, 390, async (page) => {
      await page.goto(`/semana?semana=${lastMonday}`);
      await expect(markOf(page, lastMonday)).toHaveAttribute("data-state", "partial");
      // One 30 of 30 day, one 29 of 30; the figures come from the catalogue.
      const sum = page.locator("p").filter({ hasText: /^hechos \d+ de \d+ · \d+ en parte$/ }).filter({ visible: true });
      await expect(sum).toHaveText(
        messages.table.footerPartial.replace(/<\/?fig>/g, "").replace("{done}", "1").replace("{total}", "7").replace("{partial}", "1"),
      );
      // Only the figures are mono; the words stay Archivo.
      await expect(sum.locator("span")).toHaveCount(3);
      const family = (loc: Locator) => loc.evaluate((el) => getComputedStyle(el).fontFamily);
      expect(await family(sum)).not.toBe(await family(sum.locator("span").first()));
      expect(await family(sum.locator("span").first())).toMatch(/mono/i);
      expect(await family(sum)).not.toMatch(/mono/i);
      await expect(page.getByText(/hechos/i).filter({ visible: true })).toHaveCount(1);
      const legend = page.getByTestId("week-legend");
      await expect(legend).toBeVisible();
      for (const word of ["hecho", "por evidencia", "en parte", "pendiente"]) {
        await expect(legend.getByText(word, { exact: true })).toBeVisible();
      }
      await expect(legend.locator('[data-state="partial"]')).toHaveCount(1);
    });
  } finally {
    await db`delete from goals.goals where id = ${goalId}`;
  }
});

test("a week before the first lands on the first week; a person with no goal reads the empty week (RP-44)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  const goalId = await seed(db, person, 20);
  const firstMonday = shift(
    shift(today, -20),
    -((civilDateToDate(shift(today, -20)).getUTCDay() + 6) % 7),
  );
  try {
    await withPage(browser, baseURL, person, 390, async (page) => {
      await page.goto(`/semana?semana=${shift(firstMonday, -14)}`);
      await expect(page).toHaveURL(new RegExp(`/semana\\?semana=${firstMonday}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(firstMonday));
      await expect(page.getByText("Todavía no tienes una meta abierta.")).toHaveCount(0);
    });
  } finally {
    await db`delete from goals.goals where id = ${goalId}`;
  }

  await withPage(browser, baseURL, person, 390, async (page) => {
    await page.goto(`/semana?semana=${shift(thisMonday, -21)}`);
    await expect(page.getByText("Todavía no tienes una meta abierta.")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/semana\\?semana=${shift(thisMonday, -21)}$`));
  });
});

// A times-a-week commitment logged under its target on a day draws the half dot
// there; the days with nothing logged keep «no pedía».
for (const width of [390, 1280]) {
  test(`at ${width}, a times-a-week row logged 3 of 5 draws «en parte» that day and nothing on the rest`, async ({
    browser,
    baseURL,
    db,
    person,
  }) => {
    const created = new Date(`${shift(today, -40)}T17:00:00Z`);
    const [goal] = await db<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, created_at)
      values (${person.id}, ${GOAL}, ${shift(today, 60)}, ${created}) returning id
    `;
    const [commitment] = await db<{ id: string }[]>`
      insert into goals.commitments (user_id, goal_id, name, cadence_kind, cadence_n, satisfaction, target_quantity, unit, created_at)
      values (${person.id}, ${goal.id}, ${ROW}, 'times_per_week', 3, 'quantity', 5, 'km', ${created}) returning id
    `;
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${person.id}, ${goal.id}, ${commitment.id}, ${shift(lastMonday, 2)}::date, 3)
    `;
    try {
      await withPage(browser, baseURL, person, width, async (page) => {
        await page.goto(`/semana?semana=${lastMonday}`);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(rangeOf(lastMonday));
        const partial = markOf(page, shift(lastMonday, 2));
        await expect(partial).toHaveAttribute("data-state", "partial");
        await expect(partial).toHaveAccessibleName(/: en parte$/);
        await expect(markOf(page, lastMonday)).toHaveAttribute("data-state", "none");
        await expect(markOf(page, shift(lastMonday, 3))).toHaveAttribute("data-state", "none");
        // The key of the half dot shows on the phone even with no daily partial.
        if (width === 390) {
          await expect(page.getByTestId("week-legend").getByText("en parte", { exact: true })).toBeVisible();
          // The row asks all seven days, so the footer's sum counts it and names its partial (RP-01, RP-16).
          await expect(page.getByText("hechos 0 de 7 · 1 en parte", { exact: true }).filter({ visible: true })).toHaveCount(1);
        }
      });
    } finally {
      await db`delete from goals.goals where id = ${goal.id}`;
    }
  });
}

// The phone footer counts the days that have come: a partial day still to come
// is no partial yet (RP-16).
async function seedDailyQuantity(db: postgres.Sql, person: Person, partialDays: string[]) {
  const goalId = await seed(db, person, 40);
  const [commitment] = await db<{ id: string }[]>`
    select id from goals.commitments where goal_id = ${goalId}
  `;
  for (const day of partialDays) {
    await db`
      insert into goals.facts (user_id, goal_id, commitment_id, day, quantity)
      values (${person.id}, ${goalId}, ${commitment.id}, ${day}::date, 29)
    `;
  }
  return goalId;
}

test("at 390 the footer counts today's partial and not a partial day still to come (RP-16)", async ({
  browser,
  baseURL,
  db,
  person,
}) => {
  const elapsed = ((civilDateToDate(today).getUTCDay() + 6) % 7) + 1;
  test.skip(elapsed === 7, "domingo: no hay día por venir en la semana; m72 no se alcanza");
  const goalId = await seedDailyQuantity(db, person, [today, shift(today, 1), shift(today, 2)]);
  try {
    await withPage(browser, baseURL, person, 390, async (page) => {
      await page.goto(`/semana?semana=${thisMonday}`);
      await expect(markOf(page, today)).toHaveAttribute("data-state", "partial");
      await expect(
        page.getByText(`hechos 0 de ${elapsed} · 1 en parte`, { exact: true }).filter({ visible: true }),
      ).toHaveCount(1);
    });
  } finally {
    await db`delete from goals.goals where id = ${goalId}`;
  }
});
