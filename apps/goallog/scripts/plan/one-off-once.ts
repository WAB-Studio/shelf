// Drives `declareFact` and `completeOneOff` (`app/actions/facts.ts`, RP-19,
// RP-05, RP-22) as a person through `actAs`: a one-off marked twice, or from
// two places at once, keeps one fact; the commitment's own path is unchanged.
// The admin pool only counts rows.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import { pgCode } from "@/lib/db-error";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const door = postgres(process.env.DATABASE_URL!, { prepare: false, max: 4 });
(globalThis as unknown as { sql: unknown }).sql = door;

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
}

let session: typeof import("@/lib/session");
let facts: typeof import("@/app/actions/facts");
let oneOffs: typeof import("@/app/actions/one-offs");
let plan: typeof import("@/app/actions/plan");
let day: typeof import("@/lib/queries/day");
let owner: Person;
let today: string;
const goalIds: string[] = [];

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(fn: () => Promise<T>) => session.actAs(asResolved(owner), fn);

async function freshLoose(): Promise<string> {
  const made = await as(() => oneOffs.createOneOff({ name: "suelta", day: today }));
  if (!made.ok) throw new Error(`createOneOff: ${made.error}`);
  return made.oneOffId;
}

async function factsOf(oneOffId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from goals.facts where one_off_id = ${oneOffId}`;
  return row.n;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  facts = await import("@/app/actions/facts");
  oneOffs = await import("@/app/actions/one-offs");
  plan = await import("@/app/actions/plan");
  day = await import("@/lib/queries/day");
  today = (await import("@/lib/zone")).todayInZone();
  const runId = await openCheckRun(admin);
  [owner] = await createPeople(admin, runId, door, 1);
});

after(async () => {
  try {
    if (goalIds.length > 0) await admin`delete from goals.goals where id in ${admin(goalIds)}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("a second mark of a done one-off answers the fact it has and writes nothing", async () => {
  const oneOffId = await freshLoose();
  const first = await as(() => facts.declareFact({ oneOffId }));
  const second = await as(() => facts.declareFact({ oneOffId }));
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(await factsOf(oneOffId), 1);
});

// With migration 0015 the «lock removed» and «prior read removed» mutants are equivalent: the unique index,
// `on conflict do nothing` and the re-read by `one_off_id` leave one fact either way.
test("two marks at once leave one fact and both answer it", async () => {
  const oneOffId = await freshLoose();
  const [a, b] = await Promise.all([
    as(() => facts.declareFact({ oneOffId })),
    as(() => facts.declareFact({ oneOffId })),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a, b);
  assert.equal(await factsOf(oneOffId), 1);
});

test("completeOneOff twice leaves one fact", async () => {
  const oneOffId = await freshLoose();
  const first = await as(() => oneOffs.completeOneOff({ oneOffId }));
  const second = await as(() => oneOffs.completeOneOff({ oneOffId }));
  assert.deepEqual(second, first);
  assert.equal(await factsOf(oneOffId), 1);
});

test("undoing after two marks leaves the one-off pending", async () => {
  const oneOffId = await freshLoose();
  const first = await as(() => facts.declareFact({ oneOffId }));
  await as(() => facts.declareFact({ oneOffId }));
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(await as(() => facts.undoFact({ factId: first.factId })), { ok: true });
  assert.equal(await factsOf(oneOffId), 0);
  const loaded = await as(() => day.loadDay(today));
  assert.ok(loaded.oneOffs.some((item) => item.id === oneOffId));
});

test("a commitment marked twice the same day is still one fact", async () => {
  const goal = await as(() => plan.createGoal({ name: "una vez", horizon: `${today.slice(0, 4)}-12-31` }));
  if (!goal.ok) throw new Error(`createGoal: ${goal.error}`);
  goalIds.push(goal.goalId);
  const commitment = await as(() =>
    plan.addCommitment({ goalId: goal.goalId, name: "tap", cadenceKind: "daily", satisfaction: "tap" } as never),
  );
  if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
  const commitmentId = commitment.commitmentId;
  const first = await as(() => facts.declareFact({ commitmentId }));
  const second = await as(() => facts.declareFact({ commitmentId }));
  assert.deepEqual(second, first);
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from goals.facts where commitment_id = ${commitmentId}`;
  assert.equal(row.n, 1);
});

test("a parent with sub-tasks is still refused", async () => {
  const goal = await as(() => plan.createGoal({ name: "padre", horizon: `${today.slice(0, 4)}-12-31` }));
  if (!goal.ok) throw new Error(`createGoal: ${goal.error}`);
  goalIds.push(goal.goalId);
  // The child's estimate needs a measured goal; the parent's refusal below is declareFact's, not createOneOff's.
  await admin`update goals.goals set measure_name = 'horas', measure_unit = 'minutos' where id = ${goal.goalId}`;
  const parent = await as(() => oneOffs.createOneOff({ name: "padre", day: null, goalId: goal.goalId, plannedMonth: today.slice(0, 7) }));
  if (!parent.ok) throw new Error(`createOneOff parent: ${parent.error}`);
  const child = await as(() =>
    oneOffs.createOneOff({ name: "hija", day: null, estimate: 10, parentId: parent.oneOffId }),
  );
  if (!child.ok) throw new Error(`createOneOff child: ${child.error}`);
  // `facts_insert_self` refuses a fact on a parent: 42501, not any other failure.
  await assert.rejects(
    () => as(() => facts.declareFact({ oneOffId: parent.oneOffId })),
    (error: unknown) => pgCode(error) === "42501",
  );
  assert.equal(await factsOf(parent.oneOffId), 0);
});
