// Proves the guards of the goal actions (`app/actions/plan.ts`, `facts.ts`,
// `one-offs.ts`) from outside the browser — the same door
// `scripts/harness/seed-goal.ts` already opens (verbatim comment there): every
// action here is `"use server"`, which the Next compiler reads at build time
// and a plain script never sees, so imported directly these run as the
// ordinary async functions they are. `server-only`, `next/headers` and
// `next/cache` are stubbed the same way, before the first `@/`-rooted import,
// and the real session cookie `harness:mint-session` left standing is what
// `getPerson()` sees — nothing here fabricates a claim.
//
// Every refusal is read back as a count or a column that did not move; each
// fixture is deleted by its exact id. Dates are built from `todayInZone()`,
// never frozen.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import { assertSuiteDatabase } from "@repo/harness-registry";
import postgres from "postgres";

function laneNumber(): number {
  const raw = process.env.HARNESS_LANE?.trim();
  if (!raw) return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`HARNESS_LANE must be a positive integer, not "${raw}"`);
  }
  return Number(raw);
}

const lane = laneNumber();

// Lane 1 carries no number: `harness-member@…`, as orbit's `harness:token` names it.
const memberEmail = `harness-member${lane === 1 ? "" : `-${lane}`}@example.invalid`;

function sessionFile(): string {
  return resolve(process.cwd(), `private/session-${lane}.json`);
}

type StoredCookie = { name: string; value: string };

function loadCookies(): StoredCookie[] {
  const file = sessionFile();
  let state: { cookies: StoredCookie[] };
  try {
    state = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`no session at ${file} — run harness:mint-session first`);
  }
  if (state.cookies.length === 0) {
    throw new Error(`${file} carries no cookie — the mint did not land one`);
  }
  return state.cookies.map(({ name, value }) => ({ name, value }));
}

// Every path the `next/cache` stub received, in call order.
const revalidated: string[] = [];

function installStubs(cookies: StoredCookie[]): void {
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/headers") {
      return { cookies: async () => ({ getAll: () => cookies, set() {} }) };
    }
    if (request === "next/cache") {
      return { revalidatePath: (path: string) => void revalidated.push(path) };
    }
    return originalLoad(request, parent, isMain);
  };
}

// `node --test` runs a CommonJS-compiled entry, which cannot carry a
// top-level `await` — installed and imported in `before`, the same ordering
// `installStubs` demands (before the first `@/`-rooted import), just run
// from inside a hook instead of at module scope.
let renameGoal: typeof import("@/app/actions/plan").renameGoal;
let createGoal: typeof import("@/app/actions/plan").createGoal;
let createOneOff: typeof import("@/app/actions/one-offs").createOneOff;
let scheduleOneOff: typeof import("@/app/actions/one-offs").scheduleOneOff;
let deleteOneOff: typeof import("@/app/actions/one-offs").deleteOneOff;
let fixTask: typeof import("@/app/actions/one-offs").fixTask;
let completeOneOff: typeof import("@/app/actions/one-offs").completeOneOff;
let loadWeek: typeof import("@/lib/queries/week").loadWeek;
let loadGoal: typeof import("@/lib/queries/goal").loadGoal;
let planMonthList: typeof import("@/lib/plan/roadmap-read").planMonthList;
let moveHorizon: typeof import("@/app/actions/plan").moveHorizon;
let addPhase: typeof import("@/app/actions/plan").addPhase;
let addCommitment: typeof import("@/app/actions/plan").addCommitment;
let setRhythm: typeof import("@/app/actions/roadmap").setRhythm;
let setGoalMeasure: typeof import("@/app/actions/plan").setGoalMeasure;
let reopenGoal: typeof import("@/app/actions/plan").reopenGoal;
let archiveGoal: typeof import("@/app/actions/plan").archiveGoal;
let retireCommitment: typeof import("@/app/actions/plan").retireCommitment;
let undoFact: typeof import("@/app/actions/facts").undoFact;
let declareFact: typeof import("@/app/actions/facts").declareFact;
let todayInZone: typeof import("@/lib/zone").todayInZone;
let PAST_DAY_LIMIT: number;

// Whole civil days added to a `YYYY-MM-DD` string, by midday UTC — the same
// technique `scripts/harness/seed-goal.ts`'s own `addDays` uses, so a test
// day never drifts the way a naive `Date` constructor would.
function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(date);
}

assertSuiteDatabase();

// The session pooler, bypassing RLS the same way `e2e/fixtures.ts` does for
// its own fixtures — never the app's own `DATABASE_URL` role. Only fixture
// setup runs on it: every `declareFact` call below still goes through
// `withGoalsDb`, as `authenticated`, which is the door RP-06's own Done
// criterion asks to be proven.
const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

let today: string;
let personId: string;
// A tap commitment born ten days ago and never retired: old enough that
// every day this file declares against it — up to `PAST_DAY_LIMIT` back —
// falls on or after its own creation.
let oldCommitmentId: string;
// A tap commitment born three days ago: young enough that a day within
// `PAST_DAY_LIMIT` can still fall before it was created.
let youngCommitmentId: string;
// A tap commitment born ten days ago and retired two days ago: old enough at
// birth, retired recently enough that a day within `PAST_DAY_LIMIT` can still
// fall after it.
let retiredCommitmentId: string;
let fixtureGoalId: string;

// Every statement the app's own pool sends, in order: `db/client.ts` takes `globalThis.sql` when it
// stands, so the pool installed here is the one the actions run on.
const wire: string[] = [];
let appPool: ReturnType<typeof postgres>;

