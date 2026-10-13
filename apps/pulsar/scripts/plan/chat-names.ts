// Proves `loadChangeNames` (`lib/queries/chat.ts`, RP-92): the names a change
// touches come in one statement, under the person's own policies, and an id
// that is not theirs is absent. Statements are counted off the wire, `begin`
// and `commit` netted out; a transaction is its settle plus its query.
import assert from "node:assert/strict";
import Module from "node:module";
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

function installStubs(): void {
  stubServerOnly();
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    return originalLoad(request, parent, isMain);
  };
}

let session: typeof import("@/lib/session");
let chat: typeof import("@/lib/queries/chat");
let subject: Person;
let other: Person;
const ids = { goal: "", task: "", commitment: "", foreignGoal: "", foreignTask: "", foreignCommitment: "" };

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;

async function seed(owner: Person, label: string) {
  const horizon = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
  const [goal] = await admin<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, measure_name, measure_unit)
    values (${owner.id}, ${`${label} meta`}, ${horizon}, 'Medida', 'min') returning id`;
  const [task] = await admin<{ id: string }[]>`
    insert into goals.one_offs (user_id, name) values (${owner.id}, ${`${label} tarea`}) returning id`;
  const [commitment] = await admin<{ id: string }[]>`
    insert into goals.commitments (user_id, goal_id, name, cadence_kind, satisfaction, target_quantity, unit)
    values (${owner.id}, ${goal.id}, ${`${label} compromiso`}, 'daily', 'quantity', 10, 'min') returning id`;
  return { goal: goal.id, task: task.id, commitment: commitment.id };
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  chat = await import("@/lib/queries/chat");
  const runId = await openCheckRun(admin);
  [subject, other] = await createPeople(admin, runId, door, 2);
  const mine = await seed(subject, "chat-names mía");
  const theirs = await seed(other, "chat-names ajena");
  Object.assign(ids, {
    goal: mine.goal,
    task: mine.task,
    commitment: mine.commitment,
    foreignGoal: theirs.goal,
    foreignTask: theirs.task,
    foreignCommitment: theirs.commitment,
  });
});

after(async () => {
  try {
    // Exact ids, never by user (docs/TRAPS.md); the people's cascade is dropPeople's.
    await admin`delete from goals.commitments where id in ${admin([ids.commitment, ids.foreignCommitment])}`;
    await admin`delete from goals.one_offs where id in ${admin([ids.task, ids.foreignTask])}`;
    await admin`delete from goals.goals where id in ${admin([ids.goal, ids.foreignGoal])}`;
    await dropPeople(admin);
  } finally {
    await door.end();
    await admin.end();
  }
});

function run<T>(read: () => Promise<T>): Promise<T> {
  return session.actAs(asResolved(subject), read);
}

test("loadChangeNames: three kinds of ids are one statement (plus the settle)", async () => {
  const read = () =>
    chat.loadChangeNames({ goals: [ids.goal], tasks: [ids.task], commitments: [ids.commitment] });
  await run(read);
  wire.length = 0;
  const names = await run(read);
  assert.equal(wire.filter((q) => !/^\s*(begin|commit)\s*$/i.test(q)).length, 2);
  assert.deepEqual(names.goals.get(ids.goal), { name: "chat-names mía meta", unit: "min" });
  assert.deepEqual(names.tasks.get(ids.task), { name: "chat-names mía tarea" });
  assert.deepEqual(names.commitments.get(ids.commitment), { name: "chat-names mía compromiso", unit: "min" });
});

test("loadChangeNames: another person's ids are absent", async () => {
  const names = await run(() =>
    chat.loadChangeNames({
      goals: [ids.goal, ids.foreignGoal],
      tasks: [ids.task, ids.foreignTask],
      commitments: [ids.commitment, ids.foreignCommitment],
    }),
  );
  assert.equal(names.goals.has(ids.foreignGoal), false);
  assert.equal(names.tasks.has(ids.foreignTask), false);
  assert.equal(names.commitments.has(ids.foreignCommitment), false);
  assert.equal(names.goals.size + names.tasks.size + names.commitments.size, 3);
});

test("loadChangeNames: empty input pays no round trip", async () => {
  wire.length = 0;
  const names = await run(() => chat.loadChangeNames({ goals: [], tasks: [], commitments: [] }));
  assert.equal(wire.length, 0);
  assert.equal(names.goals.size + names.tasks.size + names.commitments.size, 0);
});
