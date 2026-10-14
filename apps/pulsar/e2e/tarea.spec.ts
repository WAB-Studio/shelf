import { test, expect } from "./fixtures";
import { dayBefore } from "@/lib/day/weeks";
import { monthOf, nextMonth } from "@/lib/plan/months";
import { todayInZone } from "@/lib/zone";
import { boxOf } from "./box";

// `TareaNueva`, `SubtareaNueva`, `TareaSinMedida` (RP-30, RP-31,
// RP-35): the form that writes a task of a month and a sub-task under a
// parent. Calendar-bound as 139: «last month» is always closed, this month
// always open.

const NAMES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

function label(month: string): string {
  return NAMES[Number(month.slice(5, 7)) - 1];
}

const thisMonth = monthOf(todayInZone());
const lastMonth = monthOf(dayBefore(thisMonth));
const following = nextMonth(thisMonth);
const horizon = nextMonth(following);
const seg = (month: string) => month.slice(0, 7);

type Db = import("postgres").Sql;

async function seedGoal(db: Db, personId: string, name: string, measure: boolean = true) {
  const [goal] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, ${name}, ${horizon}::date, ${measure ? "minutos" : null}, ${measure ? "minutos" : null},
      (${lastMonth}::date + 14) + time '12:00' at time zone 'UTC')
    returning id
  `;
  return goal.id;
}

async function seedTask(
  db: Db,
  personId: string,
  goalId: string,
  name: string,
  month: string | null,
  estimate: number | null,
  parentId: string | null = null,
) {
  const [task] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, estimate, parent_id)
    values (${personId}, ${goalId}, ${name}, ${month === null ? null : db`${month}::date`}, ${estimate}, ${parentId})
    returning id
  `;
  return task.id;
}

const newHref = (goalId: string, month: string) => `/metas/${goalId}/meses/${seg(month)}/tarea/nueva`;

