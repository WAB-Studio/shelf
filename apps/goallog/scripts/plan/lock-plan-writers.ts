// The plan's writers under one person lock (RP-79, RP-99, RP-15, RP-50, RP-12):
// the screen and the AI writing to the same goal in the same instant leave the
// tree, the phases and the holders as one writer after the other would.
// Each race is driven for real by `interleave`: the first act's write is held
// uncommitted while the second runs. The admin pool only reads rows back.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { actor, admin, close, interleave, open, type Acts, type Person } from "./lib/race";

let acts: Acts;
let owner: Person;
let as: ReturnType<typeof actor>;
let year: number;
let thisMonth: string;

before(async () => {
  delete process.env.PULSAR_CLOCK;
  const opened = await open(1);
  acts = opened.acts;
  [owner] = opened.people;
  as = actor(acts, owner);
  const today = (await import("@/lib/zone")).todayInZone();
  year = Number(today.slice(0, 4)) + 1;
  thisMonth = today.slice(0, 7);
});

after(async () => {
  delete process.env.PULSAR_CLOCK;
  await close([owner]);
});

async function goal(name: string, horizon: string | null, parentId?: string): Promise<string> {
  const made = await as(() => acts.plan.createGoal({ name, horizon, ...(parentId ? { parentId } : {}) }));
  if (!made.ok) throw new Error(`createGoal ${name}: ${made.error}`);
  return made.goalId;
}

async function measured(name: string): Promise<string> {
  const id = await goal(name, `${year}-12-31`);
  const set = await as(() => acts.plan.setGoalMeasure({ goalId: id, name: "páginas", unit: "páginas" }));
  if (!set.ok) throw new Error(`setGoalMeasure ${name}: ${set.error}`);
  return id;
}

type GoalRow = {
  id: string;
  parent_id: string | null;
  horizon: string | null;
  archived_at: Date | null;
  measure_unit: string | null;
  rhythm: number | null;
};

async function rowOf(id: string): Promise<GoalRow> {
  const [row] = await admin<GoalRow[]>`
    select id, parent_id, horizon::text as horizon, archived_at, measure_unit, rhythm from goals.goals where id = ${id}`;
  return row;
}

async function childrenOf(id: string): Promise<GoalRow[]> {
  return admin<GoalRow[]>`
    select id, parent_id, horizon::text as horizon, archived_at, measure_unit, rhythm
    from goals.goals where parent_id = ${id}`;
}

const show = (value: unknown) => JSON.stringify(value);

// ------------------------------------------------------------ 4a horizon vs child

for (const order of ["create first", "move first"] as const) {
  test(`4a: moveHorizon(P → Jun) racing createGoal(child of P, Dec), ${order}: no child ends after P`, async () => {
    const p = await goal(`4a ${order} P`, `${year}-12-31`);
    const create = () => as(() => acts.plan.createGoal({ name: `4a ${order} hija`, horizon: `${year}-12-01`, parentId: p }));
    const move = () => as(() => acts.plan.moveHorizon({ goalId: p, horizon: `${year}-06-30` }));
    const run = order === "create first" ? await interleave(create, move) : await interleave(move, create);

    const parent = await rowOf(p);
    const kids = await childrenOf(p);
    for (const kid of kids) {
      assert.ok(
        kid.horizon !== null && parent.horizon !== null && kid.horizon <= parent.horizon,
        `child ends ${kid.horizon} under P ending ${parent.horizon}; answers ${show(run)}`,
      );
    }
    assert.equal(
      [run.first, run.second].filter((answer) => answer.ok).length,
      1,
      `exactly one of the two lands: ${show(run)}`,
    );
  });
}

// ------------------------------------------------------------ 4b horizon vs phase

