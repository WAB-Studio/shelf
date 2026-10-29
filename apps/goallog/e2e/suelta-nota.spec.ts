import { test, expect } from "./fixtures";
import { monthOf } from "@/lib/plan/months";
import { civilDateToDate, dateToCivilDate, todayInZone } from "@/lib/zone";

// `HoyNota` and `SueltasNota` (RP-45): Hoy draws only the note's
// button on a one-off, `/sueltas` draws two lines of the text and the button;
// both open 245's sheet, and the mark still lands in one tap (RNP-02).

const today = todayInZone();
const thisMonth = monthOf(today);
const seg = thisMonth.slice(0, 7);
const horizon = `${Number(today.slice(0, 4)) + 1}-${today.slice(5, 7)}-01`;

function plusDays(days: number): string {
  const date = civilDateToDate(today);
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

type Db = import("postgres").Sql;

async function noteOf(db: Db, id: string): Promise<string | null> {
  const [row] = await db<{ note: string | null }[]>`select note from goals.one_offs where id = ${id}`;
  return row.note;
}

// The green mark is the page-with-lines icon; the grey one is the bare page.
const GREEN = "svg.lucide-file-text";

test("Hoy draws the note's button on a one-off, pending or done, never its text; writing it reads on the month list and back (RP-45)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, ${`Meta hoy nota ${stamp}`}, ${horizon}::date, now() - interval '3 days')
    returning id
  `;
  const pendingName = `Pendiente nota ${stamp}`;
  const bareName = `Sin nota hoy ${stamp}`;
  const doneName = `Hecha nota ${stamp}`;
  const [pending] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, day, planned_month)
    values (${person.id}, ${goal.id}, ${pendingName}, ${today}::date, ${thisMonth}::date) returning id
  `;
  await db`
    insert into goals.one_offs (user_id, name, day) values (${person.id}, ${bareName}, ${today}::date)
  `;
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day, note) values (${person.id}, ${doneName}, ${today}::date, 'nota de la hecha')
    returning id
  `;
  await db`
    insert into goals.facts (user_id, one_off_id, day) values (${person.id}, ${done.id}, ${today}::date)
  `;

  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");

    // A row with no note draws its grey button; a done one keeps its green one; no text anywhere.
    const bare = page.getByRole("button", { name: `Escribir una nota en «${bareName}»` });
    await expect(bare).toBeVisible();
    await expect(bare.locator(GREEN)).toHaveCount(0);
    const doneButton = page.getByRole("button", { name: `Ver la nota de «${doneName}»` });
    await expect(doneButton.locator(GREEN)).toHaveCount(1);
    await expect(page.getByText("nota de la hecha")).toHaveCount(0);

    // Writes from Hoy: the sheet carries the goal's name, the text never lands on Hoy.
    await page.getByRole("button", { name: `Escribir una nota en «${pendingName}»` }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText(`nota · Meta hoy nota ${stamp}`);
    await sheet.getByLabel("nota", { exact: true }).fill("primera línea\nsegunda línea");
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet).toBeHidden();
    expect(await noteOf(db, pending.id)).toBe("primera línea\nsegunda línea");
    const written = page.getByRole("button", { name: `Ver la nota de «${pendingName}»` });
    await expect(written.locator(GREEN)).toHaveCount(1);
    await expect(page.getByText("primera línea")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    // The month list reads it.
    await page.goto(`/metas/${goal.id}/meses/${seg}`);
    await expect(page.getByText("primera línea")).toBeVisible();
    await expect(page.getByText("segunda línea")).toBeVisible();

    // And back: emptied from the month list, Hoy draws the grey button again.
    await page.getByRole("button", { name: `Ver la nota de «${pendingName}»` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "quitar la nota" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.goto("/");
    const emptied = page.getByRole("button", { name: `Escribir una nota en «${pendingName}»` });
    await expect(emptied).toBeVisible();
    await expect(emptied.locator(GREEN)).toHaveCount(0);

    // The mark lands in one tap and the done row takes it back in one tap.
    // The pending row's own mark: the innermost div holding its note button.
    const ownRow = page
      .locator("div")
      .filter({ has: page.getByRole("button", { name: `Escribir una nota en «${pendingName}»` }) })
      .last();
    await ownRow.getByRole("button", { name: `Marcar como hecho: ${pendingName}`, exact: true }).click();
    await expect
      .poll(async () => (await db`select 1 from goals.facts where one_off_id = ${pending.id}`).length)
      .toBe(1);
    await page.getByRole("button", { name: `Deshacer: ${doneName}` }).click();
    await expect(page.getByRole("button", { name: `Ver la nota de «${doneName}»` })).toBeVisible();
    await expect
      .poll(async () => (await db`select 1 from goals.facts where one_off_id = ${done.id}`).length)
      .toBe(0);
  } finally {
    await context.close();
  }
});

test("/sueltas draws two lines of the note under the name and its button; a row with none draws as before; the row still opens «¿Para cuándo?» (RP-45)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const daylessName = `Sin día nota ${stamp}`;
  const bareName = `Sin día pelada ${stamp}`;
  const scheduledName = `Programada nota ${stamp}`;
  await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, note)
    values (${person.id}, ${daylessName}, 'uno\ndos\ntres\ncuatro') returning id
  `;
  await db`insert into goals.one_offs (user_id, name) values (${person.id}, ${bareName})`;
  const [scheduled] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name, day)
    values (${person.id}, ${scheduledName}, ${plusDays(2)}::date) returning id
  `;

  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/sueltas");

    // Four lines written, two drawn.
    const preview = page.getByText("uno", { exact: false }).first();
    await expect(preview).toBeVisible();
    const lines = await preview.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        clamp: style.webkitLineClamp,
        height: el.getBoundingClientRect().height,
        line: parseFloat(style.lineHeight),
        pre: style.whiteSpace,
      };
    });
    expect(lines.clamp).toBe("2");
    expect(lines.pre).toContain("pre-line");
    expect(lines.height).toBeLessThanOrEqual(lines.line * 2 + 1);

    const noted = page.getByRole("button", { name: `Ver la nota de «${daylessName}»` });
    await expect(noted.locator(GREEN)).toHaveCount(1);
    const bare = page.getByRole("button", { name: `Escribir una nota en «${bareName}»` });
    await expect(bare.locator(GREEN)).toHaveCount(0);

    // The row's name opens its sheet, never the note's; its day is a row inside.
    await page.getByRole("button", { name: new RegExp(`^${bareName}`) }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Darle un día" }).click();
    await expect(page.getByRole("dialog")).toContainText("¿Para cuándo?");
    // Radix registers the sheet's Escape layer in an effect after its DOM and
    // focus exist; the open animation is the first thing that ends after it.
    // Focus alone is no anchor: the closing task sheet still holds it.
    await page
      .getByRole("dialog")
      .filter({ hasText: "¿Para cuándo?" })
      .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    // Writes on the scheduled one from here.
    await page.getByRole("button", { name: `Escribir una nota en «${scheduledName}»` }).click();
    await expect(page.getByRole("dialog")).toContainText("nota");
    await page.getByRole("dialog").getByLabel("nota", { exact: true }).fill("para el jueves");
    await page.getByRole("dialog").getByRole("button", { name: "Guardar" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    expect(await noteOf(db, scheduled.id)).toBe("para el jueves");
    await expect(page.getByText("para el jueves")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    // Escape gives focus back to the button that opened the sheet.
    const opener = page.getByRole("button", { name: `Ver la nota de «${scheduledName}»` });
    await opener.click();
    await page
      .getByRole("dialog")
      .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(opener).toBeFocused();

    // The mark finishes it in one tap.
    await page.getByRole("button", { name: `Dar por hecha: ${bareName}` }).click();
    await expect
      .poll(async () => (await db`select 1 from goals.facts where user_id = ${person.id}`).length)
      .toBe(1);
  } finally {
    await context.close();
  }
});

test("a refusal from the server keeps the sheet open, says so and keeps the typed text (RP-45)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const name = `Suelta que se borra ${stamp}`;
  const [row] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, name) values (${person.id}, ${name}) returning id
  `;
  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/sueltas");
    await page.getByRole("button", { name: `Escribir una nota en «${name}»` }).click();
    const sheet = page.getByRole("dialog");
    const area = sheet.getByLabel("nota", { exact: true });
    await area.fill("texto que no se pierde");

    // The action answers {ok:false}: the row is gone by the time it saves.
    await db`delete from goals.one_offs where id = ${row.id}`;
    await sheet.getByRole("button", { name: "Guardar" }).click();

    await expect(sheet.getByRole("alert")).toHaveText(
      "No se pudo guardar. Tu texto sigue aquí; inténtalo otra vez.",
    );
    await expect(sheet).toBeVisible();
    await expect(area).toHaveValue("texto que no se pierde");
  } finally {
    await context.close();
  }
});