before(async () => {
  installStubs(loadCookies());
  appPool = postgres(process.env.DATABASE_URL!, {
    prepare: false,
    max: 2,
    debug: (_id, query) => void wire.push(String(query)),
  });
  (globalThis as unknown as { sql: unknown }).sql = appPool;
  ({ renameGoal, createGoal, moveHorizon, addPhase, addCommitment, reopenGoal, archiveGoal, retireCommitment, setGoalMeasure } = await import("@/app/actions/plan"));
  ({ setRhythm } = await import("@/app/actions/roadmap"));
  ({ createOneOff, scheduleOneOff, deleteOneOff, fixTask, completeOneOff } = await import("@/app/actions/one-offs"));
  ({ loadWeek } = await import("@/lib/queries/week"));
  ({ loadGoal } = await import("@/lib/queries/goal"));
  ({ planMonthList } = await import("@/lib/plan/roadmap-read"));
  ({ declareFact, undoFact } = await import("@/app/actions/facts"));
  ({ todayInZone } = await import("@/lib/zone"));
  ({ PAST_DAY_LIMIT } = await import("@/lib/validation/fact"));

  const { getPerson } = await import("@/lib/session");
  const person = await getPerson();
  if (!person) throw new Error("no settled session — mint-session.ts's cookie did not verify");
  personId = person.id;
  today = todayInZone();

  const goal = await createGoal({ name: "RP-06 fixture", horizon: shiftDay(today, 60) });
  if (!goal.ok) throw new Error(`createGoal: ${goal.error}`);
  fixtureGoalId = goal.goalId;

  // `created_at`/`retired_at` at birth are out of `authenticated`'s own
  // grant (`db/migrations/0000_mighty_pet_avengers.sql`: "a commitment is
  // born live") and no server action offers them either, so a backdated
  // fixture can only be seeded through the session pooler, never through
  // `addCommitment`.
  const [old] = await sql<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goal.goalId}, 'RP-06 fixture: hace 10 días', 'daily', 'tap', now() - interval '10 days')
    returning id`;
  oldCommitmentId = old.id;
  // The goal opened with its oldest commitment, as the app can reach.
  await sql`update goals.goals set created_at = now() - interval '10 days' where id = ${goal.goalId}`;

  const [young] = await sql<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at)
    values (${personId}, ${goal.goalId}, 'RP-06 fixture: hace 3 días', 'daily', 'tap', now() - interval '3 days')
    returning id`;
  youngCommitmentId = young.id;

  const [retired] = await sql<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, created_at, retired_at)
    values (${personId}, ${goal.goalId}, 'RP-06 fixture: retirado', 'daily', 'tap', now() - interval '10 days', now() - interval '2 days')
    returning id`;
  retiredCommitmentId = retired.id;

  const oneOff = await createOneOff({ goalId: goal.goalId, name: "RP-06 fixture: suelta", day: today });
  if (!oneOff.ok) throw new Error(`createOneOff: ${oneOff.error}`);
});

after(async () => {
  // Cascades to the fixture's commitments, one-off and facts.
  if (seededTasks.length) {
    await sql`delete from goals.facts where one_off_id in ${sql(seededTasks)}`;
    await sql`delete from goals.one_offs where parent_id in ${sql(seededTasks)}`;
    await sql`delete from goals.one_offs where id in ${sql(seededTasks)}`;
  }
  if (fixtureGoalId) await sql`delete from goals.goals where id = ${fixtureGoalId}`;
  await sql.end();
  await appPool?.end();
});

test("renameGoal: a goalId that names no goal is reported notFound, not a false ok:true", async () => {
  const result = await renameGoal({ goalId: randomUUID(), name: "meta ajena" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "plan.errors.notFound");
});

test("renameGoal: a goalId that fails z.uuid() is refused gracefully, never thrown", async () => {
  await assert.doesNotReject(() => renameGoal({ goalId: "not-a-uuid", name: "meta ajena" }));
  const result = await renameGoal({ goalId: "not-a-uuid", name: "meta ajena" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "plan.errors.goalInvalid");
});

test("renameGoal: an own goal takes the new name, and revalidates its screens", async () => {
  const created = await createGoal({ name: "RP-23 antes", horizon: shiftDay(today, 30) });
  if (!created.ok) throw new Error(created.error);
  try {
    revalidated.length = 0;
    const result = await renameGoal({ goalId: created.goalId, name: "RP-23 después" });
    assert.equal(result.ok, true);
    const [row] = await sql<{ name: string }[]>`select name from goals.goals where id = ${created.goalId}`;
    assert.equal(row.name, "RP-23 después");
    assert.ok(revalidated.includes(`/metas/${created.goalId}`), revalidated.join(", "));
  } finally {
    await sql`delete from goals.goals where id = ${created.goalId}`;
  }
});

// RP-06: `declareFact` writes for a day already past.
test("declareFact: a tap for yesterday lands with day=yesterday and written_at=today; a repeat leaves one row", async () => {
  const yesterday = shiftDay(today, -1);

  const first = await declareFact({ commitmentId: oldCommitmentId, day: yesterday });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // The authenticated INSERT this Done criterion asks to be proven: it
  // landed, under the app's own role, with a past `day`.
  const second = await declareFact({ commitmentId: oldCommitmentId, day: yesterday });
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.factId, first.factId);

  const rows = await sql<{ id: string; day: string; writtenAtDay: string }[]>`
    select id, day::text as day,
           (written_at at time zone 'America/Bogota')::date::text as "writtenAtDay"
    from goals.facts where commitment_id = ${oldCommitmentId} and day = ${yesterday}`;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.factId);
  assert.equal(rows[0].day, yesterday);
  assert.equal(rows[0].writtenAtDay, today);
});

test("declareFact: PAST_DAY_LIMIT days back is accepted, one more is refused", async () => {
  const atLimit = shiftDay(today, -PAST_DAY_LIMIT);
  const accepted = await declareFact({ commitmentId: oldCommitmentId, day: atLimit });
  assert.equal(accepted.ok, true);

  const pastLimit = shiftDay(today, -(PAST_DAY_LIMIT + 1));
  const refused = await declareFact({ commitmentId: oldCommitmentId, day: pastLimit });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error, "day.errors.dayTooOld");
});

test("declareFact: a day after today is refused with its own key, and writes no row", async () => {
  const tomorrow = shiftDay(today, 1);
  const [before_] = await sql<{ count: string }[]>`
    select count(*)::text as count from goals.facts
    where commitment_id = ${oldCommitmentId} and day = ${tomorrow}`;

  const result = await declareFact({ commitmentId: oldCommitmentId, day: tomorrow });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "day.errors.dayFuture");

  const [after_] = await sql<{ count: string }[]>`
    select count(*)::text as count from goals.facts
    where commitment_id = ${oldCommitmentId} and day = ${tomorrow}`;
  assert.equal(after_.count, before_.count);
});

test("declareFact: a day before the commitment's own creation is refused", async () => {
  // Within PAST_DAY_LIMIT (so `dayTooOld` never fires), before `youngCommitmentId`'s
  // own creation three days ago.
  const tooEarly = shiftDay(today, -5);
  const result = await declareFact({ commitmentId: youngCommitmentId, day: tooEarly });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "day.errors.dayBeforeCommitment");
});

test("declareFact: a day after the commitment's own retirement is refused", async () => {
  // Within PAST_DAY_LIMIT and after `retiredCommitmentId`'s own creation ten
  // days ago, but after its retirement two days ago.
  const afterRetirement = shiftDay(today, -1);
  const result = await declareFact({ commitmentId: retiredCommitmentId, day: afterRetirement });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "day.errors.dayAfterRetired");
});

// RP-129. A task born `createdAgo` days ago (`created_at` is out of
// `authenticated`'s grant, so it is seeded through the pooler), on its own
// day `dayOffset` from today or on none, in the fixture goal or the one given.
const seededTasks: string[] = [];
async function seedTask(opts: {
  createdAgo: number;
  dayOffset: number | null;
  goalId?: string;
  estimate?: number;
  parentId?: string;
}): Promise<string> {
  const day = opts.dayOffset === null ? null : shiftDay(today, opts.dayOffset);
  const [row] = await sql<{ id: string }[]>`
    insert into goals.one_offs (user_id, goal_id, parent_id, name, day, estimate, created_at)
    values (${personId}, ${opts.goalId ?? fixtureGoalId}, ${opts.parentId ?? null}, 'RP-129 fixture', ${day},
            ${opts.estimate ?? null}, now() - ${opts.createdAgo + " days"}::interval)
    returning id`;
  seededTasks.push(row.id);
  return row.id;
}

async function factsOf(oneOffId: string): Promise<{ id: string; day: string; writtenAtDay: string }[]> {
  return sql<{ id: string; day: string; writtenAtDay: string }[]>`
    select id, day::text as day, (written_at at time zone 'America/Bogota')::date::text as "writtenAtDay"
    from goals.facts where one_off_id = ${oneOffId}`;
}

async function refusedWithNoFact(oneOffId: string, day: string | undefined, key: string): Promise<void> {
  const result = await completeOneOff({ oneOffId, day });
  assert.equal(result.ok, false, `${day}`);
  if (!result.ok) assert.equal(result.error, key, `${day}`);
  assert.equal((await factsOf(oneOffId)).length, 0, `${day} wrote a fact`);
}

test("completeOneOff: a task created 4 days ago and dated 3 days ago, marked done 2 days ago, keeps that day and today as the moment written", async () => {
  const task = await seedTask({ createdAgo: 4, dayOffset: -3 });
  const result = await completeOneOff({ oneOffId: task, day: shiftDay(today, -2) });
  assert.equal(result.ok, true);
  const rows = await factsOf(task);
  assert.equal(rows.length, 1);
  if (result.ok) assert.equal(rows[0].id, result.factId);
  assert.equal(rows[0].day, shiftDay(today, -2));
  assert.equal(rows[0].writtenAtDay, today);
});

test("completeOneOff: no day is today, decided on the server", async () => {
  const task = await seedTask({ createdAgo: 4, dayOffset: -3 });
  assert.equal((await completeOneOff({ oneOffId: task })).ok, true);
  assert.deepEqual((await factsOf(task)).map((row) => row.day), [today]);
});

test("completeOneOff: tomorrow is dayFuture, PAST_DAY_LIMIT back lands, one more is dayTooOld, none writes on refusal", async () => {
  const task = await seedTask({ createdAgo: 12, dayOffset: null });
  await refusedWithNoFact(task, shiftDay(today, 1), "day.errors.dayFuture");
  await refusedWithNoFact(task, shiftDay(today, -(PAST_DAY_LIMIT + 1)), "day.errors.dayTooOld");
  assert.equal((await completeOneOff({ oneOffId: task, day: shiftDay(today, -PAST_DAY_LIMIT) })).ok, true);
  assert.deepEqual((await factsOf(task)).map((row) => row.day), [shiftDay(today, -PAST_DAY_LIMIT)]);
});

test("completeOneOff: a dayless task refuses the day before its creation and takes its creation day and later", async () => {
  const task = await seedTask({ createdAgo: 4, dayOffset: null });
  await refusedWithNoFact(task, shiftDay(today, -5), "day.errors.dayBeforeOneOff");
  assert.equal((await completeOneOff({ oneOffId: task, day: shiftDay(today, -4) })).ok, true);
  assert.deepEqual((await factsOf(task)).map((row) => row.day), [shiftDay(today, -4)]);

  const later = await seedTask({ createdAgo: 4, dayOffset: null });
  assert.equal((await completeOneOff({ oneOffId: later, day: shiftDay(today, -2) })).ok, true);
});

test("completeOneOff: a day before the task's own day is dayBeforeOneOffDay, its own day lands", async () => {
  const task = await seedTask({ createdAgo: 4, dayOffset: -3 });
  // After the creation day, before the task's own: only the own-day rule can refuse it.
  await refusedWithNoFact(task, shiftDay(today, -4), "day.errors.dayBeforeOneOffDay");
  assert.equal((await completeOneOff({ oneOffId: task, day: shiftDay(today, -3) })).ok, true);

  const ahead = await seedTask({ createdAgo: 4, dayOffset: 0 });
  await refusedWithNoFact(ahead, shiftDay(today, -1), "day.errors.dayBeforeOneOffDay");
});

test("completeOneOff: a task already done keeps its fact and its day; a second mark on another day writes nothing", async () => {
  const task = await seedTask({ createdAgo: 4, dayOffset: -3 });
  const first = await completeOneOff({ oneOffId: task, day: shiftDay(today, -2) });
  assert.equal(first.ok, true);
  revalidated.length = 0;
  const second = await completeOneOff({ oneOffId: task, day: shiftDay(today, -1) });
  assert.equal(second.ok, true);
  // Nothing landed on the second day, so its screen is not asked to refresh; the first day's is.
  assert.ok(revalidated.includes(`/dia/${shiftDay(today, -2)}`), revalidated.join(", "));
  assert.ok(!revalidated.includes(`/dia/${shiftDay(today, -1)}`), revalidated.join(", "));
  if (first.ok && second.ok) assert.equal(second.factId, first.factId);
  const rows = await factsOf(task);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].day, shiftDay(today, -2));
});

test("completeOneOff: a parent stays done by its sub-tasks, with or without a day, and writes no fact", async () => {
  const parent = await seedTask({ createdAgo: 4, dayOffset: null });
  await seedTask({ createdAgo: 4, dayOffset: null, parentId: parent });
  await refusedWithNoFact(parent, shiftDay(today, -1), "month.errors.parentIsDoneByChildren");
  await refusedWithNoFact(parent, undefined, "month.errors.parentIsDoneByChildren");
});

test("completeOneOff: a malformed day is dayInvalid, never thrown, and reaches the database with no statement", async () => {
  const task = await seedTask({ createdAgo: 4, dayOffset: null });
  const mark = wire.length;
  await assert.doesNotReject(() => completeOneOff({ oneOffId: task, day: "2026-13-40" }));
  const result = await completeOneOff({ oneOffId: task, day: "2026-13-40" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "day.errors.dayInvalid");
  assert.equal(wire.length, mark);
  assert.equal((await factsOf(task)).length, 0);
});

test("completeOneOff: done on a past day, the task shows on that day's week and in that day's month, and its estimate adds no measure (RP-129, RP-128)", async () => {
  const [measured] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, created_at)
    values (${personId}, 'RP-129 medida', ${shiftDay(today, 60)}, 'Cajas', 'cajas', now() - interval '10 days')
    returning id`;
  try {
    const task = await seedTask({ createdAgo: 4, dayOffset: -3, goalId: measured.id, estimate: 5 });
    const doneDay = shiftDay(today, -2);
    const before_ = await loadGoal(measured.id);
    assert.ok(before_);

    assert.equal((await completeOneOff({ oneOffId: task, day: doneDay })).ok, true);

    const week = await loadWeek(doneDay);
    const listed = week.oneOffFacts.filter((fact) => fact.oneOffId === task);
    assert.deepEqual(listed.map((fact) => fact.day), [doneDay]);

    const view = await loadGoal(measured.id);
    assert.ok(view);
    assert.equal(view.tasks.find((item) => item.id === task)?.doneOn, doneDay);
    const item = planMonthList(view.plan, `${doneDay.slice(0, 7)}-01`).find((entry) => entry.task.id === task);
    assert.equal(item?.done, true);

    assert.equal(view.measureTotal, before_.measureTotal);
    assert.deepEqual(view.weeks, before_.weeks);
  } finally {
    await sql`delete from goals.goals where id = ${measured.id}`;
  }
});

