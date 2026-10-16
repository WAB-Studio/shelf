import type { Page } from "@playwright/test";

import { test, expect, settled } from "./fixtures";
import { holdActions, type Db } from "./meta-arbol-seed";
import { mainLower, postCounter, visit } from "./metas-sin-final-seed";
import { TODAY, TODAY_INDEX, drawn, seedFact, seedHabit, shift } from "./sin-final-seed";

// Module 1015, RP-135 (successor of RP-104), RP-127: a live loose habit no fact names changes its cadence on
// `/metas/habitos/{id}/frecuencia`, and only its cadence. Written from the contract before the page exists.
// Every test names the mutation that kills it.
test.use({ actionTimeout: 6000 });

const habitPath = (id: string) => `/metas/habitos/${id}`;
const frecuencia = (id: string) => `${habitPath(id)}/frecuencia`;
const NOT_TODAY = ((TODAY_INDEX + 3) % 7) + 1;
const WEEKS_BOUND = "Escribe cuántas veces por semana, un número entero entre 1 y 7.";

async function rowOf(db: Db, id: string) {
  const [row] = await db<
    {
      goal_id: string | null;
      name: string;
      note: string | null;
      cadence_kind: string;
      cadence_n: number | null;
      cadence_weekdays: number[] | null;
      satisfaction: string;
      target_quantity: number | null;
      unit: string | null;
    }[]
  >`select goal_id, name, note, cadence_kind, cadence_n, cadence_weekdays, satisfaction, target_quantity, unit
    from goals.commitments where id = ${id}`;
  return row;
}

const save = (page: Page) => page.getByRole("button", { name: /^Guardar/ });

