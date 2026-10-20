// M16 (RNP-05): `withSettledTransaction` sends the claims inside the SQL
// text, as a string literal drizzle quotes (`drizzle-orm/pg-core/
// dialect.js:79`), rather than as a bind parameter. This file proves the
// literal holds: claims carrying every character that ends or escapes a
// literal settle to the same `request.jwt.claims` the parameterized settle
// gives, and none of their text runs as SQL.
//
// A canary is what running as SQL would leave behind: a payload that breaks
// out of the literal sets `app.m16_canary` on the session. The literal is the
// only barrier: with no parameter, postgres.js sends the settle as a simple
// query (`postgres/src/index.js:123`), which runs every command it carries.
// The proof runs under `standard_conforming_strings` on (every Postgres since
// 9.1, and this stack) and off, where `\` escapes inside a plain literal.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { settleSessionSql } from "@repo/supabase-auth/settle";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { withSettledTransaction } from "@/lib/settled-transaction";

type Call = { query: string; parameters: unknown[] };
const wire: Call[] = [];

const door = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  max: 1,
  debug: (_connection: number, query: string, parameters: unknown[]) => void wire.push({ query, parameters }),
});
const orm = drizzle(door);
type Tx = Parameters<Parameters<typeof orm.transaction>[0]>[0];

after(() => door.end());

const breakOut = "', true), set_config('app.m16_canary', 'ran', false), set_config('app.m16_rest', '";
const hostile: Record<string, unknown> = {
  sub: randomUUID(),
  role: "authenticated",
  aud: "authenticated",
  quote: "'",
  quotes: "''''",
  backslash: "\\",
  backslashQuote: "\\'",
  trailingBackslash: "ends in \\",
  dollars: "$$ select set_config('app.m16_canary', 'ran', false) $$",
  tagged: "$m16$ ran $m16$",
  placeholder: "$1 $2",
  semicolon: "; select set_config('app.m16_canary', 'ran', false); --",
  breakOut,
  escapeString: "E'\\x27' || chr(39)",
  comment: "/* */ -- ",
  unicode: "ñandú 東京 🙂 ‮    ",
  loneSurrogate: "\ud800",
  control: "\b\f\n\r\t\u0001\u001f",
  user_metadata: { "it's": ["'", "\\", { "$$": ";" }], [breakOut]: breakOut },
};

type Seen = { claims: string | null; who: string; canary: string | null; sub: string | null };

// Off, the claims may no longer parse as JSON, so `sub` is read as text.
const read = async (tx: Tx): Promise<Seen> => {
  const [row] = (await tx.execute(sql`
    select current_setting('request.jwt.claims', true) as claims,
           current_user::text as who,
           nullif(current_setting('app.m16_canary', true), '') as canary,
           substring(current_setting('request.jwt.claims', true) from '"sub":"([0-9a-f-]{36})"') as sub`)) as unknown as Seen[];
  return row;
};

const conforming = (on: boolean) => sql.raw(`set local standard_conforming_strings = ${on ? "on" : "off"}`);

// The app's settle: `withSettledTransaction`, inlined.
function inlined(claims: Record<string, unknown>, on: boolean): Promise<Seen> {
  return withSettledTransaction<Tx, Seen>(
    { claims },
    "settle-inline",
    "goals, public",
    (cb) =>
      orm.transaction(async (tx) => {
        await tx.execute(conforming(on));
        return cb(tx);
      }),
    (tx, statement) => tx.execute(statement),
    read,
  );
}

// The same statement with its values bound, as the settle ran before M16.
function parameterized(claims: Record<string, unknown>, on: boolean): Promise<Seen> {
  return orm.transaction(async (tx) => {
    await tx.execute(conforming(on));
    await tx.execute(settleSessionSql({ claims: JSON.stringify(claims), searchPath: "goals, public" }));
    return read(tx);
  });
}

test("inlined claims: the settle carries no bind parameter and its claims ride as hex", async () => {
  wire.length = 0;
  await inlined(hostile, true);
  const settles = wire.filter((call) => call.query.includes("set_config('request.jwt.claims'"));
  assert.equal(settles.length, 1);
  assert.deepEqual(settles[0].parameters, []);
  const hex = Buffer.from(JSON.stringify(hostile), "utf8").toString("hex");
  assert.ok(
    settles[0].query.includes(`set_config('request.jwt.claims', convert_from(decode('${hex}', 'hex'), 'UTF8'), true)`),
    settles[0].query,
  );
});

