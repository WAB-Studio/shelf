// Drives `claimModelCall` and `settleModelCall` (`lib/import/spend.ts`,
// RNP-13) under two persons: the lane's own pair of identities, read off
// `auth.users`, so no row is minted here. `@repo/supabase-auth`'s
// `verifiedClaims` is stubbed to answer whichever person the test names;
// everything past it (the settle, the role, the policies) is the real thing.
// The pooler reads rows back and deletes every call the file created.
import assert from "node:assert/strict";
import Module from "node:module";
import { after, before, beforeEach, test } from "node:test";

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
const suffix = lane === 1 ? "" : `-${lane}`;

type Person = { id: string; email: string };
let current: Person;

function installStubs(): void {
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/headers") {
      return { cookies: async () => ({ getAll: () => [], set() {} }) };
    }
    if (request === "@repo/supabase-auth") {
      const real = originalLoad(request, parent, isMain) as Record<string, unknown>;
      return {
        ...real,
        verifiedClaims: async () => ({
          claims: { sub: current.id, email: current.email, role: "authenticated" },
          user: current,
        }),
      };
    }
    return originalLoad(request, parent, isMain);
  };
}

const sql = postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });

let first: Person;
let second: Person;
let today: string;
let claimModelCall: typeof import("@/lib/import/spend").claimModelCall;
let claimFollowUp: typeof import("@/lib/import/spend").claimFollowUp;
let settleModelCall: typeof import("@/lib/import/spend").settleModelCall;
let cap: number;
let chatCap: number;
const claimed: string[] = [];

async function person(email: string): Promise<Person> {
  const [row] = await sql<{ id: string }[]>`select id from auth.users where email = ${email}`;
  if (!row) throw new Error(`no ${email} in auth.users — run harness:token for lane ${lane}`);
  return { id: row.id, email };
}

before(async () => {
  installStubs();
  ({ claimModelCall, claimFollowUp, settleModelCall } = await import("@/lib/import/spend"));
  ({ MODEL_CALLS_DAILY_CAP: cap, CHAT_CALLS_DAILY_CAP: chatCap } = await import("@/lib/import/spend"));
  const { todayInZone } = await import("@/lib/zone");
  today = todayInZone();
  first = await person(`harness-member${suffix}@example.invalid`);
  second = await person(`harness${suffix}@example.invalid`);
  // Clear anything an earlier aborted run left for today.
  await sql`delete from goals.model_calls where user_id in ${sql([first.id, second.id])} and model like 'RNP-13 fixture%'`;
  const [{ count }] = await sql<{ count: string }[]>`
    select count(*) from goals.model_calls where user_id in ${sql([first.id, second.id])} and day = ${today}`;
  if (Number(count) !== 0) throw new Error(`the lane's identities already hold ${count} calls today`);
});

after(async () => {
  if (claimed.length > 0) await sql`delete from goals.model_calls where id in ${sql(claimed)}`;
  await sql.end();
});

// Every test starts from zero calls for both persons and ends owning only the
// rows it claimed, so none depends on what an earlier one left.
beforeEach(async () => {
  await sql`delete from goals.model_calls where user_id in ${sql([first.id, second.id])} and model like 'RNP-13 fixture%'`;
  claimed.length = 0;
});

async function claim(who: Person, source: "paste" | "file" | "chat" = "paste"): Promise<{ id: string } | null> {
  current = who;
  const call = await claimModelCall("RNP-13 fixture", source);
  if (call) claimed.push(call.id);
  return call;
}

test("claimModelCall: the cap is 10; ten claims land and the eleventh answers null", async () => {
  assert.equal(cap, 10);
  for (let i = 0; i < 10; i++) assert.ok(await claim(first), `claim ${i + 1} landed`);
  assert.equal(await claim(first), null);
});

test("claimModelCall: a second person still claims after the first hit the cap", async () => {
  for (let i = 0; i < 10; i++) await claim(first);
  assert.equal(await claim(first), null);
  assert.ok(await claim(second, "file"));
});