test("declareFact: a day on a one-off follows the task's rule (RP-129): a past day lands, 8 days back is refused", async () => {
  const task = await seedTask({ createdAgo: 4, dayOffset: -3 });
  const refused = await declareFact({ oneOffId: task, day: shiftDay(today, -(PAST_DAY_LIMIT + 1)) });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error, "day.errors.dayTooOld");
  assert.equal((await factsOf(task)).length, 0);

  const done = await declareFact({ oneOffId: task, day: shiftDay(today, -2) });
  assert.equal(done.ok, true);
  const rows = await factsOf(task);
  assert.deepEqual(rows.map((row) => row.day), [shiftDay(today, -2)]);
});

test("declareFact: a malformed day is refused gracefully, never thrown", async () => {
  await assert.doesNotReject(() => declareFact({ commitmentId: oldCommitmentId, day: "2026-13-40" }));
  const result = await declareFact({ commitmentId: oldCommitmentId, day: "2026-13-40" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "day.errors.dayInvalid");
});

test("declareFact: a day on the commitment's own creation day is accepted and lands there", async () => {
  // `youngCommitmentId` was born three days ago, at this very time of day.
  const bornOn = shiftDay(today, -3);
  const result = await declareFact({ commitmentId: youngCommitmentId, day: bornOn });
  assert.equal(result.ok, true);
  const rows = await sql<{ day: string }[]>`
    select day::text as day from goals.facts where commitment_id = ${youngCommitmentId}`;
  assert.deepEqual(
    rows.map((row) => row.day),
    [bornOn],
  );
});

test("declareFact: a day on the commitment's own retirement day is accepted and lands there", async () => {
  // `retiredCommitmentId` was retired two days ago, at this very time of day.
  const retiredOn = shiftDay(today, -2);
  const result = await declareFact({ commitmentId: retiredCommitmentId, day: retiredOn });
  assert.equal(result.ok, true);
  const rows = await sql<{ day: string }[]>`
    select day::text as day from goals.facts where commitment_id = ${retiredCommitmentId}`;
  assert.deepEqual(
    rows.map((row) => row.day),
    [retiredOn],
  );
});

test("declareFact: day = today is accepted and lands on today", async () => {
  const result = await declareFact({ commitmentId: oldCommitmentId, day: today });
  assert.equal(result.ok, true);
  const rows = await sql<{ day: string }[]>`
    select day::text as day from goals.facts where commitment_id = ${oldCommitmentId} and day = ${today}`;
  assert.equal(rows.length, 1);
});

test("declareFact: a past-day fact revalidates /semana and its own /dia/<day>", async () => {
  const day = shiftDay(today, -4);
  revalidated.length = 0;
  const result = await declareFact({ commitmentId: oldCommitmentId, day });
  assert.equal(result.ok, true);
  assert.ok(revalidated.includes("/semana"), `revalidated: ${revalidated.join(", ")}`);
  assert.ok(revalidated.includes(`/dia/${day}`), `revalidated: ${revalidated.join(", ")}`);
});

// A one-off's day and a goal's horizon. Everything seeded here is
// deleted by id in `finally`, never by a sweep.
async function oneOffDay(id: string): Promise<string | null> {
  const [row] = await sql<{ day: string | null }[]>`
    select day::text as day from goals.one_offs where id = ${id}`;
  return row.day;
}

test("createOneOff: no day lands a null day; yesterday is refused and writes no row; tomorrow lands tomorrow", async () => {
  const ids: string[] = [];
  try {
    const dayless = await createOneOff({ name: "RP-59 sin día", day: null });
    assert.equal(dayless.ok, true);
    if (!dayless.ok) return;
    ids.push(dayless.oneOffId);
    assert.equal(await oneOffDay(dayless.oneOffId), null);

    const refused = await createOneOff({ name: "RP-19 ayer", day: shiftDay(today, -1) });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error, "day.errors.oneOffDayPast");
    const [{ count }] = await sql<{ count: string }[]>`
      select count(*)::text as count from goals.one_offs
      where user_id = ${personId} and name = 'RP-19 ayer'`;
    assert.equal(count, "0");

    const tomorrow = shiftDay(today, 1);
    const future = await createOneOff({ name: "RP-19 mañana", day: tomorrow });
    assert.equal(future.ok, true);
    if (!future.ok) return;
    ids.push(future.oneOffId);
    assert.equal(await oneOffDay(future.oneOffId), tomorrow);
  } finally {
    if (ids.length) await sql`delete from goals.one_offs where id in ${sql(ids)}`;
    // The refused write must land nothing; if a regression lets it land, it
    // still does not outlive this test.
    await sql`delete from goals.one_offs where user_id = ${personId} and name = 'RP-19 ayer'`;
  }
});

