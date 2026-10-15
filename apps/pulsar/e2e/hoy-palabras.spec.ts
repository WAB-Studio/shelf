
import { test, expect } from "./fixtures";
import { civilDateToDate, dateToCivilDate, todayInZone, weekOf } from "@/lib/zone";
import { noonFromToday } from "./reloj";

// The words Hoy says at every width: a goal's name as written, a far date with
// its month, a goal that ended off the screen, and the day that has no goal
// left (`HoyTodasTerminadas.dc.html`; RP-19, RP-20, RP-06, RNP-07).
// Paths by day: on a Monday this week's Monday is today's own one-off, so its
// «del …» is asserted absent; every other day asserts it drawn.

const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function plusDays(days: number): string {
  const date = civilDateToDate(todayInZone());
  date.setUTCDate(date.getUTCDate() + days);
  return dateToCivilDate(date);
}

function words(day: string, withMonth: boolean): string {
  const date = civilDateToDate(day);
  const base = `${WEEKDAYS[(date.getUTCDay() + 6) % 7]} ${date.getUTCDate()}`;
  return withMonth ? `${base} de ${MONTHS[date.getUTCMonth()]}` : base;
}

// A person of this spec's own: a goal named on Hoy or ended must be the only
// one there. Registered under the suite's run, whose teardown drops it.
test("a goal named «Inglés Crítico» keeps its capitals on its field, and on a day before it opened (RP-20, RNP-07)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Inglés Crítico', ${plusDays(60)}, ${noonFromToday(0)}) returning id
  `;

  // It asks something, or the phone draws no section for it (RP-47).
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${person.id}, ${goal.id}, 'Tocar', 'daily', 'tap', ${noonFromToday(0)})
  `;

  try {
    const page = await context.newPage();
    // The goal's own field is the desktop face; under 1024 the day has one field.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect(page.getByLabel("Una tarea de Inglés Crítico", { exact: true })).toBeVisible();
    await expect(page.getByPlaceholder("Una tarea de Inglés Crítico…", { exact: true })).toBeVisible();

    await page.goto(`/dia/${plusDays(-1)}`);
    await expect(page.getByText("Ese día no pedía nada")).toBeVisible();
    await expect(
      page.getByText(`Inglés Crítico empezó el ${words(todayInZone(), false)}`, { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${goal.id} and user_id = ${person.id}`;
  }
});

test("a one-off carried from before this week names its month; one from this week does not (RP-19)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  const far = plusDays(-21);
  const near = weekOf(todayInZone())[0];
  await db`insert into goals.one_offs (user_id, name, day) values (${person.id}, 'Vieja', ${far})`;
  // Monday of this week: carried when today is later, and inside the week.
  await db`insert into goals.one_offs (user_id, name, day) values (${person.id}, 'Reciente', ${near})`;

  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByText(`del ${words(far, true)}`, { exact: true })).toBeVisible();
    await expect(page.getByText("Reciente", { exact: true })).toBeVisible();
    await expect(page.getByText(`del ${words(near, false)}`, { exact: true })).toHaveCount(near < todayInZone() ? 1 : 0);
  } finally {
    await context.close();
    await db`delete from goals.one_offs where user_id = ${person.id}`;
  }
});

test("a goal whose horizon is today is not on Hoy (RNP-07)", async ({ person, browser, db }) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  await db`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Meta que terminó', ${todayInZone()}, ${new Date(Date.now() - 30 * 86_400_000)})
  `;
  const [open] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon) values (${person.id}, 'Meta abierta', ${plusDays(30)}) returning id
  `;
  // It asks something, or the phone draws no section for it (RP-47).
  await db`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${person.id}, ${open.id}, 'Tocar', 'daily', 'tap')
  `;

  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByRole("main").getByText("Meta abierta", { exact: true })).toBeVisible();
    // Its last day was yesterday: at most the «terminó ayer» line names it, never a goal entry.
    await expect(page.getByText("Meta que terminó", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Hoy no pide nada.")).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});

test("with every goal ended and none open and a suelta due, Hoy names the goal and its last day, offers two ways on, keeps the sueltas and drops the sentence (RP-19)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  await db`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Inglés Crítico', ${todayInZone()}, ${new Date(Date.now() - 30 * 86_400_000)})
  `;
  await db`insert into goals.one_offs (user_id, name, day) values (${person.id}, 'Algo suelto de hoy', ${todayInZone()})`;

  try {
    const page = await context.newPage();
    await page.goto("/");
    // A suelta waits today: the sentence would be false.
    await expect(page.getByText("Hoy no pide nada.")).toHaveCount(0);
    const yesterday = plusDays(-1);
    await expect(
      page.getByText(`Inglés Crítico terminó el ${words(yesterday, true)} de ${yesterday.slice(0, 4)}. Puedes moverle el final o abrir otra.`),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Ver las metas" })).toHaveAttribute("href", "/metas");
    await expect(page.getByRole("link", { name: "Abrir otra meta" })).toHaveAttribute("href", "/metas/nueva");
    await expect(page.getByText("Todavía no hay nada que anotar.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Algo suelto de hoy", exact: true })).toBeVisible();
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
    await db`delete from goals.one_offs where user_id = ${person.id}`;
  }
});

test("at 1280 the all-ended message stands in a card, its title and buttons padded inside it (RNP-17)", async ({
  person,
  browser,
  db,
}) => {
  const context = await browser.newContext({ storageState: person.sessionFile });
  await db`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${person.id}, 'Inglés Crítico', ${todayInZone()}, ${new Date(Date.now() - 30 * 86_400_000)})
  `;

  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    const title = page.getByText("Hoy no pide nada.");
    await expect(page.getByRole("link", { name: "Abrir otra meta" })).toBeVisible();
    await expect(page.locator("main")).toHaveCount(1);
    const card = title.locator("xpath=..");
    await expect(card).toHaveCSS("border-radius", "14px");
    const [cardBox, titleBox] = [await card.boundingBox(), await title.boundingBox()];
    const buttonBox = await page.getByRole("link", { name: "Abrir otra meta" }).boundingBox();
    expect(titleBox!.x - cardBox!.x).toBeGreaterThanOrEqual(20);
    expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width - 20);
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(cardBox!.y + cardBox!.height);
  } finally {
    await context.close();
    await db`delete from goals.goals where user_id = ${person.id}`;
  }
});