for (const order of ["phase first", "move first"] as const) {
  test(`4b: moveHorizon(Mar) racing addPhase(to Jun), ${order}: no phase ends after the horizon`, async () => {
    const g = await goal(`4b ${order}`, `${year}-12-31`);
    const phase = () =>
      as(() => acts.plan.addPhase({ goalId: g, aim: "junio", startsOn: `${year}-06-01`, endsOn: `${year}-06-30` }));
    const move = () => as(() => acts.plan.moveHorizon({ goalId: g, horizon: `${year}-03-31` }));
    const run = order === "phase first" ? await interleave(phase, move) : await interleave(move, phase);

    const { horizon } = await rowOf(g);
    const late = await admin<{ ends_on: string }[]>`
      select ends_on::text as ends_on from goals.phases where goal_id = ${g} and ends_on > ${horizon}::date`;
    assert.deepEqual(late, [], `horizon ${horizon}; answers ${show(run)}`);
    assert.equal([run.first, run.second].filter((answer) => answer.ok).length, 1, show(run));
  });
}

// ------------------------------------------------------------ 4c archive vs child

async function openUnderArchived(root: string): Promise<GoalRow[]> {
  return admin<GoalRow[]>`
    with recursive branch as (
      select id from goals.goals where id = ${root}
      union all select g.id from goals.goals g join branch b on g.parent_id = b.id
    )
    select c.id, c.parent_id, c.horizon::text as horizon, c.archived_at, c.measure_unit, c.rhythm
    from goals.goals c join goals.goals p on p.id = c.parent_id
    where c.id in (select id from branch) and c.archived_at is null and p.archived_at is not null`;
}

for (const order of ["create first", "archive first"] as const) {
  test(`4c: archiveGoal(P) racing createGoal(under P), ${order}: no open goal under an archived one`, async () => {
    const p = await goal(`4c ${order} P`, `${year}-12-31`);
    const create = () => as(() => acts.plan.createGoal({ name: `4c ${order} hija`, horizon: `${year}-11-30`, parentId: p }));
    const archive = () => as(() => acts.plan.archiveGoal({ goalId: p }));
    const run = order === "create first" ? await interleave(create, archive) : await interleave(archive, create);

    assert.notEqual((await rowOf(p)).archived_at, null, `P is archived: ${show(run)}`);
    assert.deepEqual(await openUnderArchived(p), [], show(run));
  });
}

test("4c: reopenGoal(child) racing archiveGoal(P): the child does not reopen under an archived P", async () => {
  const p = await goal("4c reabrir P", `${year}-12-31`);
  const child = await goal("4c reabrir hija", `${year}-11-30`, p);
  const archivedAlone = await as(() => acts.plan.archiveGoal({ goalId: child }));
  assert.deepEqual(archivedAlone, { ok: true, archived: 1 });

  const run = await interleave(
    () => as(() => acts.plan.archiveGoal({ goalId: p })),
    () => as(() => acts.plan.reopenGoal({ goalId: child })),
  );

  assert.notEqual((await rowOf(p)).archived_at, null, show(run));
  assert.deepEqual(await openUnderArchived(p), [], show(run));
  assert.equal(run.second.ok, false, `reopen is refused once P is archived: ${show(run)}`);
});

// ------------------------------------------------------------ 4d holders

test("4d: setMonthBudget(G) racing createGoal(under G): G ends with no amount or the create is refused", async () => {
  const g = await measured("4d monto G");
  const run = await interleave(
    () => as(() => acts.plan.createGoal({ name: "4d monto hija", horizon: `${year}-11-30`, parentId: g })),
    () => as(() => acts.budgets.setMonthBudget({ goalId: g, month: thisMonth, amount: 40 })),
  );
  const [{ amounts }] = await admin<{ amounts: number }[]>`
    select count(*)::int as amounts from goals.month_budgets where goal_id = ${g}`;
  assert.ok(amounts === 0 || !run.first.ok, `G holds ${amounts} amount(s); answers ${show(run)}`);
  assert.ok(!(run.first.ok && run.second.ok), `a holder never takes an amount: ${show(run)}`);
});