test("claimModelCall: a call dated yesterday does not count against today's cap (RNP-13, per day)", async () => {
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yesterdayDay = yesterday.toISOString().slice(0, 10);
  // `day` is not insertable by the app's role; the pooler plants the past.
  const planted = await sql<{ id: string }[]>`
    insert into goals.model_calls (user_id, model, source, day)
    select ${first.id}, 'RNP-13 fixture', 'paste', ${yesterdayDay}::date from generate_series(1, 10)
    returning id`;
  claimed.push(...planted.map((row) => row.id));
  assert.equal(planted.length, 10);

  const todays = await claim(first);
  assert.ok(todays, "ten calls from yesterday leave today's cap untouched");
  const [row] = await sql<{ day: string }[]>`select day::text as day from goals.model_calls where id = ${todays.id}`;
  assert.equal(row.day, today);
  // And today's own count still stops at the cap: nine more land, the next does not.
  for (let i = 0; i < 9; i++) assert.ok(await claim(first), `today's claim ${i + 2} landed`);
  assert.equal(await claim(first), null);
});

test("claimModelCall: rows read back under their owner, the zone's day, source and no outcome", async () => {
  for (let i = 0; i < 10; i++) await claim(first);
  await claim(second, "file");
  const rows = await sql<{ userId: string; day: string; source: string; outcome: string | null }[]>`
    select user_id as "userId", day::text as day, source, outcome
    from goals.model_calls where id in ${sql(claimed)}`;
  assert.equal(rows.length, 11);
  assert.equal(rows.filter((r) => r.userId === first.id).length, 10);
  assert.equal(rows.filter((r) => r.userId === second.id).length, 1);
  for (const row of rows) {
    assert.equal(row.day, today);
    assert.equal(row.outcome, null);
  }
  assert.equal(rows.find((r) => r.userId === second.id)?.source, "file");
});

test("settleModelCall: writes the tokens and the outcome on the person's own row", async () => {
  const call = await claim(first);
  assert.ok(call);
  assert.equal(await settleModelCall(call.id, { inputTokens: 120, outputTokens: 45, outcome: "ok" }), true);
  const [row] = await sql<{ i: number; o: number; outcome: string }[]>`
    select input_tokens as i, output_tokens as o, outcome from goals.model_calls where id = ${call.id}`;
  assert.deepEqual(row, { i: 120, o: 45, outcome: "ok" });
});

test("settleModelCall: another person's settle of that row touches 0 rows", async () => {
  const call = await claim(first);
  assert.ok(call);
  assert.equal(await settleModelCall(call.id, { inputTokens: 120, outputTokens: 45, outcome: "ok" }), true);
  current = second;
  assert.equal(await settleModelCall(call.id, { inputTokens: 1, outputTokens: 2, outcome: "failed" }), false);
  const [row] = await sql<{ i: number; o: number; outcome: string }[]>`
    select input_tokens as i, output_tokens as o, outcome from goals.model_calls where id = ${call.id}`;
  assert.deepEqual(row, { i: 120, o: 45, outcome: "ok" });
});

// RNP-21: the import and the chat each count their own kind under their own cap.
async function plantToday(who: Person, source: string, n: number): Promise<void> {
  const planted = await sql<{ id: string }[]>`
    insert into goals.model_calls (user_id, model, source)
    select ${who.id}, 'RNP-13 fixture', ${source} from generate_series(1, ${n}) returning id`;
  claimed.push(...planted.map((row) => row.id));
}

test("claimModelCall chat: the cap is 50; fifty chat claims land and the fifty-first answers null", async () => {
  assert.equal(chatCap, 50);
  for (let i = 0; i < 50; i++) assert.ok(await claim(first, "chat"), `chat claim ${i + 1} landed`);
  assert.equal(await claim(first, "chat"), null);
  assert.ok(await claim(first, "paste"), "the import still claims");
});

test("claimModelCall: ten import claims land, the eleventh is null, the chat still claims", async () => {
  for (let i = 0; i < 10; i++) assert.ok(await claim(first, "paste"));
  assert.equal(await claim(first, "paste"), null);
  assert.ok(await claim(first, "chat"));
});

test("claimModelCall: fifty chat rows today leave the import's cap untouched", async () => {
  await plantToday(first, "chat", 50);
  assert.ok(await claim(first, "paste"));
});