test("writes a task of 1 h, a parent «con sub-tareas» and two sub-tasks of 1 h and 6 h; the month reads them and the parent owes 7 h (RP-30, RP-31, RP-35)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta tarea ${stamp}`);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });

    await page.goto(newHref(goalId, thisMonth));
    await expect(page.getByRole("button", { name: "Guardar la tarea" })).toBeVisible();
    await expect(page.getByText(`META TAREA ${stamp} · ${label(thisMonth).toUpperCase()}`)).toBeVisible();
    await expect(page.getByText(`Una tarea de ${label(thisMonth)}`, { exact: true })).toBeVisible();
    await expect(page.getByLabel("horas")).toBeVisible();
    await expect(page.getByLabel("minutos")).toBeVisible();
    await expect(page.getByText("su tiempo sale de las sub-tareas")).toBeVisible();

    await page.getByLabel("qué hay que hacer").fill(`Una hora ${stamp}`);
    await page.getByLabel("horas").fill("1");
    await page.getByRole("button", { name: "Guardar la tarea" }).click();
    await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/meses/${seg(thisMonth)}$`));
    await expect(page.getByText(`Una hora ${stamp}`)).toBeVisible();
    await expect(page.getByText("1 h", { exact: true }).first()).toBeVisible();

    // «con sub-tareas» takes the amount fields away.
    await page.goto(newHref(goalId, thisMonth));
    const withChildren = page.getByRole("checkbox", { name: "con sub-tareas" });
    await expect(withChildren).toHaveAttribute("aria-checked", "false");
    await withChildren.click();
    await expect(withChildren).toHaveAttribute("aria-checked", "true");
    await expect(page.getByLabel("horas")).toHaveCount(0);
    await expect(page.getByLabel("minutos")).toHaveCount(0);
    await page.getByLabel("qué hay que hacer").fill(`Padre ${stamp}`);
    await page.getByRole("button", { name: "Guardar la tarea" }).click();
    // Saving «con sub-tareas» goes straight on to its first sub-task.
    await expect(page).toHaveURL(/\/tarea\/nueva\?padre=/);
    await expect(page.getByText(`PADRE ${stamp} · ${label(thisMonth).toUpperCase()}`)).toBeVisible();

    const [parent] = await db<{ id: string; estimate: number | null }[]>`
      select id, estimate from goals.one_offs where goal_id = ${goalId} and name = ${`Padre ${stamp}`}
    `;
    expect(parent.estimate).toBeNull();

    // Two sub-tasks; the sum line counts the amount being typed.
    await expect(page.getByRole("heading", { name: "Una sub-tarea" })).toBeVisible();
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByText(`«Padre ${stamp}» suma 0 min con esta.`)).toBeVisible();
    await page.getByLabel("qué hay que hacer").fill(`Primera ${stamp}`);
    await page.getByLabel("horas").fill("1");
    await expect(page.getByText(`«Padre ${stamp}» suma 1 h con esta.`)).toBeVisible();
    await page.getByRole("button", { name: "Guardar la sub-tarea" }).click();
    await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/meses/${seg(thisMonth)}$`));

    // The second is reached through the month's own «Otra sub-tarea» row.
    await page.getByRole("link", { name: "Otra sub-tarea" }).click();
    await expect(page).toHaveURL(`${newHref(goalId, thisMonth)}?padre=${parent.id}`);
    await page.getByLabel("qué hay que hacer").fill(`Segunda ${stamp}`);
    await page.getByLabel("horas").fill("6");
    await expect(page.getByText(`«Padre ${stamp}» suma 7 h con esta.`)).toBeVisible();
    await page.getByRole("button", { name: "Guardar la sub-tarea" }).click();
    await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/meses/${seg(thisMonth)}$`));

    await expect(page.getByText(`Primera ${stamp}`)).toBeVisible();
    await expect(page.getByText(`Segunda ${stamp}`)).toBeVisible();
    const parentRow = page.locator("[data-done]").filter({ hasText: `Padre ${stamp}` });
    await expect(parentRow).toContainText("7 h");
    await expect(parentRow).toContainText("0 min de 7 h");

    const rows = await db<{ name: string; estimate: number | null; parent_id: string | null }[]>`
      select name, estimate, parent_id from goals.one_offs where goal_id = ${goalId} order by created_at
    `;
    expect(rows.map((row) => `${row.name}:${row.estimate}:${row.parent_id === null ? "-" : "child"}`)).toEqual([
      `Una hora ${stamp}:60:-`,
      `Padre ${stamp}:null:-`,
      `Primera ${stamp}:60:child`,
      `Segunda ${stamp}:360:child`,
    ]);
  } finally {
    await context.close();
  }
});

test("a sub-task under a sub-task, a parent of another goal or month, a closed month and a closed goal are not found (RP-31)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta no ${stamp}`);
  const otherGoal = await seedGoal(db, person.id, `Meta otra ${stamp}`);
  const parent = await seedTask(db, person.id, goalId, `Padre ${stamp}`, thisMonth, null);
  const child = await seedTask(db, person.id, goalId, `Hijo ${stamp}`, null, 60, parent);
  const foreign = await seedTask(db, person.id, otherGoal, `Ajeno ${stamp}`, thisMonth, null);
  const later = await seedTask(db, person.id, goalId, `Luego ${stamp}`, following, null);
  const timed = await seedTask(db, person.id, goalId, `Con tiempo ${stamp}`, thisMonth, 30);
  const ended = await seedGoal(db, person.id, `Meta fin ${stamp}`);
  await db`update goals.goals set horizon = ${thisMonth}::date where id = ${ended}`;
  const archived = await seedGoal(db, person.id, `Meta arch ${stamp}`);
  await db`update goals.goals set archived_at = now() where id = ${archived}`;

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    const missing = page.getByRole("heading", { name: "Esta página no existe" });

    for (const href of [
      `${newHref(goalId, thisMonth)}?padre=${child}`,
      `${newHref(goalId, thisMonth)}?padre=${foreign}`,
      `${newHref(goalId, thisMonth)}?padre=${later}`,
      `${newHref(goalId, thisMonth)}?padre=${timed}`,
      `${newHref(goalId, thisMonth)}?padre=no-es-un-id`,
      newHref(goalId, lastMonth),
      newHref(goalId, nextMonth(horizon)),
      newHref(ended, thisMonth),
      newHref(archived, thisMonth),
    ]) {
      await page.goto(href);
      await expect(missing, href).toBeVisible();
    }

    await page.goto(`${newHref(goalId, thisMonth)}?padre=${parent}`);
    await expect(page.getByRole("heading", { name: "Una sub-tarea" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("each refusal reads its words, on the form and from the server (RP-30, RP-31, RP-35)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta refusa ${stamp}`);
  const parent = await seedTask(db, person.id, goalId, `Padre ${stamp}`, thisMonth, null);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    const save = page.getByRole("button", { name: "Guardar la tarea" });

    await page.goto(newHref(goalId, thisMonth));
    await save.click();
    await expect(page.getByText("Escribe qué hay que hacer.")).toBeVisible();
    await expect(page.getByText("Escribe qué es lo suelto.")).toHaveCount(0);

    await page.getByLabel("qué hay que hacer").fill(`Larga ${stamp}`.padEnd(130, "x"));
    await save.click();
    await expect(page.getByText("Es muy largo. Escribe máximo 120 caracteres.")).toBeVisible();

    await page.getByLabel("qué hay que hacer").fill(`Tarea ${stamp}`);
    await page.getByLabel("horas").fill("0");
    await save.click();
    await expect(page.getByText("Escribe un número entero entre 1 y 1 000 000.")).toBeVisible();

    await page.getByLabel("horas").fill("1");
    await page.getByLabel("minutos").fill("75");
    await save.click();
    await expect(page.getByText("Los minutos van de 0 a 59.")).toBeVisible();
    await expect(page).toHaveURL(/tarea\/nueva$/);

    // The server's own keys: the form was open while the world moved.
    await page.goto(`${newHref(goalId, thisMonth)}?padre=${parent}`);
    await page.getByLabel("qué hay que hacer").fill(`Hija ${stamp}`);
    await db`update goals.one_offs set estimate = 30 where id = ${parent}`;
    await page.getByRole("button", { name: "Guardar la sub-tarea" }).click();
    await expect(
      page.getByText("Una sub-tarea solo va bajo una tarea del mes sin día, sin tiempo propio y sin nada hecho."),
    ).toBeVisible();

    await db`delete from goals.one_offs where id = ${parent}`;
    await page.getByRole("button", { name: "Guardar la sub-tarea" }).click();
    await expect(page.getByText("Eso ya no existe. Recarga la página.")).toBeVisible();

    await page.goto(newHref(goalId, thisMonth));
    await page.getByLabel("qué hay que hacer").fill(`Cierra ${stamp}`);
    await db`update goals.goals set archived_at = now() where id = ${goalId}`;
    await save.click();
    await expect(page.getByText("Esta meta ya terminó o está archivada.")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Hoy's one-off field still reads «Escribe qué es lo suelto.» for an empty name (RP-19)", async ({ page }) => {
  await page.goto("/");
  const field = page.getByLabel("Algo suelto").last();
  await field.fill("   ");
  await field.press("Enter");
  await expect(page.getByText("Escribe qué es lo suelto.")).toBeVisible();
  await expect(page.getByText("Escribe qué hay que hacer.")).toHaveCount(0);
});

test("a goal with no measure writes a task with no time and no amount fields, and a parent with sub-tasks that carry none (RP-30, RP-31)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta sin ${stamp}`, false);
  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(newHref(goalId, thisMonth));
    await expect(page.getByText("Esta meta no mide nada, así que la tarea no lleva tiempo.")).toBeVisible();
    await expect(page.getByLabel("horas")).toHaveCount(0);
    await expect(page.getByLabel("minutos")).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "con sub-tareas" })).toBeVisible();
    await page.getByLabel("qué hay que hacer").fill(`Trámite ${stamp}`);
    await page.getByRole("button", { name: "Guardar la tarea" }).click();
    await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/meses/${seg(thisMonth)}$`));
    await expect(page.getByText(`Trámite ${stamp}`)).toBeVisible();
    const [row] = await db<{ estimate: number | null }[]>`
      select estimate from goals.one_offs where goal_id = ${goalId}
    `;
    expect(row.estimate).toBeNull();

    // «con sub-tareas» lands on the first sub-task's form: no hours anywhere, the hint speaks of no time.
    await page.goto(newHref(goalId, thisMonth));
    await page.getByLabel("qué hay que hacer").fill(`Padre ${stamp}`);
    await page.getByRole("checkbox", { name: "con sub-tareas" }).click();
    await expect(page.getByText("se da por hecha cuando lo están sus sub-tareas")).toBeVisible();
    await page.getByRole("button", { name: "Guardar la tarea" }).click();
    await expect(page.getByRole("heading", { name: "Una sub-tarea" })).toBeVisible();
    await expect(page.getByLabel("horas")).toHaveCount(0);
    await expect(page.getByLabel("minutos")).toHaveCount(0);
    await page.getByLabel("qué hay que hacer").fill(`Hija ${stamp}`);
    await page.getByRole("button", { name: "Guardar la sub-tarea" }).click();
    await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/meses/${seg(thisMonth)}$`));
    const parentRow = page.locator("[data-done]").filter({ hasText: `Padre ${stamp}` });
    await expect(parentRow).toBeVisible();
    await expect(page.getByText(`Hija ${stamp}`)).toBeVisible();
    await expect(page.getByRole("link", { name: "Otra sub-tarea" })).toHaveCount(2);
    await page.getByRole("link", { name: "Otra sub-tarea" }).first().click();
    await expect(page.getByRole("heading", { name: "Una sub-tarea" })).toBeVisible();
    await expect(page.getByLabel("horas")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

for (const width of [360, 1280]) {
  test(`the form holds at ${width}: no overflow, fields 48 px, buttons 52 px, borders in --pulsar-border; Cancelar returns to the month`, async ({
    person,
    browser,
    baseURL,
    db,
  }) => {
    const stamp = Date.now();
    const goalId = await seedGoal(db, person.id, `Meta caja ${stamp}`);
    const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width, height: 800 });
      await page.goto(newHref(goalId, thisMonth));
      await expect(page.locator("main")).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Guardar la tarea" })).toBeVisible();

      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      for (const name of ["qué hay que hacer", "horas", "minutos"]) {
        const box = await page.getByLabel(name).evaluate((el) => el.closest(".rt-TextFieldRoot")!.getBoundingClientRect());
        expect(box.height, name).toBeGreaterThanOrEqual(48);
        expect(box.right, name).toBeLessThanOrEqual(width);
      }
      for (const name of ["Guardar la tarea", "Cancelar"]) {
        const target = name === "Cancelar" ? page.getByRole("link", { name }) : page.getByRole("button", { name });
        const box = (await boxOf(target));
        expect(box.height, name).toBeGreaterThanOrEqual(52);
        expect(box.x + box.width, name).toBeLessThanOrEqual(width);
      }

      // Field and secondary button wear `--pulsar-border`, never `--pulsar-line`.
      const border = await page.evaluate(() => {
        const probe = document.createElement("i");
        probe.style.color = "var(--pulsar-border)";
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      });
      expect(await page.getByLabel("horas").evaluate((el) => getComputedStyle(el.closest(".rt-TextFieldRoot")!).boxShadow)).toContain(border);
      expect(await page.getByRole("link", { name: "Cancelar" }).evaluate((el) => getComputedStyle(el).boxShadow)).toContain(border);

      await page.getByRole("link", { name: "Cancelar" }).click();
      await expect(page).toHaveURL(new RegExp(`/metas/${goalId}/meses/${seg(thisMonth)}$`));
    } finally {
      await context.close();
    }
  });
}

