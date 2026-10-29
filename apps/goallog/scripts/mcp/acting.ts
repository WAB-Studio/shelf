// Proves RP-39, RP-56 and RNP-05 at the seam: inside `actAs` every loader and
// act runs as the key's person, outside it nothing is anyone. `next/headers`
// answers an empty cookie jar, so the cookie path can only ever say «nobody».
// Statements are counted off the wire as `resolve.ts` does, `begin`/`commit`
// and the driver's one type fetch netted out.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, test } from "node:test";

import { sql } from "drizzle-orm";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "./lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const wire: string[] = [];
const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  debug: (_connection: number, query: string) => void wire.push(query),
});
(globalThis as unknown as { sql: unknown }).sql = door;

let session: typeof import("@/lib/session");
let goalQueries: typeof import("@/lib/queries/goal");
let plan: typeof import("@/app/actions/plan");
let budgets: typeof import("@/app/actions/budgets");
let subject: Person;
let intruder: Person;
let subjectGoal: string;
let intruderGoal: string;

// Only `resolveBearer` builds a `ResolvedPerson`; a check names one by hand.
const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") {
      return { cookies: async () => ({ getAll: () => [], set() {} }) };
    }
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
}

function horizon(): string {
  const day = new Date(Date.now() + 60 * 86_400_000);
  return day.toISOString().slice(0, 10);
}

async function budgetRows(goalId: string): Promise<number> {
  const [row] = await admin`select count(*)::int as n from goals.month_budgets where goal_id = ${goalId}`;
  return row.n;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  goalQueries = await import("@/lib/queries/goal");
  plan = await import("@/app/actions/plan");
  budgets = await import("@/app/actions/budgets");
  const runId = await openCheckRun(admin);
  [subject, intruder] = await createPeople(admin, runId, door, 2);

  for (const [person, label] of [[subject, "subject"], [intruder, "intruder"]] as const) {
    const made = await session.actAs(asResolved(person), () =>
      plan.createGoal({ name: `acting ${label}`, horizon: horizon() }),
    );
    if (!made.ok) throw new Error(`createGoal as ${label}: ${made.error}`);
    if (label === "subject") subjectGoal = made.goalId;
    else intruderGoal = made.goalId;
  }
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

test("outside actAs nobody is signed in and the door refuses", async () => {
  assert.equal(await session.getPerson(), null);
  await assert.rejects(session.withGoalsDb(async () => 1), /without a verified session/);
});

test("inside actAs the person is the subject and the subject's goal reads", async () => {
  await session.actAs(asResolved(subject), async () => {
    assert.equal((await session.getPerson())?.id, subject.id);
    assert.equal((await session.getPerson())?.email, subject.email);
    const view = await goalQueries.loadGoal(subjectGoal);
    assert.equal(view?.id, subjectGoal);
    assert.equal(await goalQueries.loadGoal(intruderGoal), null, "the subject read the intruder's goal");
  });
});

// The role is seated by its own `set_config`, so no row depends on the claim's
// `role`; what a policy or `auth.role()` reads is the claim itself.
test("the claims settled inside actAs are the key's person, authenticated", async () => {
  const claims = await session.actAs(asResolved(subject), () =>
    session.withGoalsDb(async (tx) => {
      const rows = await tx.execute(sql`select current_setting('request.jwt.claims', true) as claims`);
      return JSON.parse((rows as unknown as { claims: string }[])[0].claims);
    }),
  );
  assert.deepEqual(claims, { sub: subject.id, email: subject.email, role: "authenticated", aud: "authenticated" });
});

test("an act on the intruder's goal answers not-found and writes nothing", async () => {
  const month = new Date().toISOString().slice(0, 7);
  const before = await budgetRows(intruderGoal);
  const result = await session.actAs(asResolved(subject), () =>
    budgets.setMonthBudget({ goalId: intruderGoal, month, amount: 100 }),
  );
  assert.deepEqual(result, { ok: false, error: "month.errors.notFound" });
  assert.equal(await budgetRows(intruderGoal), before);
});

test("after actAs returns the person is nobody again", async () => {
  await session.actAs(asResolved(subject), async () => undefined);
  assert.equal(await session.getPerson(), null);
  await assert.rejects(session.withGoalsDb(async () => 1), /without a verified session/);
});

test("two actAs under one Promise.all each read only their own goal", async () => {
  const read = (person: Person) =>
    session.actAs(asResolved(person), async () => ({
      who: (await session.getPerson())?.id,
      own: (await goalQueries.loadGoal(person === subject ? subjectGoal : intruderGoal))?.id,
      other: await goalQueries.loadGoal(person === subject ? intruderGoal : subjectGoal),
    }));
  const [a, b] = await Promise.all([read(subject), read(intruder)]);
  assert.deepEqual([a.who, a.own, a.other], [subject.id, subjectGoal, null]);
  assert.deepEqual([b.who, b.own, b.other], [intruder.id, intruderGoal, null]);
});

test("loadGoal inside actAs issues four application statements", async () => {
  const run = () => session.actAs(asResolved(subject), () => goalQueries.loadGoal(subjectGoal));
  await run(); // warm the connection and its type fetch
  wire.length = 0;
  await run();
  const application = wire.filter((query) => !/^\s*(begin|commit)\s*$/i.test(query));
  assert.equal(application.length, 4, `expected four, the wire carried:\n${application.join("\n---\n")}`);
});