test("Hoy's «este mes» line draws the next task's note button; writing it reads on the month list; the mark lands in one tap (RP-45)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalName = `Meta mes nota ${stamp}`;
  const firstName = `Primera nota ${stamp}`;
  const secondName = `Segunda nota ${stamp}`;
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${person.id}, ${goalName}, ${plusDays(90)}, 'minutos', 'minutos', now() - interval '40 days')
    returning id
  `;
  await db`
    insert into goals.month_budgets (user_id, goal_id, month, amount)
    values (${person.id}, ${goal.id}, ${thisMonth}::date, 720)
  `;
  const task = (name: string, estimate: number) => db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate)
    values (${person.id}, ${goal.id}, ${name}, ${thisMonth}::date, ${estimate}) returning id
  `;
  const [first] = await task(firstName, 240);
  await task(secondName, 60);

  const context = await browser.newContext({
    storageState: person.sessionFile,
    baseURL: baseURL!,
    viewport: { width: 360, height: 740 },
  });
  try {
    const page = await context.newPage();
    await page.goto("/");
    const button = (label: string, name: string) =>
      page.getByRole("button", { name: `${label} «${name}»` }).locator("visible=true");

    const bare = button("Escribir una nota en", firstName);
    await expect(bare).toHaveCount(1);
    await expect(bare.locator(GREEN)).toHaveCount(0);

    await bare.click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText(`nota · ${goalName}`);
    await sheet.getByLabel("nota", { exact: true }).fill("la nota de la línea");
    await sheet.getByRole("button", { name: "Guardar" }).click();
    await expect(sheet).toBeHidden();
    expect(await noteOf(db, first.id)).toBe("la nota de la línea");
    await expect(button("Ver la nota de", firstName).locator(GREEN)).toHaveCount(1);
    await expect(page.getByText("la nota de la línea")).toHaveCount(0);

    await page.goto(`/metas/${goal.id}/meses/${seg}`);
    await expect(page.getByText("la nota de la línea")).toBeVisible();

    await page.goto("/");
    const secondMark = page
      .getByRole("button", { name: `Marcar hecha: ${secondName}` })
      .locator("visible=true");
    await expect(secondMark).toHaveCount(0);
    await page
      .getByRole("button", { name: `Marcar hecha: ${firstName}` })
      .locator("visible=true")
      .click();
    await expect(secondMark).toHaveCount(1, { timeout: 5000 });
    expect((await db`select 1 from goals.facts where one_off_id = ${first.id}`).length).toBe(1);
  } finally {
    await context.close();
  }
});