test("inlined claims, standard_conforming_strings on: the same request.jwt.claims as bound, and nothing ran", async () => {
  const [mine, bound] = [await inlined(hostile, true), await parameterized(hostile, true)];
  assert.equal(mine.claims, JSON.stringify(hostile), "the settled text is the claims' JSON, byte for byte");
  assert.deepEqual(mine, bound);
  assert.deepEqual(JSON.parse(mine.claims!), JSON.parse(JSON.stringify(hostile)));
  assert.equal(mine.who, "authenticated");
  assert.equal(mine.sub, hostile.sub);
  assert.equal(mine.canary, null, "a claim ran as SQL");
});

function pgCode(error: unknown): string | undefined {
  for (let cursor: unknown = error; cursor; cursor = (cursor as { cause?: unknown }).cause) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

// One claim alone, so a literal that ended early would leave valid SQL behind
// it and the canary would be set rather than the statement refused.
test("a claim built to close the literal stays a value: the canary is never set", async () => {
  const claims = { sub: hostile.sub, role: "authenticated", breakOut };
  const mine = await inlined(claims, true);
  assert.equal(mine.claims, JSON.stringify(claims));
  assert.equal(mine.who, "authenticated");
  assert.equal(mine.canary, null, "a claim ran as SQL");
});

// Off, `\"` and `\n` lose their backslash, so the text may differ from the
// JSON; what must hold is that no payload left the literal.
test("inlined claims, standard_conforming_strings off: a backslash never ends the literal", async () => {
  const plain = Object.fromEntries(Object.entries(hostile).filter(([key]) => key !== "control" && key !== "loneSurrogate"));
  const mine = await inlined(plain, false);
  assert.equal(mine.who, "authenticated");
  assert.equal(mine.canary, null, "a claim ran as SQL");
  assert.equal(mine.sub, hostile.sub);
});

test("inlined claims, standard_conforming_strings off: a lone surrogate fails closed in the lexer, never past the literal", async () => {
  const outcome = await inlined(hostile, false).then(
    (seen) => ({ ok: true as const, seen }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  if (outcome.ok) {
    assert.equal(outcome.seen.who, "authenticated");
    assert.equal(outcome.seen.canary, null, "a claim ran as SQL");
    return;
  }
  // The lexer refuses a lone surrogate's `\ud800` while it reads the literal,
  // before any of the statement runs; a literal that ended early would fail
  // on the text after it instead, as a plain syntax error.
  const message = String((outcome.error as { cause?: unknown }).cause ?? outcome.error);
  console.log(`off, full claims: rejected with ${pgCode(outcome.error)}: ${message.split("\n")[0]}`);
  assert.match(message, /invalid Unicode surrogate pair/);
});

// `fn` starts before the settle answers, so a settle that fails can leave
// `fn` still running. A statement `fn` sends after the transaction rolled back
// would run on the bare connection, as `postgres` and past RLS; it must meet
// the aborted transaction instead. The pause stands for any await `fn` makes
// between two statements.
test("a settle that fails: a statement fn sends later never runs outside the transaction", async () => {
  let late: unknown;
  let finished: Promise<void> = Promise.resolve();
  const body = async (tx: Tx) => {
    await tx.execute(sql`select 1`).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    late = await tx
      .execute(sql`select current_user::text as who, set_config('app.m16_late', 'ran', false) as late`)
      .catch((error: unknown) => pgCode(error));
  };
  const outcome = await withSettledTransaction<Tx, void>(
    { claims: { sub: randomUUID(), role: "authenticated" } },
    "settle-inline",
    '"goals',
    (cb) => orm.transaction(cb),
    (tx, statement) => tx.execute(statement),
    (tx) => (finished = body(tx)),
  ).then(
    () => "resolved",
    (error: unknown) => pgCode(error),
  );
  await finished;
  assert.equal(outcome, "22023", "the call rejects with the settle's error");
  const [seen] = (await orm.execute(sql`select nullif(current_setting('app.m16_late', true), '') as late`)) as unknown as {
    late: string | null;
  }[];
  assert.equal(seen.late, null, `fn's later statement ran on the bare connection: ${JSON.stringify(late)}`);
  assert.equal(late, "25P02", "fn's later statement met the aborted transaction");
});

// M25 (RNP-05): the claims' meaning, not just the literal, must not depend on
// `standard_conforming_strings`. What a policy sees is `auth.uid()` and
// `auth.jwt()`, so those are what these tests read, in the caller's own role.
type Who = { uid: string | null; jwt: Record<string, unknown> | null; role: string };

const readAuth = async (tx: Tx): Promise<Who> => {
  const [row] = (await tx.execute(sql`
    select auth.uid()::text as uid, auth.jwt() as jwt, current_user::text as role`)) as unknown as Who[];
  return row;
};

function settledAs(claims: Record<string, unknown>, on: boolean): Promise<Who> {
  return withSettledTransaction<Tx, Who>(
    { claims },
    "settle-inline",
    "goals, public",
    (cb) =>
      orm.transaction(async (tx) => {
        await tx.execute(conforming(on));
        return cb(tx);
      }),
    (tx, statement) => tx.execute(statement),
    readAuth,
  );
}

const caller = randomUUID();
const victim = randomUUID();
const forgedEmail = `x","sub":"${victim}`;

for (const on of [false, true]) {
  test(`M25 standard_conforming_strings ${on ? "on" : "off"}: a claim that imitates a sibling key leaves auth.uid() the caller's`, async () => {
    const seen = await settledAs(
      { sub: caller, role: "authenticated", aud: "authenticated", email: forgedEmail },
      on,
    );
    assert.equal(seen.uid, caller, "auth.uid() followed a forged sub");
    assert.equal(seen.jwt?.email, forgedEmail, "the email is the literal string it was");
    assert.equal(seen.jwt?.sub, caller);
    assert.equal(seen.role, "authenticated");
  });

  test(`M25 standard_conforming_strings ${on ? "on" : "off"}: backslash, quote, $$ and a non-BMP character read back identical`, async () => {
    const values = {
      backslash: "a\\b\\\\c\\",
      quote: "it's ''quoted''",
      dollars: "$$ $x$ $1",
      astral: "🙂 𝔘 \u{1F9D1}‍\u{1F4BB}",
      mixed: "\\'$$\\\"🙂",
      user_metadata: { nested: "\\ ' $$ 🙂", list: ["\\", "'"] },
    };
    const seen = await settledAs({ sub: caller, role: "authenticated", aud: "authenticated", ...values }, on);
    assert.equal(seen.uid, caller);
    for (const [key, value] of Object.entries(values)) assert.deepEqual(seen.jwt?.[key], value, key);
  });
}

// The settle is pipelined: `fn` starts before the settle has answered.
test("M25 the settle and fn's first statement share a round trip: fn starts before the settle answers", async () => {
  let settleAnswered = false;
  let answeredWhenFnStarted: boolean | undefined;
  await withSettledTransaction<Tx, void>(
    { claims: { sub: caller, role: "authenticated" } },
    "settle-inline",
    "goals, public",
    (cb) => orm.transaction(cb),
    (tx, statement) => tx.execute(statement).then((result) => ((settleAnswered = true), result)),
    async (tx) => {
      answeredWhenFnStarted = settleAnswered;
      await tx.execute(sql`select 1`);
    },
  );
  assert.equal(answeredWhenFnStarted, false, "fn waited for the settle");
});

// `fn` may return drizzle's lazy query, which runs again on every `.then`.
test("M25 a lazy query fn returns runs exactly once", async () => {
  let runs = 0;
  await withSettledTransaction<Tx, unknown>(
    { claims: { sub: caller, role: "authenticated" } },
    "settle-inline",
    "goals, public",
    (cb) => orm.transaction(cb),
    (tx, statement) => tx.execute(statement),
    (tx) =>
      ({
        then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
          runs += 1;
          return tx.execute(sql`select 1`).then(resolve, reject);
        },
      }) as unknown as Promise<unknown>,
  );
  assert.equal(runs, 1, "the lazy query ran more than once");
});

// M33 (RNP-05): the settle is the transaction's own. It sets role, search_path
// and statement_timeout with `local`, so the pooled connection the next caller
// borrows is the pool's again; it runs before anything `fn` sends; and with no
// session it refuses by name, before a connection is taken.
type Gucs = { pid: number; role: string; searchPath: string; timeout: string; claims: string | null };

const readGucs = async (tx: Tx): Promise<Gucs> => {
  const [row] = (await tx.execute(sql`
    select pg_backend_pid() as pid,
           current_user::text as role,
           current_setting('search_path') as "searchPath",
           current_setting('statement_timeout') as timeout,
           nullif(current_setting('request.jwt.claims', true), '') as claims`)) as unknown as Gucs[];
  return row;
};

const settleThen = <T>(fn: (tx: Tx) => Promise<T>, searchPath = "goals, public") =>
  withSettledTransaction<Tx, T>(
    { claims: { sub: caller, role: "authenticated", aud: "authenticated" } },
    "settle-inline",
    searchPath,
    (cb) => orm.transaction(cb),
    (tx, statement) => tx.execute(statement),
    fn,
  );

test("M33 inside the settle: role authenticated, the given search_path and an 8 s statement_timeout", async () => {
  const inside = await settleThen(readGucs, "goals, public");
  assert.equal(inside.role, "authenticated");
  assert.equal(inside.searchPath, "goals, public");
  assert.equal(inside.timeout, "8s");
  assert.ok(inside.claims?.includes(caller));
});

test("M33 after the settled transaction commits, the same connection is back to the pool's role, search_path and timeout", async () => {
  const before = await orm.transaction(readGucs);
  assert.notEqual(before.role, "authenticated", "the pool's own role is not the settled one");
  assert.notEqual(before.searchPath, "goals, public");
  assert.notEqual(before.timeout, "8s");

  const inside = await settleThen(readGucs, "goals, public");
  const after = await orm.transaction(readGucs);

  assert.equal(inside.pid, before.pid, "pool max 1: one connection throughout");
  assert.equal(after.pid, before.pid);
  assert.equal(after.role, before.role, "role leaked past commit");
  assert.equal(after.searchPath, before.searchPath, "search_path leaked past commit");
  assert.equal(after.timeout, before.timeout, "statement_timeout leaked past commit");
  assert.equal(after.claims, null, "claims leaked past commit");
});

test("M33 the settle also gives the connection back after a rollback", async () => {
  const before = await orm.transaction(readGucs);
  await settleThen(async (tx) => {
    await readGucs(tx);
    throw new Error("fn failed");
  }).catch(() => undefined);
  const after = await orm.transaction(readGucs);
  assert.deepEqual({ ...after, claims: null }, { ...before, claims: null });
});

test("M33 the settle precedes fn: fn's first statement already sees the settled claims, and the wire carries the settle first", async () => {
  wire.length = 0;
  const seen = await settleThen(async (tx) => {
    const [row] = (await tx.execute(sql`
      select /* m33-fn-first */ auth.uid()::text as uid, current_user::text as role,
             current_setting('statement_timeout') as timeout`)) as unknown as { uid: string | null; role: string; timeout: string }[];
    return row;
  });
  assert.equal(seen.uid, caller, "fn's first statement ran before the settle");
  assert.equal(seen.role, "authenticated");
  assert.equal(seen.timeout, "8s");
  const settle = wire.findIndex((call) => call.query.includes("set_config('request.jwt.claims'"));
  const first = wire.findIndex((call) => call.query.includes("m33-fn-first"));
  assert.ok(settle >= 0 && first >= 0, "both statements reached the wire");
  assert.ok(settle < first, `fn's statement (#${first}) was sent before the settle (#${settle})`);
});

test("M33 no session: the call refuses with its own label, takes no connection and runs nothing", async () => {
  let began = 0;
  let ran = 0;
  const error = await withSettledTransaction<Tx, void>(
    null,
    "settle-inline-label",
    "goals, public",
    async () => void (began += 1),
    async () => void (ran += 1),
    async () => void (ran += 1),
  ).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof Error);
  assert.ok(!(error instanceof TypeError), `a TypeError leaked: ${error.message}`);
  assert.equal(error.message, "settle-inline-label called without a verified session");
  assert.equal(began, 0);
  assert.equal(ran, 0);
});

// Drizzle's own hops can put the settle on the wire first even when `fn` was
// called first, so the order is also read where the module hands over control:
// `run` must be invoked with the settle before `fn` is entered.
test("M33 the settle statement is handed to run before fn is entered", async () => {
  const order: string[] = [];
  await withSettledTransaction<Tx, void>(
    { claims: { sub: caller, role: "authenticated" } },
    "settle-inline",
    "goals, public",
    (cb) => orm.transaction(cb),
    (tx, statement) => {
      order.push("settle");
      return tx.execute(statement);
    },
    async (tx) => {
      order.push("fn");
      await tx.execute(sql`select 1`);
    },
  );
  assert.deepEqual(order, ["settle", "fn"]);
});
