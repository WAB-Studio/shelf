import assert from "node:assert/strict";
import test, { before, beforeEach, mock } from "node:test";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// RL-69: the list is read with no session, through `db` (it bypasses RLS; the table has no policy).
// `@/db/client` is replaced by a stand-in for `reading.allowed_emails` that answers the statement it is
// handed: a row comes back when the bound address equals a listed one, after the `lower`/`trim` the
// statement itself applies, if any. The stored column is lowercase and trimmed by its CHECK (1010).
const LISTED = new Set(["ana@x.co"]);
const dialect = new PgDialect();
const statements: { sql: string; params: unknown[] }[] = [];

// A row whose every column reads `value`: the act may name its column anything, `exists`, `allowed`, `?column?`.
const rowOf = (value: unknown) => new Proxy({}, { get: (_, key) => (typeof key === "string" ? value : undefined) });

function answer(query: SQL) {
  const { sql, params } = dialect.sqlToQuery(query);
  statements.push({ sql, params });
  assert.match(sql, /"?reading"?\."?allowed_emails/, "the statement reads reading.allowed_emails");
  const lowers = /lower\s*\(/i.test(sql);
  const trims = /trim\s*\(/i.test(sql);
  const listed = params.some((param) => {
    if (typeof param !== "string") return false;
    let value = param;
    if (trims) value = value.trim();
    if (lowers) value = value.toLowerCase();
    return LISTED.has(value);
  });
  if (/exists\s*\(/i.test(sql)) return [rowOf(listed)];
  if (/count\s*\(/i.test(sql)) return [rowOf(listed ? 1 : 0)];
  return listed ? [rowOf(true)] : [];
}

mock.module("@/db/client", {
  namedExports: {
    db: {
      execute: async (query: SQL) => answer(query),
    },
  },
});

let isEmailAllowed: typeof import("./allowlist").isEmailAllowed;

before(async () => {
  ({ isEmailAllowed } = await import("./allowlist"));
});

beforeEach(() => {
  statements.length = 0;
});

test("an address on the list is allowed, in one statement", async () => {
  assert.equal(await isEmailAllowed("ana@x.co"), true);
  assert.equal(statements.length, 1);
});

test("an address not on the list is refused, in one statement", async () => {
  assert.equal(await isEmailAllowed("bob@x.co"), false);
  assert.equal(statements.length, 1);
});

test("the listed address in other case and with spaces around it is allowed", async () => {
  assert.equal(await isEmailAllowed(" Ana@X.co "), true);
  assert.equal(await isEmailAllowed("ANA@X.CO"), true);
  assert.equal(statements.length, 2);
});