test("scheduleOneOff: a dayless one gets today; a second call moves it on (RP-61); one with a fact is refused", async () => {
  const ids: string[] = [];
  try {
    const made = await createOneOff({ name: "RP-59 por fechar", day: null });
    if (!made.ok) throw new Error(made.error);
    ids.push(made.oneOffId);

    const first = await scheduleOneOff({ oneOffId: made.oneOffId, day: today });
    assert.equal(first.ok, true);
    assert.equal(await oneOffDay(made.oneOffId), today);

    const second = await scheduleOneOff({ oneOffId: made.oneOffId, day: shiftDay(today, 3) });
    assert.deepEqual(second, { ok: true });
    assert.equal(await oneOffDay(made.oneOffId), shiftDay(today, 3));

    const past = await scheduleOneOff({ oneOffId: made.oneOffId, day: shiftDay(today, -1) });
    assert.equal(past.ok, false);
    if (!past.ok) assert.equal(past.error, "day.errors.oneOffDayPast");
    assert.equal(await oneOffDay(made.oneOffId), shiftDay(today, 3));

    const missing = await scheduleOneOff({ oneOffId: randomUUID(), day: today });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error, "day.errors.notFound");

    // A dayless one that already carries a fact: seeded through the pooler,
    // since `completeOneOff` never sees a dayless one.
    const [withFact] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, name) values (${personId}, 'RP-59 con hecho') returning id`;
    ids.push(withFact.id);
    await sql`insert into goals.facts (user_id, one_off_id, day) values (${personId}, ${withFact.id}, ${today})`;
    const refused = await scheduleOneOff({ oneOffId: withFact.id, day: today });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error, "day.errors.oneOffHasFact");
    assert.equal(await oneOffDay(withFact.id), null);
  } finally {
    if (ids.length) {
      await sql`delete from goals.facts where one_off_id in ${sql(ids)}`;
      await sql`delete from goals.one_offs where id in ${sql(ids)}`;
    }
  }
});

async function goalHorizon(id: string): Promise<string> {
  const [row] = await sql<{ horizon: string }[]>`
    select horizon::text as horizon from goals.goals where id = ${id}`;
  return row.horizon;
}

test("moveHorizon: moves an own goal; before the last phase, or in the past, is refused and the column holds", async () => {
  const created = await createGoal({ name: "RP-25 horizonte", horizon: shiftDay(today, 60) });
  if (!created.ok) throw new Error(created.error);
  const goalId = created.goalId;
  try {
    await sql`
      insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
      values (${personId}, ${goalId}, 'RP-25 fase', ${shiftDay(today, 1)}, ${shiftDay(today, 30)})`;

    revalidated.length = 0;
    const moved = await moveHorizon({ goalId, horizon: shiftDay(today, 90) });
    assert.equal(moved.ok, true);
    assert.equal(await goalHorizon(goalId), shiftDay(today, 90));
    assert.ok(revalidated.includes(`/metas/${goalId}/revision`), revalidated.join(", "));
    assert.ok(revalidated.includes(`/metas/${goalId}`), revalidated.join(", "));

    const stranded = await moveHorizon({ goalId, horizon: shiftDay(today, 20) });
    assert.equal(stranded.ok, false);
    if (!stranded.ok) assert.equal(stranded.error, "goal.errors.horizonBeforePhase");
    assert.equal(await goalHorizon(goalId), shiftDay(today, 90));

    const past = await moveHorizon({ goalId, horizon: today });
    assert.equal(past.ok, false);
    if (!past.ok) assert.equal(past.error, "goal.errors.horizonPast");
    assert.equal(await goalHorizon(goalId), shiftDay(today, 90));
  } finally {
    await sql`delete from goals.goals where id = ${goalId}`;
  }
});

test("moveHorizon: another person's goal answers notFound and is unchanged", async () => {
  const [member] = await sql<{ id: string }[]>`
    select id from auth.users where email = ${memberEmail}`;
  if (!member) throw new Error("no member identity — run harness:token for this lane");
  const [foreign] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${member.id}, 'RP-25 ajena', ${shiftDay(today, 60)}) returning id`;
  try {
    const result = await moveHorizon({ goalId: foreign.id, horizon: shiftDay(today, 90) });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "plan.errors.notFound");
    assert.equal(await goalHorizon(foreign.id), shiftDay(today, 60));
  } finally {
    await sql`delete from goals.goals where id = ${foreign.id}`;
  }
});

