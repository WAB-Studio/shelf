// M16 (RNP-03, RNP-05, RNP-02): `withSettledTransaction` sends the session
// settle and `fn`'s first statement together, and the person it settles is
// still who that statement runs as.
//
// The wire here is the socket itself: every pool in this file connects
// through `recordedSocket`, which logs each `write` the driver makes and each
// `data` chunk Postgres answers with, in the order they happen. A round trip
// is one burst of writes the driver then waits on: `begin`, settle, a
// statement, `commit` awaited one by one is four; the settle pipelined with
// the statement is three.
//
// The app's own pool is reached as the pages reach it: `postgres` is answered
// through `Module._load`, so `db/client.ts` builds its real pool with its real
// options, and the factory only adds the recorded socket.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Module from "node:module";
import { connect, type Socket } from "node:net";
import { after, before, test } from "node:test";

import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { adminSql, createPeople, dropPeople, openCheckRun, type Person } from "../mcp/lib/people";
import type { ResolvedPerson } from "@/lib/mcp/tokens";

type WireEvent = { kind: "write"; text: string } | { kind: "reply" };

const events: WireEvent[] = [];
let appPoolOptions: Record<string, unknown> | undefined;

const url = new URL(process.env.DATABASE_URL!);
if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
  throw new Error("settle-pipeline: run under scripts/supabase-local.sh exec (the recorded socket speaks plain TCP)");
}

async function recordedSocket(): Promise<Socket> {
  const socket = connect(Number(url.port || 5432), url.hostname);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  // Attached before the driver's own listener, so a reply is logged before it is handled.
  socket.on("data", () => void events.push({ kind: "reply" }));
  const write = socket.write.bind(socket) as (...args: unknown[]) => boolean;
  (socket as unknown as { write: (...args: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    events.push({ kind: "write", text: Buffer.from(chunk as Uint8Array).toString("latin1") });
    return write(chunk, ...rest);
  };
  return socket;
}

function installStubs(): void {
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) => {
    if (request === "server-only") return {};
    if (request === "next/headers") return { cookies: async () => ({ getAll: () => [], set() {} }) };
    if (request === "next/cache") return { revalidatePath() {} };
    if (request === "postgres") {
      const real = originalLoad(request, parent, isMain) as typeof postgres;
      const factory = (target: string, options: Record<string, unknown> = {}) => {
        appPoolOptions ??= options;
        return real(target, { ...options, socket: recordedSocket } as Record<string, unknown>);
      };
      return Object.assign(factory, real, { default: factory });
    }
    return originalLoad(request, parent, isMain);
  };
}

// A pool of this file's own, for the calls that hand `withSettledTransaction`
// a search path no door of the app would.
// `socket` is a driver option its types leave out (`postgres/src/connection.js` `createSocket`).
const own = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1, socket: recordedSocket } as postgres.Options<Record<string, never>>);
const ownOrm = drizzle(own);
const admin = adminSql();

let session: typeof import("@/lib/session");
let settled: typeof import("@/lib/settled-transaction");
let me: Person;
let other: Person;
let myGoal: string;
let otherGoal: string;

const asResolved = (person: Person): ResolvedPerson => ({ id: person.id, email: person.email }) as ResolvedPerson;
const claimsOf = (person: Person) => ({ sub: person.id, email: person.email, role: "authenticated", aud: "authenticated" });

async function plantGoal(owner: string, name: string): Promise<string> {
  const horizon = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const [row] = await admin<{ id: string }[]>`
    insert into goals.goals (user_id, name, horizon, position)
    values (${owner}, ${name}, ${horizon}, 990) returning id`;
  return row.id;
}

before(async () => {
  installStubs();
  session = await import("@/lib/session");
  settled = await import("@/lib/settled-transaction");
  const runId = await openCheckRun(admin);
  [me, other] = await createPeople(admin, runId, own, 2);
  myGoal = await plantGoal(me.id, `settle-pipeline mine ${randomUUID()}`);
  otherGoal = await plantGoal(other.id, `settle-pipeline theirs ${randomUUID()}`);
});

