import { test, expect } from "./fixtures";
import { MINUTES, monthsAhead, openAs, seedGoal, thisMonth, today } from "./meta-arbol-seed";
import { noOverflow, setNote } from "./mover-nota-ayuda";
import { civilDateToDate, civilDayMonthShort, dateToCivilDate } from "@/lib/zone";

// RP-144: an open goal's screen offers «Abrir en Claude», a new claude.ai chat in a new tab with the
// goal's brief already in its box: its note, what was done these last days with each task's note, and
// what is still open this month. An archived goal offers none.

function shift(day: string, by: number): string {
  const date = civilDateToDate(day);
  date.setUTCDate(date.getUTCDate() + by);
  return dateToCivilDate(date);
}

const open = "Abrir en Claude";
const PREFIX = "https://claude.ai/new?q=";

test("«Abrir en Claude» opens a new chat in a new tab with the goal, its note, what was done these days and what follows (RP-144)", async ({
  person,
  browser,
  baseURL,
  db,
}) => {
  const stamp = Date.now();
  const name = `Inglés ${stamp}`;
  const id = await seedGoal(db, person, { name, unit: MINUTES, horizon: monthsAhead(4) });
  await setNote(db, id, "Examen en marzo");
  const yesterday = shift(today, -1);
  const [done] = await db<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, name, planned_month, note)
    values (${person.id}, ${id}, ${`Lectura ${stamp}`}, ${thisMonth}::date, 'costó el vocabulario') returning id`;
  await db`insert into goals.facts (user_id, goal_id, one_off_id, day) values (${person.id}, ${id}, ${done.id}, ${yesterday}::date)`;
  await db`
    insert into goals.one_offs (user_id, goal_id, name, planned_month)
    values (${person.id}, ${id}, ${`Ensayo ${stamp}`}, ${thisMonth}::date)`;
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`);
  try {
    const link = page.getByRole("link", { name: new RegExp(`^${open} un chat nuevo con «${name}»`) });
    await expect(link).toHaveText(open);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(page.getByText("Abre un chat nuevo en claude.ai con tu plan y lo que hiciste estos días ya escrito.")).toBeVisible();
    const href = (await link.getAttribute("href")) ?? "";
    expect(href.startsWith(PREFIX)).toBe(true);
    const brief = decodeURIComponent(href.slice(PREFIX.length));
    expect(brief).toContain(`Estoy siguiendo mi meta «${name}» en GoalLog.`);
    expect(brief).toContain("Nota de la meta: Examen en marzo");
    expect(brief).toContain(`- ${civilDayMonthShort(yesterday)}: Lectura ${stamp} (nota: costó el vocabulario)`);
    expect(brief).toContain(`Lo que sigue:\n- Ensayo ${stamp}`);
    expect(brief).toContain(`Hoy es ${civilDayMonthShort(today)}.`);
    await noOverflow(page);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${id}`;
  }
});

test("an archived goal offers no «Abrir en Claude» (RP-144)", async ({ person, browser, baseURL, db }) => {
  const name = `Archivada ${Date.now()}`;
  const id = await seedGoal(db, person, { name, unit: MINUTES, horizon: monthsAhead(4), archived: new Date() });
  const { page, context } = await openAs(browser, baseURL, person, `/metas/${id}`);
  try {
    await expect(page.getByRole("button", { name: "Reabrir" }).or(page.getByRole("heading", { name })).first()).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(`^${open}`) })).toHaveCount(0);
  } finally {
    await context.close();
    await db`delete from goals.goals where id = ${id}`;
  }
});
