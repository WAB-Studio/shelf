import type { Page } from "@playwright/test";
import type postgres from "postgres";

import messages from "../messages/es/import.json";
import { test, expect } from "./fixtures";
import { boxOf } from "./box";
import { asPerson, months, plus, toOpenReview, word } from "./importar-plan";
import { todayInZone } from "../lib/zone";

// RP-130, module 1022: a draft goal one open goal already names is drawn as «Actualiza tu meta», with the
// differences the import would apply listed under it, and is updated only when the person confirms. Written
// from the contract and the person's decision of 2026-10-15 (merge, never remove; open goals only, by name;
// two open goals of one name are not updated), not from the screen. Nothing here calls a model: every plan is
// the template, read on the server without one.

const LEER = "Leer";
const NEW = "Escribir";
const RELEER = "Releer";
const REPASAR = "Repasar";
const CHAPTER = "Leer capítulo";
const STUDY = ["Estudio", "minutos"] as const;

type Block = {
  name: string;
  horizon?: string;
  measure?: boolean;
  months?: string[];
  phases?: string[];
  commitments?: string[];
  tasks?: string[];
};

function block(b: Block): string {
  const lines = [`# ${b.name}`, `horizonte: ${b.horizon ?? plus(400)}`];
  if (b.measure !== false) lines.push("medida: Estudio · minutos");
  for (const [title, list] of [["Fases", b.phases], ["Meses", b.months], ["Compromisos", b.commitments], ["Tareas", b.tasks]] as const) {
    if (list && list.length > 0) lines.push("", `## ${title}`, ...list.map((l) => (l.startsWith("  ") ? l : `- ${l}`)));
  }
  return lines.join("\n");
}

const planOf = (...blocks: Block[]) => ["pulsar · plantilla 2", "", blocks.map(block).join("\n\n")].join("\n");

// «Leer» as the person's plan says it, with five differences against `openLeer`: a later end, 2 h in the second
// month, one commitment and one task the open goal lacks, and (from the open goal's own «Releer») one part it omits.
function leerBlock(over: Partial<Block> = {}): Block {
  const { first, second } = months();
  return {
    name: LEER,
    months: [`${first} · 1 h`, `${second} · 2 h`],
    commitments: [`${REPASAR} · cada día · toque`],
    tasks: [`${first} · 1 h · ${CHAPTER}`],
    ...over,
  };
}

// A new goal beside the update, so the plan always has one to create («Crear 1 meta»).
function newBlock(): Block {
  const { first } = months();
  return { name: NEW, months: [`${first} · 1 h`], tasks: [`${first} · 1 h · Hacer`, `  nota: algo que decir`] };
}

type Db = postgres.Sql;

async function openGoal(db: Db, userId: string, name: string, o: { horizon?: string; archived?: boolean; measure?: boolean } = {}): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, archived_at)
    values (${userId}, ${name}, ${o.horizon ?? plus(300)}, ${o.measure === false ? null : STUDY[0]}, ${o.measure === false ? null : STUDY[1]},
            ${o.archived ? new Date().toISOString() : null})
    returning id`;
  return row.id;
}

const budget = (db: Db, userId: string, goalId: string, month: string, amount: number) =>
  db`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${userId}, ${goalId}, ${`${month}-01`}::date, ${amount})`;

async function commitment(db: Db, userId: string, goalId: string, name: string, position = 1000): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, position)
    values (${userId}, ${goalId}, ${name}, 'daily', 'tap', ${position}) returning id`;
  return row.id;
}

// The open «Leer» of the person: the plan's measure, the plan's first month, a different end and second month,
// and a commitment the plan never names.
async function openLeer(db: Db, userId: string): Promise<string> {
  const { first, second } = months();
  const id = await openGoal(db, userId, LEER);
  await budget(db, userId, id, first, 60);
  await budget(db, userId, id, second, 60);
  await commitment(db, userId, id, RELEER);
  return id;
}

const rowOf = (page: Page, name: RegExp | string) => page.getByRole("checkbox", { name });
const updateRow = (page: Page, goal = LEER) => rowOf(page, new RegExp(`^${messages.review.update.replace("{goal}", goal)}`));
const line = (page: Page, text: string | RegExp) => page.getByText(text, typeof text === "string" ? { exact: true } : undefined);
const confirm = (page: Page, count = 1) => page.getByRole("button", { name: count === 1 ? "Crear 1 meta" : `Crear ${count} metas` });