after(async () => {
  try {
    await dropPeople(admin);
  } finally {
    await own.end();
    await admin.end();
  }
});

const isSettle = (text: string) => text.includes("set_config('request.jwt.claims'");
const isBegin = (text: string) => /\bbegin\b/i.test(text) && !isSettle(text);
const isCommit = (text: string) => /\bcommit\b/i.test(text);

type Trace = { settleAt: number; statementAt: number; repliesBetween: number; roundTrips: number };

// Reads one transaction off `events`: where the settle and the statement
// carrying `marker` were written, how many replies came in between, and how
// many write bursts the transaction waited on from `begin` to `commit`.
function trace(slice: WireEvent[], marker: string): Trace {
  const settleAt = slice.findIndex((event) => event.kind === "write" && isSettle(event.text));
  const statementAt = slice.findIndex((event) => event.kind === "write" && event.text.includes(marker));
  assert.ok(settleAt >= 0, "the settle never reached the wire");
  assert.ok(statementAt >= 0, "fn's first statement never reached the wire");
  let beginAt = -1;
  for (let n = Math.min(settleAt, statementAt); n >= 0; n -= 1) {
    const event = slice[n];
    if (event.kind === "write" && isBegin(event.text)) {
      beginAt = n;
      break;
    }
  }
  assert.ok(beginAt >= 0, "no begin before the settle");
  const commitAt = slice.findIndex((event, n) => n > statementAt && event.kind === "write" && isCommit(event.text));
  assert.ok(commitAt >= 0, "no commit after the statement");
  const [low, high] = [Math.min(settleAt, statementAt), Math.max(settleAt, statementAt)];
  const repliesBetween = slice.slice(low, high).filter((event) => event.kind === "reply").length;
  let roundTrips = 0;
  let inBurst = false;
  for (const event of slice.slice(beginAt, commitAt + 1)) {
    if (event.kind === "write" && !inBurst) {
      roundTrips += 1;
      inBurst = true;
    } else if (event.kind === "reply") {
      inBurst = false;
    }
  }
  return { settleAt, statementAt, repliesBetween, roundTrips };
}

type Seen = { who: string; mine: number; theirs: number };

// A uuid this file made or read back, inlined: a statement with no parameter
// is written whole in one message, so the marker lands in the same write as
// its text. With a parameter, `prepare: false` makes postgres.js describe the
// statement first and wait for that answer before it binds the values.
const literal = (uuid: string) => {
  assert.match(uuid, /^[0-9a-z-]+$/);
  return drizzleSql.raw(`'${uuid}'`);
};

// One statement as `fn`'s first: who it runs as, and whether it can see the
// other person's goal. Under the right settle it reads `authenticated`, 1, 0.
async function firstStatementAs(person: Person, marker: string): Promise<{ seen: Seen; slice: WireEvent[] }> {
  const read = () =>
    session.actAs(asResolved(person), () =>
      session.withGoalsDb(async (tx) => {
        const rows = (await tx.execute(drizzleSql`
          select current_user::text as who,
                 (select count(*) from goals.goals where id = ${literal(myGoal)})::int as mine,
                 (select count(*) from goals.goals where id = ${literal(otherGoal)})::int as theirs,
                 ${literal(marker)}::text as marker`)) as unknown as Seen[];
        const { who, mine, theirs } = rows[0];
        return { who, mine, theirs };
      }),
    );
  await read(); // warms the connection: its handshake and type fetch stay out of the slice
  const from = events.length;
  const seen = await read();
  return { seen, slice: events.slice(from) };
}

test("one trip less: the settle and fn's first statement are both written before Postgres answers either", async () => {
  const marker = `m16-pipeline-${randomUUID()}`;
  const { slice } = await firstStatementAs(me, marker);
  const { repliesBetween, roundTrips } = trace(slice, marker);
  console.log(`one trip less: ${repliesBetween} replies between settle and statement, ${roundTrips} round trips`);
  assert.equal(repliesBetween, 0, "a reply came in between the settle and the first statement: the settle was awaited alone");
  assert.equal(roundTrips, 3, "begin, settle with the statement, commit");
});