test("saved: «Cambiar la frecuencia» opens the page prefilled, saving returns to the habit's screen with the new words, and only the cadence changed", async ({ person, browser, baseURL, db }) => {
  // Kills: saving to the goal route (`/metas/null`, a second row); an edit that rewrites name, note or amount; a prefill that ignores the row.
  const id = await seedHabit(db, person.id, "Tomar agua", { kind: "weekdays", days: [2, 4] }, { kind: "quantity", target: 2, unit: "litros" });
  await db`update goals.commitments set note = 'Un vaso al despertar.' where id = ${id}`;
  const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
  try {
    await mainLower(page);
    await page.getByRole("link", { name: "Cambiar la frecuencia", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${frecuencia(id)}$`));
    await expect(page.getByRole("button", { name: "días sueltos", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "J", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "veces por semana", exact: true }).click();
    await page.getByRole("spinbutton", { name: "veces por semana" }).fill("2");
    await save(page).click();
    await expect(page).toHaveURL(new RegExp(`${habitPath(id)}$`));
    expect(await mainLower(page)).toContain("2 veces por semana");
    expect(await rowOf(db, id)).toMatchObject({
      goal_id: null,
      name: "Tomar agua",
      note: "Un vaso al despertar.",
      cadence_kind: "times_per_week",
      cadence_n: 2,
      cadence_weekdays: null,
      satisfaction: "quantity",
      target_quantity: 2,
      unit: "litros",
    });
    const [{ n }] = await db<{ n: string }[]>`select count(*)::text as n from goals.commitments where user_id = ${person.id}`;
    expect(Number(n)).toBe(1);
  } finally {
    await context.close();
  }
});

test("saved: Hoy's loose group asks by the new days", async ({ person, browser, baseURL, db }) => {
  // Kills: a save that does not revalidate Hoy; weekdays left behind when the kind changes.
  const id = await seedHabit(db, person.id, "Estirar", { kind: "weekdays", days: [NOT_TODAY] });
  const { page, context } = await visit(browser, baseURL, person, "/", 360);
  try {
    expect(drawn(await page.locator("main").innerText()), "control: not asked today").not.toContain("estirar");
    await page.goto(frecuencia(id));
    await settled(page);
    await page.getByRole("button", { name: "todos los días", exact: true }).click();
    await save(page).click();
    await expect(page).toHaveURL(new RegExp(`${habitPath(id)}$`));
    await page.goto("/");
    await settled(page);
    const text = drawn(await page.locator("main").innerText());
    expect(text).toContain("hábitos");
    expect(text.indexOf("estirar")).toBeGreaterThan(text.indexOf("hábitos"));
  } finally {
    await context.close();
  }
});

test("pending: the button is disabled while the act runs and sends one request", async ({ person, browser, baseURL, db }) => {
  // Kills: dropping the pending guard on the edit mode.
  const id = await seedHabit(db, person.id, "Estirar", { kind: "daily" });
  const { page, context } = await visit(browser, baseURL, person, frecuencia(id), 360);
  try {
    await page.getByRole("button", { name: "veces por semana", exact: true }).click();
    await page.getByRole("spinbutton", { name: "veces por semana" }).fill("3");
    await holdActions(page, 1500);
    const posts = postCounter(page);
    await save(page).click();
    const busy = page.getByRole("button", { name: /^Guard/ });
    await expect(busy).toBeDisabled();
    await busy.click({ force: true });
    await expect(page).toHaveURL(new RegExp(`${habitPath(id)}$`));
    expect(posts).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("cancelled: «Cancelar» returns to the habit's screen and the cadence is unchanged", async ({ person, browser, baseURL, db }) => {
  // Kills: a cancel that saves the draft; a cancel that stays on the page.
  const id = await seedHabit(db, person.id, "Estirar", { kind: "daily" });
  const { page, context } = await visit(browser, baseURL, person, frecuencia(id), 360);
  try {
    const posts = postCounter(page);
    await page.getByRole("button", { name: "veces por semana", exact: true }).click();
    await page.getByRole("spinbutton", { name: "veces por semana" }).fill("3");
    await page.getByRole("link", { name: "Cancelar", exact: true }).or(page.getByRole("button", { name: "Cancelar", exact: true })).click();
    await expect(page).toHaveURL(new RegExp(`${habitPath(id)}$`));
    expect(posts).toHaveLength(0);
    expect(await rowOf(db, id)).toMatchObject({ cadence_kind: "daily", cadence_n: null });
  } finally {
    await context.close();
  }
});

test("a count past RP-12's bound is refused on the page, no request and no change", async ({ person, browser, baseURL, db }) => {
  // Kills: dropping the client bound in the habit's edit mode.
  const id = await seedHabit(db, person.id, "Estirar", { kind: "times_per_week", n: 3 });
  const { page, context } = await visit(browser, baseURL, person, frecuencia(id), 360);
  try {
    const posts = postCounter(page);
    await page.getByRole("spinbutton", { name: "veces por semana" }).fill("8");
    await save(page).click();
    await expect(page.getByText(WEEKS_BOUND)).toBeVisible();
    expect(posts).toHaveLength(0);
    expect((await rowOf(db, id)).cadence_n).toBe(3);
  } finally {
    await context.close();
  }
});

test("a habit with a fact, a retired one, an unknown one, another person's and a goal's commitment are not found, while a fact-less habit opens", async ({ person, personId, browser, baseURL, db }) => {
  // Kills: rendering the page without reading `factDayCount`, `retiredOn`, the owner or `goalId === null`.
  const open = await seedHabit(db, person.id, "Libre", { kind: "daily" });
  const withFact = await seedHabit(db, person.id, "Con hecho", { kind: "daily" });
  await seedFact(db, person.id, withFact, null, shift(TODAY, -1));
  const retired = await seedHabit(db, person.id, "Retirado", { kind: "daily" }, { kind: "tap" }, { retired: new Date() });
  const stranger = await seedHabit(db, personId, "Secreto ajeno", { kind: "daily" });
  const [goal] = await db<{ id: string }[]>`insert into goals.goals (user_id, name, horizon) values (${person.id}, 'Meta', null) returning id`;
  const [inGoal] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${person.id}, ${goal.id}, 'De una meta', 'daily', 'tap') returning id`;
  try {
    const control = await visit(browser, baseURL, person, frecuencia(open), 360);
    try {
      await expect(control.page.getByRole("button", { name: "todos los días", exact: true })).toBeVisible();
    } finally {
      await control.context.close();
    }
    for (const id of [withFact, retired, stranger, inGoal.id, "00000000-0000-4000-8000-000000000000", "xyz"]) {
      const { page, context } = await visit(browser, baseURL, person, frecuencia(id), 360);
      try {
        await expect(page.getByRole("heading", { name: "Esta página no existe" }), id).toBeVisible();
        await expect(page.getByRole("button", { name: "días sueltos", exact: true }), id).toHaveCount(0);
        await expect(page.getByText("Secreto ajeno"), id).toHaveCount(0);
      } finally {
        await context.close();
      }
    }
  } finally {
    await db`delete from goals.commitments where id = ${stranger} and user_id = ${personId}`;
  }
});

test("a habit with a fact shows «Cambiar la frecuencia» and «Borrar el hábito» disabled, with the reason once", async ({ person, browser, baseURL, db }) => {
  // Kills: hiding the refused acts with no reason on the habit's screen.
  const id = await seedHabit(db, person.id, "Con hecho", { kind: "daily" });
  await seedFact(db, person.id, id, null, shift(TODAY, -1));
  const { page, context } = await visit(browser, baseURL, person, habitPath(id), 360);
  try {
    await mainLower(page);
    await expect(page.getByRole("button", { name: "Cambiar la frecuencia", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Borrar el hábito", exact: true })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Cambiar la frecuencia", exact: true })).toHaveCount(0);
    await expect(page.getByText("Ya hay días hechos con esta frecuencia: retíralo y abre otro.", { exact: true })).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test("at 360 px the cadence page does not scroll sideways", async ({ person, browser, baseURL, db }) => {
  // Kills: a field or a chip row wider than the phone.
  const id = await seedHabit(db, person.id, "Estirar", { kind: "weekdays", days: [1, 3, 5] });
  const { page, context } = await visit(browser, baseURL, person, frecuencia(id), 360);
  try {
    await expect(save(page)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  } finally {
    await context.close();
  }
});
