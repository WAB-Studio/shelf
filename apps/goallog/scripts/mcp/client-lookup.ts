// Proves RNP-19 (0015): a registered client reads back by its metadata URL
// without spending a registration slot, an unknown URL reads nothing, and the
// function is closed to the two request roles.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import { assertSuiteDatabase } from "@repo/harness-registry";
import postgres from "postgres";

import { adminSql } from "./lib/people";

assertSuiteDatabase();

const admin = adminSql();
const rollback = Symbol("rollback");

after(() => admin.end());

async function rolledBack(body: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
  await admin
    .begin(async (tx) => {
      await body(tx);
      throw rollback;
    })
    .catch((error: unknown) => {
      if (error !== rollback) throw error;
    });
}

test("a registered client reads back whole and spends no throttle slot", async () => {
  await rolledBack(async (tx) => {
    const url = `https://${randomUUID()}.example.invalid/meta`;
    const [{ id }] = await tx<{ id: string }[]>`
      select goals.oauth_register_client('Asistente', array['https://a.example.invalid/cb'], ${url}) as id`;
    const callsBefore = await tx`select * from goals.oauth_calls`;
    const rows = await tx<{ id: string; client_name: string; redirect_uris: string[] }[]>`
      select * from goals.oauth_client_by_metadata_url(${url})`;
    assert.deepEqual([...rows], [{ id, client_name: "Asistente", redirect_uris: ["https://a.example.invalid/cb"] }]);
    assert.deepEqual(await tx`select * from goals.oauth_calls`, callsBefore, "the lookup touched oauth_calls");
  });
});

test("an unknown URL reads nothing", async () => {
  await rolledBack(async (tx) => {
    const rows = await tx`select * from goals.oauth_client_by_metadata_url(${`https://${randomUUID()}.example.invalid/none`})`;
    assert.equal(rows.length, 0);
  });
});

test("with two clients registered, a lookup returns exactly the one whose URL it names", async () => {
  await rolledBack(async (tx) => {
    const urlA = `https://${randomUUID()}.example.invalid/meta`;
    const urlB = `https://${randomUUID()}.example.invalid/meta`;
    const [{ id: idA }] = await tx<{ id: string }[]>`
      select goals.oauth_register_client('Asistente A', array['https://a.example.invalid/cb'], ${urlA}) as id`;
    const [{ id: idB }] = await tx<{ id: string }[]>`
      select goals.oauth_register_client('Asistente B', array['https://b.example.invalid/cb'], ${urlB}) as id`;
    const rowsA = await tx<{ id: string; client_name: string }[]>`select * from goals.oauth_client_by_metadata_url(${urlA})`;
    assert.deepEqual(rowsA.map((r) => [r.id, r.client_name]), [[idA, "Asistente A"]]);
    const rowsB = await tx<{ id: string; client_name: string }[]>`select * from goals.oauth_client_by_metadata_url(${urlB})`;
    assert.deepEqual(rowsB.map((r) => [r.id, r.client_name]), [[idB, "Asistente B"]]);
  });
});

test("with a client registered, an unknown URL still reads nothing", async () => {
  await rolledBack(async (tx) => {
    await tx`select goals.oauth_register_client('Asistente', array['https://a.example.invalid/cb'], ${`https://${randomUUID()}.example.invalid/meta`})`;
    const rows = await tx`select * from goals.oauth_client_by_metadata_url(${`https://${randomUUID()}.example.invalid/none`})`;
    assert.equal(rows.length, 0);
  });
});

test("authenticated and anon cannot execute it", async () => {
  for (const role of ["authenticated", "anon"]) {
    await rolledBack(async (tx) => {
      await tx`select set_config('role', ${role}, true)`;
      let code: string | undefined;
      await tx.savepoint((sp) => sp`select * from goals.oauth_client_by_metadata_url('https://x.example.invalid/meta')`).catch((error: unknown) => {
        code = (error as { code?: string }).code;
      });
      assert.equal(code, "42501", `${role} executed the lookup`);
    });
  }
});