test("order: the settle reaches the wire before fn's first statement", async () => {
  const marker = `m16-order-${randomUUID()}`;
  const { slice } = await firstStatementAs(me, marker);
  const { settleAt, statementAt } = trace(slice, marker);
  // Pipelined, both ride one buffered write: then the bytes decide.
  const settleWrite = slice[settleAt] as { text: string };
  const first =
    settleAt === statementAt
      ? settleWrite.text.indexOf("set_config('request.jwt.claims'") < settleWrite.text.indexOf(marker)
      : settleAt < statementAt;
  assert.ok(first, `settle written at ${settleAt}, statement at ${statementAt}`);
});

test("role held: fn's first statement runs as authenticated and reads only the settled person's goal", async () => {
  const { seen } = await firstStatementAs(me, `m16-role-${randomUUID()}`);
  assert.deepEqual(seen, { who: "authenticated", mine: 1, theirs: 0 });
  const { seen: theirs } = await firstStatementAs(other, `m16-role-${randomUUID()}`);
  assert.deepEqual(theirs, { who: "authenticated", mine: 0, theirs: 1 });
});

// `JSON.stringify` escapes whatever a claim carries, so no claim alone makes
// `set_config` refuse; a search path whose quote never closes does, inside the
// settle itself (22023). The settle is the statement that fails.
const BROKEN_SEARCH_PATH = '"goals';

function pgCode(error: unknown): string | undefined {
  for (let cursor: unknown = error; cursor; cursor = (cursor as { cause?: unknown }).cause) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

function settleAs<T>(person: Person, fn: (tx: Parameters<Parameters<typeof ownOrm.transaction>[0]>[0]) => Promise<T>) {
  return settled.withSettledTransaction(
    { claims: claimsOf(person) },
    "settle-pipeline",
    BROKEN_SEARCH_PATH,
    (cb) => ownOrm.transaction(cb),
    (tx, statement) => tx.execute(statement),
    fn,
  );
}

test("settle failure: the call rejects with the settle's own error and fn is served no row", async () => {
  let served: unknown[] | undefined;
  const outcome = await settleAs(other, async (tx) => {
    served = (await tx.execute(drizzleSql`select id from goals.goals where id = ${otherGoal}`)) as unknown as unknown[];
    return served;
  }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  assert.equal(outcome.ok, false, "a call whose settle failed resolved");
  if (outcome.ok) return;
  assert.equal(pgCode(outcome.error), "22023", `rejected with ${pgCode(outcome.error)}, not the settle's 22023: ${String(outcome.error)}`);
  assert.match(String((outcome.error as { cause?: unknown }).cause ?? outcome.error), /search_path/);
  assert.equal(served, undefined, "fn's first statement answered rows after the settle failed");
});

test("settle failure: fn's first statement never commits", async () => {
  const name = `settle-pipeline never ${randomUUID()}`;
  const outcome = await settleAs(me, async (tx) =>
    tx.execute(drizzleSql`
      insert into goals.goals (user_id, name, horizon, position)
      values (${me.id}, ${name}, null, 991) returning id`),
  ).then(
    () => "resolved",
    (error: unknown) => pgCode(error),
  );
  assert.equal(outcome, "22023");
  const [{ count }] = await admin<{ count: number }[]>`select count(*)::int as count from goals.goals where name = ${name}`;
  assert.equal(count, 0);
});

test("warm pool: the app's pool keeps an idle connection for 240 seconds", async () => {
  await firstStatementAs(me, `m16-pool-${randomUUID()}`);
  assert.ok(appPoolOptions, "db/client.ts never built its pool through postgres()");
  assert.equal(appPoolOptions.idle_timeout, 240);
});
