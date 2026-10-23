import assert from "node:assert/strict";
import test from "node:test";

import { assertSuiteDatabase } from "./registry";

// `openRun` caches its run id per module instance; a fresh instance per call keeps one
// test from deciding another's outcome.
let instance = 0;
async function freshRegistry(): Promise<typeof import("./registry")> {
  instance += 1;
  return (await import(`./registry.ts?instance=${instance}`)) as typeof import("./registry");
}

const REMOTE = "postgresql://postgres.abc:s3cret@aws-0-us.pooler.supabase.com:6543/postgres";
const LOCAL = "postgresql://postgres:postgres@127.0.0.1:44322/postgres";

function withEnv(value: string | undefined, fn: () => void | Promise<void>) {
  const before = process.env.HARNESS_DATABASE;
  if (value === undefined) delete process.env.HARNESS_DATABASE;
  else process.env.HARNESS_DATABASE = value;
  const restore = () => {
    if (before === undefined) delete process.env.HARNESS_DATABASE;
    else process.env.HARNESS_DATABASE = before;
  };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore);
    restore();
    return out;
  } catch (error) {
    restore();
    throw error;
  }
}

test("a local host passes", () =>
  withEnv(undefined, () => {
    assertSuiteDatabase(LOCAL);
    assertSuiteDatabase("postgresql://u:p@localhost:5432/db");
  }));

test("a remote host throws naming only the host", () =>
  withEnv(undefined, () => {
    assert.throws(
      () => assertSuiteDatabase(REMOTE),
      (error: Error) =>
        error.message.includes("aws-0-us.pooler.supabase.com") &&
        !error.message.includes("s3cret") &&
        error.message.includes("HARNESS_DATABASE=remote"),
    );
  }));

test("a missing or unparsable URL throws without echoing it", () =>
  withEnv(undefined, () => {
    assert.throws(() => assertSuiteDatabase(""), /not the local stack/);
    assert.throws(
      () => assertSuiteDatabase("not a url s3cret"),
      (error: Error) => !error.message.includes("s3cret"),
    );
  }));

test("HARNESS_DATABASE=remote lets a remote host through", () =>
  withEnv("remote", () => assertSuiteDatabase(REMOTE)));

test("openRun refuses before issuing any statement", () =>
  withEnv(undefined, async () => {
    const before = process.env.MIGRATION_DATABASE_URL;
    process.env.MIGRATION_DATABASE_URL = REMOTE;
    let queries = 0;
    const sql = (() => {
      queries++;
      return Promise.resolve([]);
    }) as never;
    try {
      const { openRun } = await freshRegistry();
      await assert.rejects(openRun("queries", sql), /not the local stack/);
      assert.equal(queries, 0);
    } finally {
      if (before === undefined) delete process.env.MIGRATION_DATABASE_URL;
      else process.env.MIGRATION_DATABASE_URL = before;
    }
  }));

test("openRun with HARNESS_DATABASE=remote reaches the insert", () =>
  withEnv("remote", async () => {
    const before = process.env.MIGRATION_DATABASE_URL;
    process.env.MIGRATION_DATABASE_URL = REMOTE;
    let queries = 0;
    const sql = Object.assign(
      () => {
        queries++;
        return Promise.resolve([]);
      },
      {},
    ) as never;
    try {
      const { openRun } = await freshRegistry();
      await openRun("queries", sql);
      assert.equal(queries, 1);
    } finally {
      if (before === undefined) delete process.env.MIGRATION_DATABASE_URL;
      else process.env.MIGRATION_DATABASE_URL = before;
    }
  }));

// Refused by the guard, not by the missing run: a fresh instance has no run id, so
// `runId()` would throw a different message if the guard were gone.
test("registerEphemeralIdentity refuses a remote host before issuing any statement", () =>
  withEnv(undefined, async () => {
    const before = process.env.MIGRATION_DATABASE_URL;
    process.env.MIGRATION_DATABASE_URL = REMOTE;
    let queries = 0;
    const sql = (() => {
      queries++;
      return Promise.resolve([]);
    }) as never;
    try {
      const { registerEphemeralIdentity } = await freshRegistry();
      await assert.rejects(
        registerEphemeralIdentity(sql, { id: "u", email: "e" }),
        /not the local stack/,
      );
      assert.equal(queries, 0);
    } finally {
      if (before === undefined) delete process.env.MIGRATION_DATABASE_URL;
      else process.env.MIGRATION_DATABASE_URL = before;
    }
  }));