test("scheduleOneOff: a one-off dated after today moves; one dated today moves too (RP-61); another person's is notFound", async () => {
  const ids: string[] = [];
  const [member] = await sql<{ id: string }[]>`
    select id from auth.users where email = ${memberEmail}`;
  if (!member) throw new Error("no member identity — run harness:token for this lane");
  try {
    const made = await createOneOff({ name: "RP-59 mover", day: shiftDay(today, 1) });
    if (!made.ok) throw new Error(made.error);
    ids.push(made.oneOffId);

    revalidated.length = 0;
    const moved = await scheduleOneOff({ oneOffId: made.oneOffId, day: shiftDay(today, 2) });
    assert.equal(moved.ok, true);
    assert.equal(await oneOffDay(made.oneOffId), shiftDay(today, 2));
    assert.ok(revalidated.includes("/") && revalidated.includes("/sueltas"), revalidated.join(", "));

    const toToday = await scheduleOneOff({ oneOffId: made.oneOffId, day: today });
    assert.equal(toToday.ok, true);
    assert.equal(await oneOffDay(made.oneOffId), today);
    const { loadDay } = await import("@/lib/queries/day");
    const loaded = await loadDay(today);
    assert.ok(loaded.oneOffs.some((o) => o.id === made.oneOffId));

    const dated = await scheduleOneOff({ oneOffId: made.oneOffId, day: shiftDay(today, 3) });
    assert.deepEqual(dated, { ok: true });
    assert.equal(await oneOffDay(made.oneOffId), shiftDay(today, 3));

    const [withFact] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, name, day)
      values (${personId}, 'RP-59 futura con hecho', ${shiftDay(today, 1)}) returning id`;
    ids.push(withFact.id);
    await sql`insert into goals.facts (user_id, one_off_id, day) values (${personId}, ${withFact.id}, ${today})`;
    const refused = await scheduleOneOff({ oneOffId: withFact.id, day: shiftDay(today, 2) });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error, "day.errors.oneOffHasFact");
    assert.equal(await oneOffDay(withFact.id), shiftDay(today, 1));

    const [foreign] = await sql<{ id: string }[]>`
      insert into goals.one_offs (user_id, name, day)
      values (${member.id}, 'RP-59 ajena', ${shiftDay(today, 1)}) returning id`;
    ids.push(foreign.id);
    const other = await scheduleOneOff({ oneOffId: foreign.id, day: shiftDay(today, 2) });
    assert.equal(other.ok, false);
    if (!other.ok) assert.equal(other.error, "day.errors.notFound");
    assert.equal(await oneOffDay(foreign.id), shiftDay(today, 1));
  } finally {
    if (ids.length) {
      await sql`delete from goals.facts where one_off_id in ${sql(ids)}`;
      await sql`delete from goals.one_offs where id in ${sql(ids)}`;
    }
  }
});

test("addPhase and addCommitment: an ended or archived goal is refused as a goal that is gone and writes nothing; an open one lands both", async () => {
  const open = await createGoal({ name: "RP-88 abierta", horizon: shiftDay(today, 60) });
  if (!open.ok) throw new Error(open.error);
  const [ended] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, 'RP-88 terminada', ${today}, now() - interval '20 days') returning id`;
  const [archived] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, archived_at)
    values (${personId}, 'RP-88 archivada', ${shiftDay(today, 60)}, now()) returning id`;
  const phase = (goalId: string) => ({
    goalId,
    aim: "RP-88 fase",
    startsOn: shiftDay(today, -10),
    endsOn: shiftDay(today, -3),
  });
  const commitment = (goalId: string) => ({
    goalId,
    name: "RP-88 compromiso",
    cadenceKind: "daily" as const,
    satisfaction: "tap" as const,
  });
  const written = async (goalId: string) => {
    const [row] = await sql<{ phases: number; commitments: number }[]>`
      select (select count(*)::int from goals.phases where goal_id = ${goalId}) as phases,
             (select count(*)::int from goals.commitments where goal_id = ${goalId}) as commitments`;
    return row;
  };
  try {
    for (const goalId of [ended.id, archived.id]) {
      const refusedPhase = await addPhase(phase(goalId));
      assert.equal(refusedPhase.ok, false);
      if (!refusedPhase.ok) assert.equal(refusedPhase.error, "plan.errors.goalNotFound");

      const refusedCommitment = await addCommitment(commitment(goalId));
      assert.equal(refusedCommitment.ok, false);
      if (!refusedCommitment.ok) assert.equal(refusedCommitment.error, "plan.errors.goalNotFound");

      assert.deepEqual(await written(goalId), { phases: 0, commitments: 0 });
    }

    const landedPhase = await addPhase({ ...phase(open.goalId), startsOn: shiftDay(today, 1), endsOn: shiftDay(today, 8) });
    assert.equal(landedPhase.ok, true);
    const landedCommitment = await addCommitment(commitment(open.goalId));
    assert.equal(landedCommitment.ok, true);
    assert.deepEqual(await written(open.goalId), { phases: 1, commitments: 1 });
  } finally {
    await sql`delete from goals.goals where id in ${sql([open.goalId, ended.id, archived.id])}`;
  }
});

test("addPhase and addCommitment: moving an ended goal's end forward, or reopening an archived one, lets the adds land again", async () => {
  const [ended] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, 'RP-88 reabrir terminada', ${today}, now() - interval '20 days') returning id`;
  const [archived] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, archived_at)
    values (${personId}, 'RP-88 reabrir archivada', ${shiftDay(today, 60)}, now()) returning id`;
  const commitment = (goalId: string) => ({
    goalId,
    name: "RP-88 compromiso reabierto",
    cadenceKind: "daily" as const,
    satisfaction: "tap" as const,
  });
  const written = async (goalId: string) => {
    const [row] = await sql<{ phases: number; commitments: number }[]>`
      select (select count(*)::int from goals.phases where goal_id = ${goalId}) as phases,
             (select count(*)::int from goals.commitments where goal_id = ${goalId}) as commitments`;
    return row;
  };
  const span = { aim: "RP-88 fase reabierta", startsOn: shiftDay(today, 1), endsOn: shiftDay(today, 8) };
  try {
    const stillEnded = await addPhase({ goalId: ended.id, ...span });
    assert.equal(stillEnded.ok, false);

    const moved = await moveHorizon({ goalId: ended.id, horizon: shiftDay(today, 30) });
    assert.equal(moved.ok, true);
    const endedPhase = await addPhase({ goalId: ended.id, ...span });
    assert.equal(endedPhase.ok, true);
    const endedCommitment = await addCommitment(commitment(ended.id));
    assert.equal(endedCommitment.ok, true);
    assert.deepEqual(await written(ended.id), { phases: 1, commitments: 1 });

    const stillArchived = await addPhase({ goalId: archived.id, ...span });
    assert.equal(stillArchived.ok, false);

    const reopened = await reopenGoal({ goalId: archived.id });
    assert.equal(reopened.ok, true);
    const archivedPhase = await addPhase({ goalId: archived.id, ...span });
    assert.equal(archivedPhase.ok, true);
    assert.deepEqual(await written(archived.id), { phases: 1, commitments: 0 });
  } finally {
    await sql`delete from goals.goals where id in ${sql([ended.id, archived.id])}`;
  }
});

// A second person's rows, planted through the pooler: no action writes for them.
async function memberId(): Promise<string> {
  const [member] = await sql<{ id: string }[]>`select id from auth.users where email = ${memberEmail}`;
  if (!member) throw new Error("no member identity — run harness:token for this lane");
  return member.id;
}

test("addPhase: a span ending past the goal's horizon, or sharing a day with a phase, is refused and writes nothing", async () => {
  const created = await createGoal({ name: "RP-15 guardas", horizon: shiftDay(today, 30) });
  if (!created.ok) throw new Error(created.error);
  const goalId = created.goalId;
  const count = async () => {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from goals.phases where goal_id = ${goalId}`;
    return row.n;
  };
  try {
    const past = await addPhase({ goalId, aim: "RP-15 pasada", startsOn: shiftDay(today, 1), endsOn: shiftDay(today, 31) });
    assert.equal(past.ok, false);
    if (!past.ok) assert.equal(past.error, "plan.errors.phasePastHorizon");
    assert.equal(await count(), 0);

    const atHorizon = await addPhase({ goalId, aim: "RP-15 hasta el horizonte", startsOn: shiftDay(today, 1), endsOn: shiftDay(today, 10) });
    assert.equal(atHorizon.ok, true);
    assert.equal(await count(), 1);

    // Sharing only the last day is still an overlap: both ends are inclusive.
    const overlap = await addPhase({ goalId, aim: "RP-15 solapada", startsOn: shiftDay(today, 10), endsOn: shiftDay(today, 20) });
    assert.equal(overlap.ok, false);
    if (!overlap.ok) assert.equal(overlap.error, "plan.errors.phaseOverlap");
    assert.equal(await count(), 1);

    const adjacent = await addPhase({ goalId, aim: "RP-15 contigua", startsOn: shiftDay(today, 11), endsOn: shiftDay(today, 30) });
    assert.equal(adjacent.ok, true);
    assert.equal(await count(), 2);
  } finally {
    await sql`delete from goals.goals where id = ${goalId}`;
  }
});

test("addPhase and addCommitment: another person's goal answers goalNotFound and writes nothing", async () => {
  const [foreign] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${await memberId()}, 'RP-15 ajena', ${shiftDay(today, 60)}) returning id`;
  try {
    const phase = await addPhase({ goalId: foreign.id, aim: "RP-15 ajena", startsOn: shiftDay(today, 1), endsOn: shiftDay(today, 8) });
    assert.equal(phase.ok, false);
    if (!phase.ok) assert.equal(phase.error, "plan.errors.goalNotFound");
    const commitment = await addCommitment({ goalId: foreign.id, name: "RP-12 ajeno", cadenceKind: "daily", satisfaction: "tap" });
    assert.equal(commitment.ok, false);
    if (!commitment.ok) assert.equal(commitment.error, "plan.errors.goalNotFound");
    const [{ n }] = await sql<{ n: number }[]>`
      select (select count(*) from goals.phases where goal_id = ${foreign.id})::int
           + (select count(*) from goals.commitments where goal_id = ${foreign.id})::int as n`;
    assert.equal(n, 0);
  } finally {
    await sql`delete from goals.goals where id = ${foreign.id}`;
  }
});

test("addCommitment: an unknown evidence source is refused sourceNotFound; a target past the schema's ceiling is refused and writes nothing", async () => {
  const created = await createGoal({ name: "RP-12 guardas", horizon: shiftDay(today, 30) });
  if (!created.ok) throw new Error(created.error);
  const goalId = created.goalId;
  const count = async () => {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from goals.commitments where goal_id = ${goalId}`;
    return row.n;
  };
  try {
    const source = await addCommitment({
      goalId,
      name: "RP-12 fuente",
      cadenceKind: "daily",
      satisfaction: "evidence",
      sourceKey: "no_such_source",
      threshold: 1,
    });
    assert.equal(source.ok, false);
    if (!source.ok) assert.equal(source.error, "plan.errors.sourceNotFound");
    assert.equal(await count(), 0);

    // Past `integer`'s ceiling the form's schema answers first with its own key;
    // `plan.errors.valueOutOfRange` (SQLSTATE 22003) is the second line behind it.
    const target = await addCommitment({
      goalId,
      name: "RP-12 monto",
      cadenceKind: "daily",
      satisfaction: "quantity",
      targetQuantity: 2_147_483_648,
      unit: "minutos",
    });
    assert.equal(target.ok, false);
    if (!target.ok) assert.equal(target.error, "plan.errors.targetQuantityInvalid");
    assert.equal(await count(), 0);
  } finally {
    await sql`delete from goals.goals where id = ${goalId}`;
  }
});