// The goal's whole row as the database holds it, to prove a goal was left as it was.
const goalJson = async (db: Db, id: string) => (await db`select to_jsonb(g) as r from goals.goals g where id = ${id}`)[0].r;
const partsOf = async (db: Db, id: string) =>
  JSON.stringify(
    await db`
      select * from (
        select 'b' as t, to_jsonb(b) as r from goals.month_budgets b where goal_id = ${id}
        union all select 'p', to_jsonb(p) from goals.phases p where goal_id = ${id}
        union all select 'c', to_jsonb(c) from goals.commitments c where goal_id = ${id}
        union all select 'o', to_jsonb(o) from goals.one_offs o where goal_id = ${id}
      ) parts order by t, r::text`,
  );

const DIFFS = (second: string) => [
  /^Cambia el final al \S/,
  new RegExp(`^Pone 2 h en ${word(second)}`),
  `Agrega el compromiso «${REPASAR}»`,
  `Agrega la tarea «${CHAPTER}»`,
  "Se queda 1 parte que el plan no nombra",
];

test.describe("an import that updates the goals the person already has (RP-130)", () => {
  test("a goal an open goal names reads «Actualiza tu meta», and each difference is one line under it, in order, with nothing else", async ({ person, browser, baseURL, db }) => {
    // Kills: keeping the created-goal wording for a matched goal; rendering no difference lines; rendering lines for what
    // already agrees (measure, month one, note, rhythm); a stays line that is not counted; the create button counting the update.
    await openLeer(db, person.id);
    const { second } = months();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planOf(leerBlock(), newBlock()));

      await expect(updateRow(page)).toBeVisible();
      await expect(updateRow(page)).toBeChecked();
      // A goal row reads its name then «meta · …»; the task «Leer capítulo» inside the goal is not a created «Leer».
      await expect(rowOf(page, new RegExp(`^${LEER}meta`))).toHaveCount(0);

      let above = (await boxOf(updateRow(page))).y;
      for (const text of DIFFS(second)) {
        const at = (await boxOf(line(page, text))).y;
        expect(at).toBeGreaterThan(above);
        above = at;
      }
      // The measure and the first month are the same as the plan's: no line says they change.
      await expect(line(page, /^Cambia (la medida|el ritmo|la nota)/)).toHaveCount(0);
      await expect(line(page, /^Pone /)).toHaveCount(1);
      await expect(line(page, messages.review.noChange)).toHaveCount(0);
      // One goal is created, not two: the update is not a creation.
      await expect(confirm(page)).toBeEnabled();
    });
  });

  test("a goal whose only difference is a part the plan leaves out, and one with none, both read «Ya está como dice el plan.»", async ({ person, browser, baseURL, db }) => {
    // Kills: counting `stays` as a change that hides «Ya está…»; dropping the line for an identical goal.
    const extra = await openGoal(db, person.id, LEER);
    await commitment(db, person.id, extra, RELEER);
    await openGoal(db, person.id, "Correr");
    await asPerson({ person, browser, baseURL }, async (page) => {
      const same = (name: string): Block => ({ name, horizon: plus(300) });
      await toOpenReview(page, planOf(same(LEER), same("Correr"), newBlock()));

      await expect(updateRow(page)).toBeVisible();
      await expect(updateRow(page, "Correr")).toBeVisible();
      await expect(line(page, messages.review.noChange)).toHaveCount(2);
      await expect(line(page, /^(Cambia|Pone|Agrega|Mueve)/)).toHaveCount(0);
    });
  });

  test("confirming updates the open goal, adds what the plan names, removes nothing, and creates no second «Leer»", async ({ person, browser, baseURL, db }) => {
    // Kills: sending no `updates` (the matched goal is skipped and nothing changes); creating the matched goal again;
    // removing the commitment the plan does not name.
    const id = await openLeer(db, person.id);
    const { first, second } = months();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planOf(leerBlock(), newBlock()));
      await confirm(page).click();
      await expect(page).toHaveURL(/\/metas$/);

      const named = await db`select id, horizon::text as horizon from goals.goals where user_id = ${person.id} and name = ${LEER}`;
      expect(named.map((r) => r.id)).toEqual([id]);
      expect(named[0].horizon).toBe(plus(400));
      const budgets = await db`select to_char(month, 'YYYY-MM') as month, amount from goals.month_budgets where goal_id = ${id} order by month`;
      expect(budgets.map((r) => [r.month, r.amount])).toEqual([[first, 60], [second, 120]]);
      const kept = await db`select name, retired_at from goals.commitments where goal_id = ${id} order by position, created_at, id`;
      expect(kept.map((r) => r.name)).toEqual([RELEER, REPASAR]);
      expect(kept.every((r) => r.retired_at === null)).toBe(true);
      const tasks = await db`select name from goals.one_offs where goal_id = ${id}`;
      expect(tasks.map((r) => r.name)).toEqual([CHAPTER]);
      expect(await db`select 1 from goals.goals where user_id = ${person.id} and name = ${NEW}`).toHaveLength(1);
    });
  });

  test("the done screen counts the goal updated apart from the goal created", async ({ person, browser, baseURL, db }) => {
    // Kills: counting the updated goal among those created («Se crearon 2 metas»); omitting the updated count.
    // The created goal's task carries a blank note, which meets the table at the insert, so the result screen stands.
    await openLeer(db, person.id);
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planOf(leerBlock(), newBlock()));
      await page.evaluate((task) => {
        const stored = JSON.parse(sessionStorage.getItem("pulsar.import-draft")!);
        let hit = 0;
        for (const goal of stored.draft.goals) for (const t of goal.tasks) if (t.name === task) { t.note = "   "; hit++; }
        if (hit !== 1) throw new Error(`expected one task named ${task}, found ${hit}`);
        sessionStorage.setItem("pulsar.import-draft", JSON.stringify(stored));
      }, "Hacer");
      await page.reload();
      await expect(confirm(page)).toBeVisible();
      await confirm(page).click();

      await expect(page.getByRole("heading", { name: "Plan creado", exact: true })).toBeVisible();
      await expect(page.getByText("1 meta actualizada", { exact: true })).toBeVisible();
      await expect(page.getByText(/Se creó 1 meta con todo su plan/)).toBeVisible();
    });
  });

  test("a matched goal the person unmarks is neither created nor updated", async ({ person, browser, baseURL, db }) => {
    // Kills: sending the update for an unmarked goal; creating a goal the person unmarked.
    const id = await openLeer(db, person.id);
    const before = { goal: await goalJson(db, id), parts: await partsOf(db, id) };
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planOf(leerBlock(), newBlock()));
      await expect(updateRow(page)).toBeChecked();
      await updateRow(page).uncheck();
      await expect(confirm(page)).toBeEnabled();
      await confirm(page).click();
      await expect(page).toHaveURL(/\/metas$/);

      expect(await db`select 1 from goals.goals where user_id = ${person.id} and name = ${LEER}`).toHaveLength(1);
      expect(await goalJson(db, id)).toEqual(before.goal);
      expect(await partsOf(db, id)).toBe(before.parts);
      expect(await db`select 1 from goals.goals where user_id = ${person.id} and name = ${NEW}`).toHaveLength(1);
    });
  });

  test("a goal that changed while the person reviewed shows the stale line at the goal, keeps the review, and writes nothing", async ({ person, browser, baseURL, db }) => {
    // Kills: leaving the review on a refusal; showing the refusal away from its goal; writing the other goals anyway.
    const id = await openLeer(db, person.id);
    const { second } = months();
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planOf(leerBlock(), newBlock()));
      const before = { goal: await goalJson(db, id), parts: await partsOf(db, id) };
      // The second month now says what the plan says: the differences the review showed no longer hold.
      await db`update goals.month_budgets set amount = 120 where goal_id = ${id} and month = ${`${second}-01`}::date`;

      await confirm(page).click();
      const stale = page.getByText(messages.errors.reviewStale, { exact: true }).first();
      await expect(stale).toBeVisible();
      await expect(page).toHaveURL(/\/metas\/importar\/revisar$/);
      await expect(updateRow(page)).toBeVisible();
      const at = (await boxOf(stale)).y;
      expect(at).toBeGreaterThan((await boxOf(updateRow(page))).y);
      expect(at).toBeLessThan((await boxOf(rowOf(page, new RegExp(`^${NEW}`)))).y);
      await expect(confirm(page)).toBeEnabled();

      expect(await db`select 1 from goals.goals where user_id = ${person.id} and name = ${NEW}`).toHaveLength(0);
      expect((await goalJson(db, id)).horizon).toBe(before.goal.horizon);
      const rows = JSON.parse(await partsOf(db, id)) as { t: string }[];
      expect(rows.filter((r) => r.t === "o" || r.t === "p")).toHaveLength(0);
      expect(rows.filter((r) => r.t === "c")).toHaveLength(1);
    });
  });

  test("a plan with a phase that started before today is not stale: the review fingerprints the cut draft the server compares", async ({ person, browser, baseURL, db }) => {
    // Kills: computing the fingerprints on the draft as read instead of `withCutPhases` (every such plan reads reviewStale).
    const id = await openLeer(db, person.id);
    const aim = "Diagnóstico";
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planOf(leerBlock({ phases: [`${plus(-10)} a ${plus(20)} · ${aim}`] }), newBlock()));
      await expect(line(page, new RegExp(`^Agrega la fase «${aim}»`))).toBeVisible();
      await confirm(page).click();
      await expect(page).toHaveURL(/\/metas$/);

      const made = await db`select starts_on::text as starts_on, ends_on::text as ends_on from goals.phases where goal_id = ${id} and aim = ${aim}`;
      expect(made).toHaveLength(1);
      expect(made[0].starts_on).toBe(todayInZone());
      expect(made[0].ends_on).toBe(plus(20));
    });
  });

  test("a commitment with days noted is said to be retired and reopened; confirming keeps its days", async ({ person, browser, baseURL, db }) => {
    // Kills: a line for a changed cadence that hides that the old commitment is retired; writing over a commitment facts depend on.
    const id = await openGoal(db, person.id, LEER);
    const old = await commitment(db, person.id, id, REPASAR);
    await db`insert into goals.facts (user_id, goal_id, commitment_id, day) values (${person.id}, ${id}, ${old}, ${todayInZone()}::date)`;
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planOf({ name: LEER, horizon: plus(300), commitments: [`${REPASAR} · martes y jueves · toque`] }, newBlock()));
      await expect(line(page, `«${REPASAR}» ya tiene días anotados: se retira y se abre otro con el nuevo ritmo`)).toBeVisible();
      await confirm(page).click();
      await expect(page).toHaveURL(/\/metas$/);

      const all = await db`select id, retired_at, cadence_kind from goals.commitments where goal_id = ${id} order by created_at, id`;
      expect(all).toHaveLength(2);
      expect(all[0].id).toBe(old);
      expect(all[0].retired_at).not.toBeNull();
      expect(all[1].retired_at).toBeNull();
      expect(all[1].cadence_kind).toBe("weekdays");
      expect(await db`select 1 from goals.facts where commitment_id = ${old}`).toHaveLength(1);
    });
  });

  test("two open goals of one name are not updated: the review says why, leaves it unmarked, and the one-match goal beside it is updated", async ({ person, browser, baseURL, db }) => {
    // Kills: treating two open goals as a match (the row reads «Actualiza…» or one of them is written); a one-match goal
    // beside an ambiguous one losing its update.
    const a = await openGoal(db, person.id, LEER);
    const b = await openGoal(db, person.id, LEER);
    const other = await openGoal(db, person.id, NEW, { horizon: plus(300) });
    const before = { a: await goalJson(db, a), b: await goalJson(db, b) };
    const { first } = months();
    await asPerson({ person, browser, baseURL }, async (page) => {
      const twice: Block = { name: LEER, horizon: plus(400) };
      const once: Block = { name: NEW, horizon: plus(400), tasks: [`${first} · 1 h · Hacer`] };
      await toOpenReview(page, planOf(twice, once, { name: "Correr", months: [`${first} · 1 h`] }));

      await expect(page.getByRole("note").filter({ hasText: messages.review.repeated })).toHaveCount(1);
      await expect(rowOf(page, new RegExp(`^${LEER}`))).not.toBeChecked();
      await expect(updateRow(page)).toHaveCount(0);
      await expect(updateRow(page, NEW)).toBeChecked();
      await expect(line(page, `Agrega la tarea «Hacer»`)).toBeVisible();
      await expect(confirm(page)).toBeEnabled();

      await confirm(page).click();
      await expect(page).toHaveURL(/\/metas$/);
      expect(await goalJson(db, a)).toEqual(before.a);
      expect(await goalJson(db, b)).toEqual(before.b);
      expect(await db`select 1 from goals.goals where user_id = ${person.id} and name = ${LEER}`).toHaveLength(2);
      expect((await goalJson(db, other)).horizon).toBe(plus(400));
      expect(await db`select 1 from goals.one_offs where goal_id = ${other} and name = 'Hacer'`).toHaveLength(1);
      expect(await db`select 1 from goals.goals where user_id = ${person.id} and name = 'Correr'`).toHaveLength(1);
    });
  });

  test("a goal matches by name with case and spaces ignored, accents counted, and only among open goals", async ({ person, browser, baseURL, db }) => {
    // Kills: matching on the exact string; folding accents; matching an archived goal.
    const spaced = await openGoal(db, person.id, "  leer   MÁS ");
    await openGoal(db, person.id, "Escribir mas");
    await openGoal(db, person.id, "Correr", { archived: true });
    await asPerson({ person, browser, baseURL }, async (page) => {
      const goal = (name: string): Block => ({ name, horizon: plus(400) });
      await toOpenReview(page, planOf(goal("Leer más"), goal("Escribir más"), goal("Correr")));

      await expect(rowOf(page, /^Actualiza tu meta «\s*leer\s+más\s*»/i)).toBeChecked();
      await expect(rowOf(page, /^Actualiza tu meta «Escribir/i)).toHaveCount(0);
      await expect(rowOf(page, /^Actualiza tu meta «Correr/i)).toHaveCount(0);
      await expect(rowOf(page, /^Escribir más/)).toBeChecked();
      await expect(rowOf(page, /^Correr/)).toBeChecked();
      await expect(confirm(page, 2)).toBeEnabled();

      await confirm(page, 2).click();
      await expect(page).toHaveURL(/\/metas$/);
      expect((await goalJson(db, spaced)).horizon).toBe(plus(400));
      expect(await db`select 1 from goals.goals where user_id = ${person.id} and archived_at is null and lower(btrim(regexp_replace(name, '[[:space:]]+', ' ', 'g'))) = 'leer más'`).toHaveLength(1);
      expect(await db`select 1 from goals.goals where user_id = ${person.id} and name = 'Escribir más'`).toHaveLength(1);
      expect(await db`select 1 from goals.goals where user_id = ${person.id} and name = 'Escribir mas'`).toHaveLength(1);
      expect(await db`select 1 from goals.goals where user_id = ${person.id} and name = 'Correr' and archived_at is null`).toHaveLength(1);
      expect(await db`select 1 from goals.goals where user_id = ${person.id} and name = 'Correr' and archived_at is not null`).toHaveLength(1);
    });
  });

  test("a second tap on «Crear» while the first is in flight sends nothing more, and the update is written once", async ({ person, browser, baseURL, db }) => {
    // Kills: dropping the pending guard (two confirms reach the server).
    const id = await openLeer(db, person.id);
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planOf(leerBlock(), newBlock()));
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let posts = 0;
      await page.route("**/metas/importar/revisar", async (route) => {
        if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
          posts++;
          await gate;
        }
        await route.continue();
      });
      await confirm(page).dblclick();
      const busy = page.getByRole("button", { name: messages.review.creating });
      await expect(busy).toBeDisabled();
      expect(posts).toBe(1);
      release();
      await expect(page).toHaveURL(/\/metas$/);
      expect(posts).toBe(1);
      expect(await db`select 1 from goals.goals where user_id = ${person.id} and name = ${NEW}`).toHaveLength(1);
      expect((await goalJson(db, id)).horizon).toBe(plus(400));
    });
  });

  test("the button names what happens and counts only what is done: an update-only plan reads «Actualizar 1 meta», a mixed one «Crear 1 meta y actualizar 1»", async ({ person, browser, baseURL, db }) => {
    // Kills: counting the update among the created; a button that stays «Crear 0 metas» (disabled) on a plan that only updates.
    const id = await openLeer(db, person.id);
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planOf(leerBlock(), newBlock()));
      await expect(page.getByRole("button", { name: "Crear 1 meta y actualizar 1", exact: true })).toBeEnabled();
    });
    await asPerson({ person, browser, baseURL }, async (page) => {
      await toOpenReview(page, planOf(leerBlock()));
      const only = page.getByRole("button", { name: "Actualizar 1 meta", exact: true });
      await expect(only).toBeEnabled();
      await only.click();
      await expect(page).toHaveURL(/\/metas$/);
      expect((await goalJson(db, id)).horizon).toBe(plus(400));
      expect(await db`select 1 from goals.goals where user_id = ${person.id} and name = ${LEER}`).toHaveLength(1);
    });
  });

  for (const width of [360, 1280]) {
    test(`a long list of differences holds at ${width}: no horizontal scroll, every line drawn`, async ({ person, browser, baseURL, db }) => {
      // Kills: a difference line that does not wrap; a list cut short.
      const { first } = months();
      await openGoal(db, person.id, LEER);
      const tasks = Array.from({ length: 14 }, (_, i) => `${first} · 5 min · Tarea ${i + 1} con un nombre bastante largo para probar que la línea de la diferencia se parte`);
      await asPerson(
        { person, browser, baseURL },
        async (page) => {
          await toOpenReview(page, planOf({ name: LEER, horizon: plus(300), months: [`${first} · 2 h`], tasks }, newBlock()));
          await expect(line(page, /^Agrega la tarea «Tarea \d+ con un nombre/)).toHaveCount(14);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          const last = line(page, /^Agrega la tarea «Tarea 14 /);
          const at = await boxOf(last);
          expect(at.x + at.width).toBeLessThanOrEqual(width);
        },
        { width, height: 800 },
      );
    });
  }
});
