// Proves RNP-12 and RNP-18 at the loaders: `/metas/<id>`, `/meses` and
// `/meses/<m>` each pay `loadGoal`'s four statements plus the rail's one,
// however many of the layout and the screen read `listGoals`. Each page's
// loaders are called as the page calls them (`app/(app)/layout.tsx` beside
// `GoalScreen`, `MonthsScreen`, `MonthScreen`), inside one request scope.
// `cache()` dedupes only under a render, so `react` is answered with its
// react-server build and a dispatcher that holds one cache per `renderAs`
// call: the real `cache()`, not a copy of it. Statements are counted off the
// wire, `begin`/`commit` netted out, as `scripts/mcp/acting.ts` does.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import Module from "node:module";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";
import postgres from "postgres";

const admin = adminSql();
const wire: string[] = [];
const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  debug: (_connection: number, query: string) => void wire.push(query),
});
(globalThis as unknown as { sql: unknown }).sql = door;

const requestScope = new AsyncLocalStorage<Map<unknown, unknown>>();

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  const require = createRequire(import.meta.url);
  // `react`'s exports map does not name the build, so it is loaded by path.
  const serverReact = require(join(dirname(require.resolve("react/package.json")), "cjs/react.react-server.development.js")) as {
    __SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { A: unknown };
  };
  serverReact.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.A = {
    getCacheForType(create: () => unknown) {
      const scope = requestScope.getStore();
      if (!scope) return create();
      if (!scope.has(create)) scope.set(create, create());
      return scope.get(create);
    },
  };
  untyped._load = (request, parent, isMain) => {
    if (request === "react") return serverReact;
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    return originalLoad(request, parent, isMain);
  };
}

let session: typeof import("@/lib/session");
let goalQueries: typeof import("@/lib/queries/goal");
let plan: typeof import("@/app/actions/plan");
let subject: Person;
let goalId: string;

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  goalQueries = await import("@/lib/queries/goal");
  plan = await import("@/app/actions/plan");
  const runId = await openCheckRun(admin);
  [subject] = await createPeople(admin, runId, door, 1);
  const horizon = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  const made = await session.actAs(asResolved(subject), () => plan.createGoal({ name: "page statements", horizon }));
  if (!made.ok) throw new Error(`createGoal: ${made.error}`);
  goalId = made.goalId;
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

// The layout reads the rail beside the page; every screen under test reads
// `loadGoal` and `listGoals` in one `Promise.all`.
async function pageStatements(): Promise<number> {
  const render = () =>
    session.actAs(asResolved(subject), () =>
      requestScope.run(new Map(), () =>
        Promise.all([
          goalQueries.listGoals(),
          Promise.all([goalQueries.loadGoal(goalId), goalQueries.listGoals()]),
        ]),
      ),
    );
  await render(); // warm the connection and its type fetch
  wire.length = 0;
  await render();
  return wire.filter((query) => !/^\s*(begin|commit)\s*$/i.test(query)).length;
}

for (const page of ["/metas/<id>", "/meses", "/meses/<m>"]) {
  test(`${page}: loadGoal's four statements plus the rail once (two)`, async () => {
    assert.equal(await pageStatements(), 6);
  });
}

// A statement here is what the wire carries: every transaction's one settle
// plus its query, so `loadGoal` is four (RNP-12) and the rail is two.
async function statementsOf(read: () => Promise<unknown>): Promise<number> {
  const run = () => session.actAs(asResolved(subject), read);
  await run();
  wire.length = 0;
  await run();
  return wire.filter((query) => !/^\s*(begin|commit)\s*$/i.test(query)).length;
}

test("loadGoal alone is four statements and the rail alone is two", async () => {
  assert.equal(await statementsOf(() => goalQueries.loadGoal(goalId)), 4);
  assert.equal(await statementsOf(() => goalQueries.listGoals()), 2);
});

// RP-127: «Borrar la meta» and the measure's edit are offered off two flags of the one existing statement.
test("loadGoal carries deletable and measureFed in its four statements", async () => {
  let loaded: Awaited<ReturnType<typeof goalQueries.loadGoal>> = null;
  const count = await statementsOf(async () => {
    loaded = await goalQueries.loadGoal(goalId);
  });
  assert.equal(count, 4);
  assert.equal(typeof loaded!.deletable, "boolean");
  assert.equal(typeof loaded!.measureFed, "boolean");
  assert.equal(loaded!.deletable, true);
  assert.equal(loaded!.measureFed, false);
});

// A general with two large goals and a small one under the first: one load
// reads the whole branch, so the count does not move (RNP-12).
test("a general with goals under it: loadGoal is still four statements and the page six", async () => {
  const horizon = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  const [general] = await admin<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, position)
    values (${subject.id}, 'statements general', ${horizon}, 'Medida', 'min', 910) returning id`;
  const kids: string[] = [];
  for (const [name, position, parent] of [
    ["statements large 1", 1, general.id],
    ["statements large 2", 2, general.id],
  ] as const) {
    const [kid] = await admin<{ id: string }[]>`
      insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, position, parent_id)
      values (${subject.id}, ${name}, ${horizon}, 'Medida', 'min', ${position}, ${parent}) returning id`;
    kids.push(kid.id);
  }
  await admin`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit, position, parent_id)
    values (${subject.id}, 'statements small', ${horizon}, 'Medida', 'min', 1, ${kids[0]})`;

  assert.equal(await statementsOf(() => goalQueries.loadGoal(general.id)), 4);
  // A goal holding goals is not deletable: the flag is false whatever its facts.
  assert.equal((await session.actAs(asResolved(subject), () => goalQueries.loadGoal(general.id)))!.deletable, false);
  goalId = general.id;
  assert.equal(await pageStatements(), 6);
});

// «El plan» of a general draws each goal's first amount from this one load, not from a `loadGoal` per goal.
test("a general's children carry their first planned month from the one load (four statements)", async () => {
  const [general] = await admin<{ id: string }[]>`
    select id from goals.goals where user_id = ${subject.id} and name = 'statements general'`;
  const [large] = await admin<{ id: string }[]>`
    select id from goals.goals where user_id = ${subject.id} and name = 'statements large 2'`;
  const month = new Date(Date.now() + 31 * 86_400_000).toISOString().slice(0, 7) + "-01";
  await admin`insert into goals.month_budgets (user_id, goal_id, month, amount) values (${subject.id}, ${large.id}, ${month}::date, 120)`;

  let view: Awaited<ReturnType<typeof goalQueries.loadGoal>> = null;
  const count = await statementsOf(async () => {
    view = await goalQueries.loadGoal(general.id);
  });
  assert.equal(count, 4);
  const kid = view!.children.find((child) => child.id === large.id);
  assert.deepEqual(kid?.firstPlanned, { month, planned: 120 });
  assert.equal(view!.children.find((child) => child.name === "statements large 1")?.firstPlanned, null);
});