test("retireCommitment: retires an own commitment; another person's is notFound and stays live", async () => {
  const own = await addCommitment({ goalId: fixtureGoalId, name: "RP-13 propio", cadenceKind: "daily", satisfaction: "tap" });
  if (!own.ok) throw new Error(own.error);
  const [foreignGoal] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${await memberId()}, 'RP-13 ajena', ${shiftDay(today, 60)}) returning id`;
  const [foreign] = await sql<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction)
    values (${await memberId()}, ${foreignGoal.id}, 'RP-13 ajeno', 'daily', 'tap') returning id`;
  const retiredAt = async (id: string) => {
    const [row] = await sql<{ retired: boolean }[]>`select retired_at is not null as retired from goals.commitments where id = ${id}`;
    return row.retired;
  };
  try {
    const refused = await retireCommitment({ commitmentId: foreign.id });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error, "plan.errors.notFound");
    assert.equal(await retiredAt(foreign.id), false);

    assert.equal(await retiredAt(own.commitmentId), false);
    const retired = await retireCommitment({ commitmentId: own.commitmentId });
    assert.equal(retired.ok, true);
    assert.equal(await retiredAt(own.commitmentId), true);
  } finally {
    await sql`delete from goals.goals where id = ${foreignGoal.id}`;
    await sql`delete from goals.commitments where id = ${own.commitmentId}`;
  }
});

test("undoFact: takes back an own fact; another person's is notFound and the row stays", async () => {
  const own = await addCommitment({ goalId: fixtureGoalId, name: "RP-05 propio", cadenceKind: "daily", satisfaction: "tap" });
  if (!own.ok) throw new Error(own.error);
  const fact = await declareFact({ commitmentId: own.commitmentId, day: today });
  if (!fact.ok) throw new Error(fact.error);
  const member = await memberId();
  const [foreignOneOff] = await sql<{ id: string }[]>`
    insert into goals.one_offs (user_id, name) values (${member}, 'RP-05 ajena') returning id`;
  const [foreignFact] = await sql<{ id: string }[]>`
    insert into goals.facts (user_id, one_off_id, day) values (${member}, ${foreignOneOff.id}, ${today}) returning id`;
  const exists = async (id: string) => {
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from goals.facts where id = ${id}`;
    return row.n === 1;
  };
  try {
    const refused = await undoFact({ factId: foreignFact.id });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error, "day.errors.notFound");
    assert.equal(await exists(foreignFact.id), true);

    const undone = await undoFact({ factId: fact.factId });
    assert.equal(undone.ok, true);
    assert.equal(await exists(fact.factId), false);
  } finally {
    await sql`delete from goals.one_offs where id = ${foreignOneOff.id}`;
    await sql`delete from goals.commitments where id = ${own.commitmentId}`;
  }
});

test("archiveGoal and reopenGoal: an own goal archives and reopens; another person's is notFound and unchanged", async () => {
  const created = await createGoal({ name: "RP-24 propia", horizon: shiftDay(today, 30) });
  if (!created.ok) throw new Error(created.error);
  const member = await memberId();
  const [foreignOpen] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon) values (${member}, 'RP-24 ajena abierta', ${shiftDay(today, 60)}) returning id`;
  const [foreignArchived] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, archived_at)
    values (${member}, 'RP-24 ajena archivada', ${shiftDay(today, 60)}, now()) returning id`;
  const archived = async (id: string) => {
    const [row] = await sql<{ archived: boolean }[]>`select archived_at is not null as archived from goals.goals where id = ${id}`;
    return row.archived;
  };
  try {
    const refusedArchive = await archiveGoal({ goalId: foreignOpen.id });
    assert.equal(refusedArchive.ok, false);
    if (!refusedArchive.ok) assert.equal(refusedArchive.error, "plan.errors.notFound");
    assert.equal(await archived(foreignOpen.id), false);

    const refusedReopen = await reopenGoal({ goalId: foreignArchived.id });
    assert.equal(refusedReopen.ok, false);
    if (!refusedReopen.ok) assert.equal(refusedReopen.error, "plan.errors.notFound");
    assert.equal(await archived(foreignArchived.id), true);

    assert.equal((await archiveGoal({ goalId: created.goalId })).ok, true);
    assert.equal(await archived(created.goalId), true);
    assert.equal((await reopenGoal({ goalId: created.goalId })).ok, true);
    assert.equal(await archived(created.goalId), false);
  } finally {
    await sql`delete from goals.goals where id in ${sql([created.goalId, foreignOpen.id, foreignArchived.id])}`;
  }
});

test("createGoal: an empty name and a malformed horizon are refused with their own keys and write no goal", async () => {
  const named = async () => {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from goals.goals where user_id = ${personId} and name = 'RP-11 horizonte roto'`;
    return n;
  };
  assert.deepEqual(await createGoal({ name: "   ", horizon: shiftDay(today, 30) }), { ok: false, error: "plan.errors.nameEmpty" });
  assert.deepEqual(await createGoal({ name: "RP-11 horizonte roto", horizon: "no-es-fecha" }), {
    ok: false,
    error: "plan.errors.horizonInvalid",
  });
  assert.equal(await named(), 0);
});

test("undoFact: a factId that is no uuid is refused with its own key, never thrown, and a fact stays", async () => {
  const own = await addCommitment({ goalId: fixtureGoalId, name: "RP-05 id roto", cadenceKind: "daily", satisfaction: "tap" });
  if (!own.ok) throw new Error(own.error);
  try {
    const fact = await declareFact({ commitmentId: own.commitmentId, day: today });
    if (!fact.ok) throw new Error(fact.error);
    assert.deepEqual(await undoFact({ factId: "nope" }), { ok: false, error: "day.errors.invalid" });
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from goals.facts where id = ${fact.factId}`;
    assert.equal(n, 1);
  } finally {
    await sql`delete from goals.commitments where id = ${own.commitmentId}`;
  }
});

test("createOneOff: a goal nobody owns is refused as goalNotFound, an estimate on a goal with no measure as noMeasure; neither writes a row", async () => {
  const count = async (name: string) => {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from goals.one_offs where user_id = ${personId} and name = ${name}`;
    return n;
  };
  try {
    const stranger = await createOneOff({ name: "RP-20 meta ajena", day: null, goalId: randomUUID() });
    assert.deepEqual(stranger, { ok: false, error: "plan.errors.goalNotFound" });
    assert.equal(await count("RP-20 meta ajena"), 0);

    // The fixture goal names no measure: no commitment of it is a quantity.
    const unmeasured = await createGoal({ name: "RP-30 sin medida", horizon: shiftDay(today, 60) });
    if (!unmeasured.ok) throw new Error(unmeasured.error);
    try {
      const refused = await createOneOff({
        name: "RP-30 estimada sin medida",
        day: null,
        goalId: unmeasured.goalId,
        plannedMonth: today.slice(0, 7),
        estimate: 5,
      });
      assert.deepEqual(refused, { ok: false, error: "month.errors.noMeasure" });
      assert.equal(await count("RP-30 estimada sin medida"), 0);
    } finally {
      await sql`delete from goals.goals where id = ${unmeasured.goalId}`;
    }
  } finally {
    await sql`delete from goals.one_offs where user_id = ${personId} and name in ('RP-20 meta ajena', 'RP-30 estimada sin medida')`;
  }
});