test("registerSharedIdentity refuses a remote host before issuing any statement", () =>
  withEnv(undefined, async () => {
    const before = process.env.MIGRATION_DATABASE_URL;
    process.env.MIGRATION_DATABASE_URL = REMOTE;
    let queries = 0;
    const sql = (() => {
      queries++;
      return Promise.resolve([]);
    }) as never;
    try {
      const { registerSharedIdentity } = await freshRegistry();
      await assert.rejects(
        registerSharedIdentity(sql, { id: "u", email: "e" }),
        /not the local stack/,
      );
      assert.equal(queries, 0);
    } finally {
      if (before === undefined) delete process.env.MIGRATION_DATABASE_URL;
      else process.env.MIGRATION_DATABASE_URL = before;
    }
  }));

// A tagged-template stand-in that records each statement's text and bound values.
function recordingSql(rows: unknown[] = []) {
  const statements: { text: string; values: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    statements.push({ text: strings.join("?"), values });
    return Promise.resolve(rows);
  }) as never;
  return { sql, statements };
}

function withLocalUrl(fn: () => Promise<void>) {
  const before = process.env.MIGRATION_DATABASE_URL;
  process.env.MIGRATION_DATABASE_URL = LOCAL;
  return fn().finally(() => {
    if (before === undefined) delete process.env.MIGRATION_DATABASE_URL;
    else process.env.MIGRATION_DATABASE_URL = before;
  });
}

test("registerOAuthClient writes one row stamped with the run openRun opened", () =>
  withEnv(undefined, () =>
    withLocalUrl(async () => {
      const { openRun, registerOAuthClient } = await freshRegistry();
      const { sql, statements } = recordingSql();
      const run = await openRun("e2e", sql);
      statements.length = 0;

      await registerOAuthClient(sql, "client-1");

      assert.equal(statements.length, 1);
      assert.match(statements[0].text, /insert into harness\.oauth_clients \(client_id, run_id\)/);
      assert.deepEqual(statements[0].values, ["client-1", run]);
    })));

test("registerOAuthClient stamps the run a parent exported when this process opened none", () =>
  withEnv(undefined, () =>
    withLocalUrl(async () => {
      const before = process.env.HARNESS_RUN_ID;
      process.env.HARNESS_RUN_ID = "run-from-parent";
      try {
        const { registerOAuthClient } = await freshRegistry();
        const { sql, statements } = recordingSql();

        await registerOAuthClient(sql, "client-2");

        assert.deepEqual(statements[0].values, ["client-2", "run-from-parent"]);
      } finally {
        if (before === undefined) delete process.env.HARNESS_RUN_ID;
        else process.env.HARNESS_RUN_ID = before;
      }
    })));

test("runId throws when no run was opened and none was exported", () =>
  withEnv(undefined, async () => {
    const before = process.env.HARNESS_RUN_ID;
    delete process.env.HARNESS_RUN_ID;
    try {
      const { runId } = await freshRegistry();
      assert.throws(() => runId(), /openRun has not run/);
    } finally {
      if (before !== undefined) process.env.HARNESS_RUN_ID = before;
    }
  }));

test("registerOAuthClient refuses a remote host before issuing any statement", () =>
  withEnv(undefined, async () => {
    const before = process.env.MIGRATION_DATABASE_URL;
    process.env.MIGRATION_DATABASE_URL = REMOTE;
    const { sql, statements } = recordingSql();
    try {
      const { registerOAuthClient } = await freshRegistry();
      await assert.rejects(registerOAuthClient(sql, "client-1"), /not the local stack/);
      assert.equal(statements.length, 0);
    } finally {
      if (before === undefined) delete process.env.MIGRATION_DATABASE_URL;
      else process.env.MIGRATION_DATABASE_URL = before;
    }
  }));

test("registeredOAuthClients reads this run's clients alone", () =>
  withEnv(undefined, () =>
    withLocalUrl(async () => {
      const { openRun, registeredOAuthClients } = await freshRegistry();
      const { sql, statements } = recordingSql([{ client_id: "client-1" }, { client_id: "client-2" }]);
      const run = await openRun("e2e", sql);
      statements.length = 0;

      assert.deepEqual(await registeredOAuthClients(sql), ["client-1", "client-2"]);
      assert.equal(statements.length, 1);
      assert.match(statements[0].text, /from harness\.oauth_clients where run_id = \?/);
      assert.deepEqual(statements[0].values, [run]);
    })));