test("«Otra sub-tarea» closes each open parent's children and is offered under a parent and a bare task, of a goal that measures nothing as of one that does, never in a closed month, or a carried or sub-task row (RP-31)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const goalId = await seedGoal(db, person.id, `Meta fila ${stamp}`);
  const open = await seedTask(db, person.id, goalId, `Abierto ${stamp}`, thisMonth, null);
  await seedTask(db, person.id, goalId, `Hijo abierto ${stamp}`, null, 30, open);
  await seedTask(db, person.id, goalId, `Hoja ${stamp}`, thisMonth, 45);
  const bare = await seedTask(db, person.id, goalId, `Sin hijos ${stamp}`, thisMonth, null);
  const plainGoal = await seedGoal(db, person.id, `Meta lisa ${stamp}`, false);
  await seedTask(db, person.id, plainGoal, `Trámite ${stamp}`, thisMonth, null);
  const old = await seedTask(db, person.id, goalId, `Viejo ${stamp}`, lastMonth, null);
  await seedTask(db, person.id, goalId, `Hijo viejo ${stamp}`, null, 30, old);

  const context = await browser.newContext({ storageState: person.sessionFile, baseURL: baseURL! });
  try {
    const page = await context.newPage();
    const link = page.getByRole("link", { name: "Otra sub-tarea" });
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/metas/${goalId}/meses/${seg(thisMonth)}`);
      await expect(page.getByText(`Hijo abierto ${stamp}`)).toBeVisible();
      // Own parent and the childless no-estimate task: not the leaf with time, the sub-task or the carried parent.
      await expect(page.getByText(`Viejo ${stamp}`).first()).toBeVisible();
      await expect(link, `${width}`).toHaveCount(2);
      await expect(link.first()).toHaveAttribute("href", `${newHref(goalId, thisMonth)}?padre=${open}`);
      await expect(link.last()).toHaveAttribute("href", `${newHref(goalId, thisMonth)}?padre=${bare}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

      const child = (await boxOf(page.getByText(`Hijo abierto ${stamp}`)));
      const row = (await link.first().evaluate((el) => el.getBoundingClientRect()))!;
      expect(row.height).toBeGreaterThanOrEqual(48);
      const circle = (await link.first().evaluate((el) => el.querySelector("[data-state]")!.getBoundingClientRect()))!;
      const mark = (await boxOf(page.locator("[data-done]").first()));
      expect(circle.x - mark.x).toBeGreaterThanOrEqual(30);
      expect(row.y).toBeGreaterThan(child.y);
    }

    await page.goto(`/metas/${goalId}/meses/${seg(lastMonth)}`);
    await expect(page.getByText(`Hijo viejo ${stamp}`)).toBeVisible();
    await expect(link).toHaveCount(0);

    // A goal that measures nothing offers it under a bare task, by the same rule.
    await page.goto(`/metas/${plainGoal}/meses/${seg(thisMonth)}`);
    await expect(page.getByText(`Trámite ${stamp}`)).toBeVisible();
    await expect(link).toHaveCount(1);
  } finally {
    await context.close();
  }
});