test("deleteOneOff: a one-off carrying its own fact is refused as oneOffHasFact and stays; a clean one goes", async () => {
  const made = await createOneOff({ name: "RP-22 con hecho", day: today });
  if (!made.ok) throw new Error(made.error);
  const clean = await createOneOff({ name: "RP-22 sin hecho", day: today });
  if (!clean.ok) throw new Error(clean.error);
  const exists = async (id: string) => {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from goals.one_offs where id = ${id}`;
    return n === 1;
  };
  try {
    await sql`insert into goals.facts (user_id, one_off_id, day) values (${personId}, ${made.oneOffId}, ${today})`;
    assert.deepEqual(await deleteOneOff({ oneOffId: made.oneOffId }), { ok: false, error: "day.errors.oneOffHasFact" });
    assert.equal(await exists(made.oneOffId), true);

    assert.deepEqual(await deleteOneOff({ oneOffId: clean.oneOffId }), { ok: true });
    assert.equal(await exists(clean.oneOffId), false);
  } finally {
    await sql`delete from goals.facts where one_off_id = ${made.oneOffId}`;
    await sql`delete from goals.one_offs where id in ${sql([made.oneOffId, clean.oneOffId])}`;
  }
});

test("fixTask: a task nobody can see is notFound, a one-off that is no plan task or an id that is no uuid is invalid", async () => {
  const month = today.slice(0, 7);
  assert.deepEqual(await fixTask({ oneOffId: randomUUID(), month }), { ok: false, error: "plan.errors.notFound" });

  const loose = await createOneOff({ name: "RP-31 suelta sin mes", day: null });
  if (!loose.ok) throw new Error(loose.error);
  try {
    assert.deepEqual(await fixTask({ oneOffId: loose.oneOffId, month }), { ok: false, error: "month.errors.invalid" });
    assert.deepEqual(await fixTask({ oneOffId: "nope", month }), { ok: false, error: "month.errors.invalid" });
  } finally {
    await sql`delete from goals.one_offs where id = ${loose.oneOffId}`;
  }
});

test("addCommitment: hours written on a quantity commitment are stored as minutes, only where the goal counts time; a goal in km keeps its unit", async () => {
  const fresh = await createGoal({ name: "RP-66 horas", horizon: shiftDay(today, 60) });
  if (!fresh.ok) throw new Error(fresh.error);
  const timed = await createGoal({ name: "RP-66 minutos", horizon: shiftDay(today, 60) });
  if (!timed.ok) throw new Error(timed.error);
  const km = await createGoal({ name: "RP-66 km", horizon: shiftDay(today, 60) });
  if (!km.ok) throw new Error(km.error);
  const quantity = (goalId: string, name: string, unit: string, targetQuantity: number) =>
    addCommitment({ goalId, name, cadenceKind: "daily", satisfaction: "quantity", unit, targetQuantity });
  const stored = async (commitmentId: string) => {
    const [row] = await sql<{ unit: string; target: number }[]>`
      select unit, target_quantity as target from goals.commitments where id = ${commitmentId}`;
    return row;
  };
  const measureOf = async (goalId: string) => {
    const [row] = await sql<{ measure_unit: string | null }[]>`select measure_unit from goals.goals where id = ${goalId}`;
    return row.measure_unit;
  };
  try {
    const first = await quantity(fresh.goalId, "estudio", "horas", 2);
    if (!first.ok) throw new Error(first.error);
    assert.deepEqual(await stored(first.commitmentId), { unit: "minutos", target: 120 });
    assert.equal(await measureOf(fresh.goalId), "minutos");
    assert.deepEqual(await setRhythm({ goalId: fresh.goalId, amount: 600 }), { ok: true });

    const seed = await quantity(timed.goalId, "lectura", "minutos", 30);
    if (!seed.ok) throw new Error(seed.error);
    const hours = await quantity(timed.goalId, "repaso", "horas", 2);
    if (!hours.ok) throw new Error(hours.error);
    assert.deepEqual(await stored(hours.commitmentId), { unit: "minutos", target: 120 });

    const run = await quantity(km.goalId, "correr", "km", 5);
    if (!run.ok) throw new Error(run.error);
    const ignored = await quantity(km.goalId, "otra", "horas", 2);
    if (!ignored.ok) throw new Error(ignored.error);
    assert.deepEqual(await stored(ignored.commitmentId), { unit: "km", target: 2 });
  } finally {
    await sql`delete from goals.goals where id in ${sql([fresh.goalId, timed.goalId, km.goalId])}`;
  }
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from goals.goals where user_id = ${personId} and name like 'RP-66 %'`;
  assert.equal(n, 0);
});

test("sin final: a goal made with no end stores null, takes a rhythm in km, and a loose habit stores no goal", async () => {
  const endless = await createGoal({ name: "RP-99 abierta", horizon: null });
  if (!endless.ok) throw new Error(endless.error);
  try {
    const [row] = await sql<{ horizon: string | null }[]>`select horizon::text as horizon from goals.goals where id = ${endless.goalId}`;
    assert.equal(row.horizon, null);
    const run = await addCommitment({
      goalId: endless.goalId, name: "correr", cadenceKind: "daily", satisfaction: "quantity", unit: "km", targetQuantity: 5,
    });
    if (!run.ok) throw new Error(run.error);
    assert.deepEqual(await setRhythm({ goalId: endless.goalId, amount: 44_641 }), { ok: true });
    const loose = await addCommitment({ name: "RP-100 suelto", cadenceKind: "daily", satisfaction: "tap" } as never);
    if (!loose.ok) throw new Error(loose.error);
    const [kept] = await sql<{ goal_id: string | null }[]>`select goal_id from goals.commitments where id = ${loose.commitmentId}`;
    assert.equal(kept.goal_id, null);
    await sql`delete from goals.commitments where id = ${loose.commitmentId}`;
  } finally {
    await sql`delete from goals.goals where id = ${endless.goalId}`;
  }
});

test("moveHorizon: with two phases the refusal judges the last one, names it, and the column holds", async () => {
  const created = await createGoal({ name: "RP-114 dos fases", horizon: shiftDay(today, 90) });
  if (!created.ok) throw new Error(created.error);
  const goalId = created.goalId;
  try {
    await sql`
      insert into goals.phases (user_id, goal_id, aim, starts_on, ends_on)
      values (${personId}, ${goalId}, 'Base', ${shiftDay(today, 1)}, ${shiftDay(today, 10)}),
             (${personId}, ${goalId}, 'Pico', ${shiftDay(today, 11)}, ${shiftDay(today, 40)})`;

    const refused = await moveHorizon({ goalId, horizon: shiftDay(today, 20) });
    assert.deepEqual(refused, {
      ok: false,
      error: "goal.errors.horizonBeforePhase",
      values: { name: "Pico", date: shiftDay(today, 40) },
    });
    assert.equal(await goalHorizon(goalId), shiftDay(today, 90));

    const past = await moveHorizon({ goalId, horizon: today });
    assert.equal(past.ok, false);
    if (!past.ok) assert.equal(past.error, "goal.errors.horizonPast");
    assert.equal(await goalHorizon(goalId), shiftDay(today, 90));

    const after = await moveHorizon({ goalId, horizon: shiftDay(today, 50) });
    assert.equal(after.ok, true);
    assert.equal(await goalHorizon(goalId), shiftDay(today, 50));
  } finally {
    await sql`delete from goals.goals where id = ${goalId}`;
  }
});

// RP-117: the act that gives a goal its measure, the same for the screen and the AI.
test("setGoalMeasure: a goal with no measure takes the name and the unit asked, hours kept as minutes, and nothing else is written", async () => {
  const [move] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon) values (${personId}, 'RP-117 Mudanza', ${shiftDay(today, 60)}) returning id`;
  const [study] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon) values (${personId}, 'RP-117 Estudio', ${shiftDay(today, 60)}) returning id`;
  const measureOf = async (goalId: string) => {
    const [row] = await sql<{ measure_name: string | null; measure_unit: string | null; rhythm: number | null }[]>`
      select measure_name, measure_unit, rhythm from goals.goals where id = ${goalId}`;
    return row;
  };
  const footprint = async (goalId: string) => {
    const [row] = await sql<{ commitments: number; budgets: number }[]>`
      select (select count(*)::int from goals.commitments where goal_id = ${goalId}) as commitments,
             (select count(*)::int from goals.month_budgets where goal_id = ${goalId}) as budgets`;
    return row;
  };
  try {
    const before = await footprint(move.id);
    revalidated.length = 0;
    assert.deepEqual(await setGoalMeasure({ goalId: move.id, name: "Cajas embaladas", unit: "cajas" }), { ok: true });
    assert.deepEqual(await measureOf(move.id), { measure_name: "Cajas embaladas", measure_unit: "cajas", rhythm: null });
    assert.deepEqual(await footprint(move.id), before);
    assert.deepEqual(revalidated, [`/metas/${move.id}`, "/"]);

    assert.deepEqual(await setGoalMeasure({ goalId: study.id, name: "Estudio", unit: "horas" }), { ok: true });
    assert.deepEqual(await measureOf(study.id), { measure_name: "Estudio", measure_unit: "minutos", rhythm: null });
  } finally {
    await sql`delete from goals.goals where id in ${sql([move.id, study.id])}`;
  }
});

