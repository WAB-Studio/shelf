// Drives `declareFact` (`app/actions/facts.ts`, RP-06, RP-56) as a person
// through `actAs`: a day before the goal opened is refused with the goal's
// own key, first and alone. The admin pool only backdates what no action
// lets be backdated and reads rows back. Statements are counted off the wire.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const wire: string[] = [];
const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  debug: (_connection: number, query: string) => void wire.push(query),
});
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
let plan: typeof import("@/app/actions/plan");
let facts: typeof import("@/app/actions/facts");
let owner: Person;
let today: string;
let dayFrom: (delta: number) => string;

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(person: Person, fn: () => Promise<T>) => session.actAs(asResolved(person), fn);

const goalIds: string[] = [];

// A goal opened `goalAgo` days back with one tap commitment created `commitmentAgo` days back.
async function seed(goalAgo: number, commitmentAgo: number): Promise<{ goalId: string; commitmentId: string }> {
  const goal = await as(owner, () => plan.createGoal({ name: "antes de la meta", horizon: dayFrom(60) }));
  if (!goal.ok) throw new Error(`createGoal: ${goal.error}`);
  goalIds.push(goal.goalId);
  const commitment = await as(owner, () =>
    plan.addCommitment({ goalId: goal.goalId, name: "tap", cadenceKind: "daily", satisfaction: "tap" } as never),
  );
  if (!commitment.ok) throw new Error(`addCommitment: ${commitment.error}`);
  await admin`update goals.goals set created_at = ${`${dayFrom(-goalAgo)}T12:00:00Z`} where id = ${goal.goalId}`;
  await admin`update goals.commitments set created_at = ${`${dayFrom(-commitmentAgo)}T12:00:00Z`} where id = ${commitment.commitmentId}`;
  return { goalId: goal.goalId, commitmentId: commitment.commitmentId };
}

async function factsOf(commitmentId: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`select count(*)::int as n from goals.facts where commitment_id = ${commitmentId}`;
  return row.n;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  plan = await import("@/app/actions/plan");
  facts = await import("@/app/actions/facts");
  const { todayInZone, civilDateToDate, dateToCivilDate } = await import("@/lib/zone");
  today = todayInZone();
  dayFrom = (delta) => {
    const date = civilDateToDate(today);
    date.setUTCDate(date.getUTCDate() + delta);
    return dateToCivilDate(date);
  };
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

test("a goal opened today refuses yesterday with the goal's own reason and writes nothing", async () => {
  const { commitmentId } = await seed(0, 0);
  const result = await as(owner, () => facts.declareFact({ commitmentId, day: dayFrom(-1) }));
  assert.deepEqual(result, { ok: false, error: "day.errors.dayBeforeGoal" });
  assert.equal(await factsOf(commitmentId), 0);
});

test("the goal's check comes before the commitment's: a day before both says the goal", async () => {
  const { commitmentId } = await seed(6, 3);
  const result = await as(owner, () => facts.declareFact({ commitmentId, day: dayFrom(-7) }));
  assert.deepEqual(result, { ok: false, error: "day.errors.dayBeforeGoal" });
});

test("a goal opened 10 days back with a commitment made 3 days back refuses day -5 by the commitment", async () => {
  const { commitmentId } = await seed(10, 3);
  const result = await as(owner, () => facts.declareFact({ commitmentId, day: dayFrom(-5) }));
  assert.deepEqual(result, { ok: false, error: "day.errors.dayBeforeCommitment" });
  assert.equal(await factsOf(commitmentId), 0);
});

test("the goal's opening day itself is accepted", async () => {
  const { commitmentId } = await seed(2, 2);
  const result = await as(owner, () => facts.declareFact({ commitmentId, day: dayFrom(-2) }));
  assert.equal(result.ok, true);
  assert.equal(await factsOf(commitmentId), 1);
});

test("declareFact on a commitment is 4 statements: the settle, the lock, one read of commitment and goal, the insert", async () => {
  const { commitmentId } = await seed(2, 2);
  wire.length = 0;
  const result = await as(owner, () => facts.declareFact({ commitmentId, day: dayFrom(-1) }));
  assert.equal(result.ok, true);
  const statements = wire.filter((query) => !/^\s*(begin|commit)\s*$/i.test(query));
  console.log(`declareFact statements: ${statements.length}`);
  for (const s of statements) console.log(`  ${s.slice(0, 90).replace(/\s+/g, " ")}`);
  assert.equal(statements.length, STATEMENTS);
});

const STATEMENTS = 4;