test("4d: setRhythm(G) racing createGoal(under G): G ends with no rhythm or the create is refused", async () => {
  const g = await measured("4d ritmo G");
  const run = await interleave(
    () => as(() => acts.plan.createGoal({ name: "4d ritmo hija", horizon: `${year}-11-30`, parentId: g })),
    () => as(() => acts.roadmap.setRhythm({ goalId: g, amount: 40 })),
  );
  const { rhythm } = await rowOf(g);
  assert.ok(rhythm === null || !run.first.ok, `G's rhythm is ${rhythm}; answers ${show(run)}`);
  assert.ok(!(run.first.ok && run.second.ok), show(run));
});

test("4d: setGoalMeasure(G) racing createGoal(under G): a holder never takes a measure its goals do not share", async () => {
  const g = await goal("4d medida G", `${year}-12-31`);
  const run = await interleave(
    () => as(() => acts.plan.createGoal({ name: "4d medida hija", horizon: `${year}-11-30`, parentId: g })),
    () => as(() => acts.plan.setGoalMeasure({ goalId: g, name: "páginas", unit: "páginas" })),
  );
  const holder = await rowOf(g);
  const kids = (await childrenOf(g)).filter((kid) => kid.archived_at === null);
  if (holder.measure_unit !== null) {
    for (const kid of kids) assert.equal(kid.measure_unit, holder.measure_unit, `G measures, its goal does not: ${show(run)}`);
  }
  assert.ok(!(run.first.ok && run.second.ok), `a holder is never given a measure: ${show(run)}`);
});

// ------------------------------------------------------------ 7 one unit

test("7: two quantity habits in km and min at once on an unmeasured goal: both in the goal's one unit", async () => {
  const g = await goal("7 una unidad", `${year}-12-31`);
  const habit = (unit: string) => () =>
    as(() =>
      acts.plan.addCommitment({
        goalId: g,
        name: `7 hábito ${unit}`,
        cadenceKind: "daily",
        satisfaction: "quantity",
        targetQuantity: 5,
        unit,
      } as never),
    );
  const run = await interleave(habit("km"), habit("min"));

  const { measure_unit } = await rowOf(g);
  assert.notEqual(measure_unit, null, show(run));
  const units = await admin<{ unit: string | null }[]>`select unit from goals.commitments where goal_id = ${g}`;
  assert.ok(units.length >= 1, show(run));
  for (const { unit } of units) assert.equal(unit, measure_unit, `a habit in ${unit} under a goal in ${measure_unit}`);
});

// ------------------------------------------------------------ 8 retire once

function nextDay(day: string): string {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

test("8: a habit retired twice, a day apart, keeps its first day and answers ok the second time", async () => {
  const g = await goal("8 retirar", `${year}-12-31`);
  const made = await as(() =>
    acts.plan.addCommitment({ goalId: g, name: "8 hábito", cadenceKind: "daily", satisfaction: "tap" } as never),
  );
  if (!made.ok) throw new Error(`addCommitment: ${made.error}`);
  const { todayInZone } = await import("@/lib/zone");
  const first = nextDay(todayInZone());
  const second = nextDay(first);
  const retiredDay = async () => {
    const [row] = await admin<{ day: string }[]>`
      select (retired_at at time zone 'America/Bogota')::date::text as day
      from goals.commitments where id = ${made.commitmentId}`;
    return row.day;
  };
  try {
    process.env.PULSAR_CLOCK = first;
    assert.deepEqual(await as(() => acts.plan.retireCommitment({ commitmentId: made.commitmentId })), { ok: true });
    assert.equal(await retiredDay(), first);
    process.env.PULSAR_CLOCK = second;
    assert.deepEqual(await as(() => acts.plan.retireCommitment({ commitmentId: made.commitmentId })), { ok: true });
    assert.equal(await retiredDay(), first, "the second retire moved the retirement day");
  } finally {
    delete process.env.PULSAR_CLOCK;
  }
});

test("8: retiring a missing habit is still notFound", async () => {
  const missing = await as(() => acts.plan.retireCommitment({ commitmentId: "00000000-0000-4000-8000-00000000a008" }));
  assert.deepEqual(missing, { ok: false, error: "plan.errors.notFound" });
});
