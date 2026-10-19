// M8 (RP-56, RP-86, RP-92): a create resent after its answer was lost writes
// once and answers what it answered the first time. `createOneOff`,
// `confirmImport` and the chat's «Hacer» (`makeChatChange`) take an optional
// `requestId`; without one each call writes, as before. The concurrent replay
// is two real transactions: the first held just before its commit
// (`lib/hold.ts`) while the second, with the same id, runs. The acts run as a
// person through `actAs`; the admin pool only counts rows and cleans up.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Module from "node:module";
import { after, before, test } from "node:test";

import { adminSql, createPeople, dropPeople, openCheckRun, stubServerOnly, type Person } from "../mcp/lib/people";
import { heldDoor, interleave } from "./lib/hold";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

const admin = adminSql();
const door = heldDoor(process.env.DATABASE_URL!);
(globalThis as unknown as { sql: unknown }).sql = door.sql;

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
let oneOffs: typeof import("@/app/actions/one-offs");
let importActions: typeof import("@/app/actions/import");
let chat: typeof import("@/app/actions/chat");
let owner: Person;
let today: string;
const RUN = randomUUID().slice(0, 8);

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const as = <T>(fn: () => Promise<T>) => session.actAs(asResolved(owner), fn);

function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

async function goalsNamed(name: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    select count(*)::int as n from goals.goals where user_id = ${owner.id} and name = ${name}`;
  return row.n;
}

async function oneOffsNamed(name: string): Promise<number> {
  const [row] = await admin<{ n: number }[]>`
    select count(*)::int as n from goals.one_offs where user_id = ${owner.id} and name = ${name}`;
  return row.n;
}

// A version 2 draft of one goal that carries a task, so a replay that writes twice shows in two tables.
function draftOf(name: string) {
  return {
    version: 2 as const,
    goals: [
      {
        key: "g1",
        parent: null,
        name,
        horizon: shiftDay(today, 200),
        measure: null,
        rhythm: null,
        note: null,
        noteSrc: [],
        src: [],
        phases: [],
        months: [],
        commitments: [],
        rules: [],
        tasks: [
          {
            name: `${name} tarea`,
            month: today.slice(0, 7),
            estimate: null,
            note: null,
            noteSrc: [],
            src: [],
            week: null,
            rule: null,
            children: [],
          },
        ],
      },
    ],
  };
}

const confirm = (name: string, requestId?: string) =>
  as(() =>
    importActions.confirmImport({ draft: draftOf(name), updates: [], ...(requestId !== undefined && { requestId }) }),
  );

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  oneOffs = await import("@/app/actions/one-offs");
  importActions = await import("@/app/actions/import");
  chat = await import("@/app/actions/chat");
  today = (await import("@/lib/zone")).todayInZone();
  const runId = await openCheckRun(admin);
  [owner] = await createPeople(admin, runId, door.sql, 1);
});

after(async () => {
  try {
    if (owner) {
      await admin`delete from goals.write_receipts where user_id = ${owner.id}`;
      await admin`delete from goals.facts where user_id = ${owner.id}`;
      await admin`delete from goals.one_offs where user_id = ${owner.id} and parent_id is not null`;
      await admin`delete from goals.one_offs where user_id = ${owner.id}`;
      await admin`delete from goals.commitments where user_id = ${owner.id}`;
      await admin`update goals.goals set parent_id = null where user_id = ${owner.id}`;
      await admin`delete from goals.goals where user_id = ${owner.id}`;
    }
    await dropPeople(admin);
  } finally {
    await door.sql.end();
    await admin.end();
  }
});

test("createOneOff with a requestId sent twice writes one task and answers it both times", async () => {
  const name = `M8 una vez ${RUN}`;
  const requestId = randomUUID();
  const first = await as(() => oneOffs.createOneOff({ name, day: today, requestId } as never));
  const second = await as(() => oneOffs.createOneOff({ name, day: today, requestId } as never));
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(await oneOffsNamed(name), 1);
});

test("createOneOff without a requestId, twice, writes two tasks as before", async () => {
  const name = `M8 sin id ${RUN}`;
  const first = await as(() => oneOffs.createOneOff({ name, day: today }));
  const second = await as(() => oneOffs.createOneOff({ name, day: today }));
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.ok(first.ok && second.ok && first.oneOffId !== second.oneOffId);
  assert.equal(await oneOffsNamed(name), 2);
});

test("an import resent after a lost answer creates its goals once and answers the same goalIds", async () => {
  const name = `M8 importado ${RUN}`;
  const requestId = randomUUID();
  const first = await confirm(name, requestId);
  const second = await confirm(name, requestId);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.ok(first.ok && first.goalIds.length === 1);
  assert.deepEqual(second, first);
  assert.equal(await goalsNamed(name), 1);
  assert.equal(await oneOffsNamed(`${name} tarea`), 1);
});

test("an import resent while the first is still committing creates its goals once, and both answer the same goalIds", async () => {
  const name = `M8 importado a la vez ${RUN}`;
  const requestId = randomUUID();
  const raced = await interleave(door, admin, () => confirm(name, requestId), () => confirm(name, requestId));
  assert.equal(raced.first.error, undefined, `the first threw: ${String(raced.first.error)}`);
  assert.equal(raced.second.error, undefined, `the second threw: ${String(raced.second.error)}`);
  assert.equal(raced.first.value?.ok, true, JSON.stringify(raced.first.value));
  assert.deepEqual(raced.second.value, raced.first.value);
  assert.equal(await goalsNamed(name), 1);
  assert.equal(await oneOffsNamed(`${name} tarea`), 1);
});

test("the chat's «Hacer» on create_goal resent with its requestId makes one goal, and both answer ok", async () => {
  const name = `M8 meta del chat ${RUN}`;
  const requestId = randomUUID();
  const change = { tool: "create_goal", input: { name, horizon: shiftDay(today, 200) }, requestId };
  const first = await as(() => chat.makeChatChange(change));
  const second = await as(() => chat.makeChatChange(change));
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  assert.equal(await goalsNamed(name), 1);
});

test("the chat's «Hacer» on create_task resent with its requestId makes one task, and both answer ok", async () => {
  const name = `M8 tarea del chat ${RUN}`;
  const requestId = randomUUID();
  const change = { tool: "create_task", input: { name, day: today }, requestId };
  const first = await as(() => chat.makeChatChange(change));
  const second = await as(() => chat.makeChatChange(change));
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(second, { ok: true });
  assert.equal(await oneOffsNamed(name), 1);
});

test("the chat's «Hacer» without a requestId still makes the change", async () => {
  const name = `M8 tarea del chat sin id ${RUN}`;
  const outcome = await as(() => chat.makeChatChange({ tool: "create_task", input: { name, day: today } }));
  assert.deepEqual(outcome, { ok: true });
  assert.equal(await oneOffsNamed(name), 1);
});