test("claimModelCall: a file claim counts as import (nine paste and one file stop the next paste)", async () => {
  await plantToday(first, "paste", 9);
  await plantToday(first, "file", 1);
  assert.equal(await claim(first, "paste"), null);
});

test("claimModelCall chat: a chat row dated yesterday does not count", async () => {
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const planted = await sql<{ id: string }[]>`
    insert into goals.model_calls (user_id, model, source, day)
    select ${first.id}, 'RNP-13 fixture', 'chat', ${yesterday.toISOString().slice(0, 10)}::date from generate_series(1, 50)
    returning id`;
  claimed.push(...planted.map((row) => row.id));
  assert.ok(await claim(first, "chat"));
});

test("claimModelCall chat: the row keeps its model and source, no outcome until settled", async () => {
  current = first;
  const call = await claimModelCall("gpt-5-mini", "chat");
  assert.ok(call);
  try {
    const [row] = await sql<{ model: string; source: string; outcome: string | null }[]>`
      select model, source, outcome from goals.model_calls where id = ${call.id}`;
    assert.deepEqual(row, { model: "gpt-5-mini", source: "chat", outcome: null });
  } finally {
    await sql`delete from goals.model_calls where id = ${call.id}`;
  }
});

// 903c: the second pass is claimed and settled like the read, and the read's cap never counts it.
async function followUp(who: Person, source: "paste" | "file" = "paste"): Promise<{ id: string } | null> {
  current = who;
  const call = await claimFollowUp("RNP-13 fixture", source);
  if (call) claimed.push(call.id);
  return call;
}

test("903c: a follow-up claim lands even with the day's reads spent, and is a row of its own with the read's source", async () => {
  for (let i = 0; i < 10; i++) await claim(first, "file");
  assert.equal(await claim(first, "file"), null);
  const call = await followUp(first, "file");
  assert.ok(call);
  const [row] = await sql<{ model: string; source: string; outcome: string | null; day: string }[]>`
    select model, source, outcome, day::text as day from goals.model_calls where id = ${call.id}`;
  assert.deepEqual(row, { model: "RNP-13 fixture/arrange", source: "file", outcome: null, day: today });
});

test("903c: follow-ups never take a read from the cap: nine reads and any number of follow-ups leave the tenth", async () => {
  for (let i = 0; i < 9; i++) await claim(first);
  for (let i = 0; i < 5; i++) assert.ok(await followUp(first));
  assert.ok(await claim(first), "the tenth read still lands");
  assert.equal(await claim(first), null);
});

test("903c: a follow-up settles its tokens and outcome like a read, and only for its owner", async () => {
  const call = await followUp(first);
  assert.ok(call);
  assert.equal(await settleModelCall(call.id, { inputTokens: 900, outputTokens: 120, outcome: "ok" }), true);
  const [row] = await sql<{ i: number; o: number; outcome: string }[]>`
    select input_tokens as i, output_tokens as o, outcome from goals.model_calls where id = ${call.id}`;
  assert.deepEqual(row, { i: 900, o: 120, outcome: "ok" });
  current = second;
  assert.equal(await settleModelCall(call.id, { inputTokens: 1, outputTokens: 1, outcome: "failed" }), false);
});

test("903c: the chat cap does not count a follow-up either", async () => {
  await plantToday(first, "chat", 49);
  await followUp(first);
  assert.ok(await claim(first, "chat"), "the fiftieth chat claim lands");
});

// Concurrent claims of one person and kind: the cap holds for a script, not only a double tap.
test("claimModelCall: cap + 5 concurrent import claims land exactly the cap", async () => {
  current = first;
  const results = await Promise.all(Array.from({ length: cap + 5 }, () => claimModelCall("RNP-13 fixture", "paste")));
  for (const call of results) if (call) claimed.push(call.id);
  assert.equal(results.filter(Boolean).length, cap);
});

test("claimModelCall: cap + 5 concurrent chat claims land exactly the chat cap", async () => {
  current = first;
  const results = await Promise.all(Array.from({ length: chatCap + 5 }, () => claimModelCall("RNP-13 fixture", "chat")));
  for (const call of results) if (call) claimed.push(call.id);
  assert.equal(results.filter(Boolean).length, chatCap);
});