test("setGoalMeasure: a measure once put never changes, and the refusal names the unit it keeps", async () => {
  const [read] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
    values (${personId}, 'RP-117 Leer', ${shiftDay(today, 60)}, 'Leer', 'páginas') returning id`;
  try {
    assert.deepEqual(await setGoalMeasure({ goalId: read.id, name: "Km", unit: "km" }), {
      ok: false,
      error: "plan.errors.measureKept",
      values: { name: "páginas" },
    });
    const [row] = await sql<{ measure_name: string; measure_unit: string }[]>`
      select measure_name, measure_unit from goals.goals where id = ${read.id}`;
    assert.deepEqual(row, { measure_name: "Leer", measure_unit: "páginas" });
  } finally {
    await sql`delete from goals.goals where id = ${read.id}`;
  }
});

test("setGoalMeasure: a closed goal, a holder, another person's goal and a bad input are each refused with their key and write nothing", async () => {
  const [archived] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, archived_at)
    values (${personId}, 'RP-117 archivada', ${shiftDay(today, 60)}, now()) returning id`;
  const [ended] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, created_at)
    values (${personId}, 'RP-117 terminada', ${today}, now() - interval '20 days') returning id`;
  const [holder] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon) values (${personId}, 'RP-117 madre', ${shiftDay(today, 90)}) returning id`;
  await sql`
    insert into goals.goals (user_id, name, horizon, parent_id)
    values (${personId}, 'RP-117 hija', ${shiftDay(today, 60)}, ${holder.id})`;
  const [foreign] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon)
    values (${await memberId()}, 'RP-117 ajena', ${shiftDay(today, 60)}) returning id`;
  const ids = [archived.id, ended.id, holder.id, foreign.id];
  const measured = async () => {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from goals.goals where id in ${sql(ids)} and (measure_name is not null or measure_unit is not null)`;
    return row.n;
  };
  const ask = (goalId: string, name = "Km", unit = "km") => setGoalMeasure({ goalId, name, unit });
  try {
    revalidated.length = 0;
    assert.deepEqual(await ask(archived.id), { ok: false, error: "plan.errors.goalNotFound" });
    assert.deepEqual(await ask(ended.id), { ok: false, error: "plan.errors.goalNotFound" });
    assert.deepEqual(await ask(holder.id), { ok: false, error: "plan.errors.holderNoMeasure" });
    assert.deepEqual(await ask(foreign.id), { ok: false, error: "plan.errors.notFound" });
    assert.deepEqual(await ask(randomUUID()), { ok: false, error: "plan.errors.notFound" });
    assert.equal((await ask(holder.id, "   ")).ok, false);
    assert.deepEqual(await ask(holder.id, "   "), { ok: false, error: "plan.errors.nameEmpty" });
    assert.deepEqual(await ask(holder.id, "a".repeat(121)), { ok: false, error: "plan.errors.nameTooLong" });
    assert.deepEqual(await ask(holder.id, "Km", ""), { ok: false, error: "plan.errors.unitEmpty" });
    assert.deepEqual(await ask(holder.id, "Km", "u".repeat(41)), { ok: false, error: "plan.errors.unitTooLong" });
    assert.deepEqual(revalidated, []);
    assert.equal(await measured(), 0);
  } finally {
    await sql`delete from goals.goals where id = ${holder.id} or parent_id = ${holder.id}`;
    await sql`delete from goals.goals where id in ${sql([archived.id, ended.id, foreign.id])}`;
  }
});

test("setGoalMeasure: one statement reaches the wire between the begin and the commit", async () => {
  const [goal] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon) values (${personId}, 'RP-117 un viaje', ${shiftDay(today, 60)}) returning id`;
  const body = (from: number) =>
    wire.slice(from).filter((q) => !/^\s*(begin|commit|rollback)\b/i.test(q) && !/set_config/i.test(q));
  try {
    for (const [name, unit] of [["Pasos", "pasos"], ["Otra", "otra"]]) {
      const from = wire.length;
      await setGoalMeasure({ goalId: goal.id, name, unit });
      assert.equal(body(from).length, 1, `${name}: ${body(from).join(" | ")}`);
    }
  } finally {
    await sql`delete from goals.goals where id = ${goal.id}`;
  }
});

test("setGoalMeasure: the statement itself scopes the goal to the person, not the policy alone", async () => {
  // The row policy already hides another person's goal; the filter is the second lock, so it is read off the wire.
  const [goal] = await sql<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon) values (${personId}, 'RP-117 filtro', ${shiftDay(today, 60)}) returning id`;
  try {
    const from = wire.length;
    await setGoalMeasure({ goalId: goal.id, name: "Pasos", unit: "pasos" });
    const statement = wire.slice(from).find((q) => /update\s+"?goals"?\."?goals"?\s+set\s+measure_name/i.test(q));
    assert.ok(statement, wire.slice(from).join(" | "));
    assert.match(statement, /from\s+"?goals"?\."?goals"?\s+where\s+id\s*=\s*\$\d+\s+and\s+user_id\s*=\s*\$\d+/i);
  } finally {
    await sql`delete from goals.goals where id = ${goal.id}`;
  }
});

// RP-121: the first quantity commitment gives the goal its unit, never its own name as the measure's name.
test("addCommitment: the first quantity commitment measures the goal in its unit and names the measure after that unit, not after itself", async () => {
  const mk = async (name: string, measure?: [string, string]) => {
    const [row] = await sql<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
      values (${personId}, ${name}, ${shiftDay(today, 60)}, ${measure?.[0] ?? null}, ${measure?.[1] ?? null}) returning id`;
    return row.id;
  };
  const measureOf = async (goalId: string) => {
    const [row] = await sql<{ measure_name: string | null; measure_unit: string | null }[]>`
      select measure_name, measure_unit from goals.goals where id = ${goalId}`;
    return row;
  };
  const run = await mk("RP-121 Correr 10 km");
  const study = await mk("RP-121 Estudio");
  const read = await mk("RP-121 Leer", ["Páginas", "páginas"]);
  const yesNo = await mk("RP-121 Sí o no");
  try {
    const quantity = (goalId: string, name: string, unit: string, targetQuantity: number) =>
      addCommitment({ goalId, name, cadenceKind: "daily", satisfaction: "quantity", unit, targetQuantity });
    assert.equal((await quantity(run, "Rodaje suave", "km", 5)).ok, true);
    assert.deepEqual(await measureOf(run), { measure_name: "km", measure_unit: "km" });

    assert.equal((await quantity(study, "Repaso", "horas", 2)).ok, true);
    assert.deepEqual(await measureOf(study), { measure_name: "minutos", measure_unit: "minutos" });
    const [target] = await sql<{ target_quantity: number }[]>`
      select target_quantity from goals.commitments where goal_id = ${study}`;
    assert.equal(target.target_quantity, 120);

    assert.equal((await quantity(read, "Rodaje suave", "km", 5)).ok, true);
    assert.deepEqual(await measureOf(read), { measure_name: "Páginas", measure_unit: "páginas" });

    assert.equal((await addCommitment({ goalId: yesNo, name: "Estirar", cadenceKind: "daily", satisfaction: "tap" })).ok, true);
    assert.deepEqual(await measureOf(yesNo), { measure_name: null, measure_unit: null });
  } finally {
    await sql`delete from goals.commitments where goal_id in ${sql([run, study, read, yesNo])}`;
    await sql`delete from goals.goals where id in ${sql([run, study, read, yesNo])}`;
  }
});
