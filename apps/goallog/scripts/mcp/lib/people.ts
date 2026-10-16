// What every `scripts/mcp/*.ts` check shares: a registered run, two people
// made without asking Auth for anything, a key for each, and the teardown.
// The identity rows are composed as `scripts/harness/mint-session.ts` does it.
import { randomUUID } from "node:crypto";
import Module from "node:module";

import { closeRun, openRun, registeredIdentities } from "@repo/harness-registry";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/db/schema";
import { withSettledTransaction } from "@/lib/settled-transaction";
import type { Transaction } from "@/lib/session";

export type Person = { id: string; email: string; key: string; keyId: string; hint: string };

// `server-only` throws outside Next. Call before the first `@/db/client` import.
export function stubServerOnly(): void {
  const untyped = Module as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  };
  const originalLoad = untyped._load;
  untyped._load = (request, parent, isMain) =>
    request === "server-only" ? {} : originalLoad(request, parent, isMain);
}

export function adminSql(): postgres.Sql {
  return postgres(process.env.MIGRATION_DATABASE_URL!, { prepare: false, max: 1 });
}

export async function openCheckRun(admin: postgres.Sql): Promise<string> {
  return openRun("queries", admin);
}

async function createIdentity(admin: postgres.Sql, runId: string): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `harness-pulsar-mcp-${id}@example.invalid`;

  await admin.begin(async (tx) => {
    await tx`
      insert into auth.users (
        id, instance_id, aud, role, email, email_confirmed_at,
        encrypted_password, confirmation_token, recovery_token,
        email_change, email_change_token_current, email_change_token_new,
        email_change_confirm_status, phone_change, phone_change_token,
        reauthentication_token, raw_app_meta_data, raw_user_meta_data,
        is_sso_user, is_anonymous, created_at, updated_at)
      values (
        ${id}, '00000000-0000-0000-0000-000000000000', 'authenticated',
        'authenticated', ${email}, now(),
        '', '', '',
        '', '', '',
        0, '', '',
        '', '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
        false, false, now(), now())`;
    await tx`
      insert into harness.identities (user_id, run_id, email, disposition)
      values (${id}, ${runId}, ${email}, 'ephemeral')`;
  });

  return { id, email };
}

// Issues under the person's own settled transaction, as the screen will.
export async function issueKeyFor(
  connection: postgres.Sql,
  person: { id: string },
  name: string,
): Promise<{ id: string; key: string; hint: string }> {
  // Dynamic: it reaches `@/db/client`, which needs `stubServerOnly` first.
  const { issueKey } = await import("@/lib/mcp/tokens");
  const orm = drizzle(connection, { schema, casing: "snake_case" });

  return withSettledTransaction<Transaction, { id: string; key: string; hint: string }>(
    { claims: { sub: person.id, role: "authenticated" } },
    "check:mcp",
    "goals, public",
    (fn) => orm.transaction(fn as never) as never,
    (tx, statement) => tx.execute(statement),
    (tx) => issueKey(tx, person.id, name),
  );
}

export async function createPeople(
  admin: postgres.Sql,
  runId: string,
  connection: postgres.Sql,
  count: number,
): Promise<Person[]> {
  const people: Person[] = [];
  for (let n = 0; n < count; n += 1) {
    const identity = await createIdentity(admin, runId);
    const issued = await issueKeyFor(connection, identity, `check ${n}`);
    people.push({ ...identity, key: issued.key, keyId: issued.id, hint: issued.hint });
  }

  return people;
}

// Each identity in its own `try`; the run closes only when none leaked.
export async function dropPeople(admin: postgres.Sql): Promise<void> {
  const failed: string[] = [];
  const dropped: string[] = [];
  for (const id of await registeredIdentities(admin, "ephemeral")) {
    try {
      // `goals.access_tokens` rows cascade from `auth.users`.
      await admin`delete from auth.users where id = ${id}`;
      dropped.push(id);
    } catch (error) {
      console.error(`check:mcp: identity ${id} did not drop — ${error instanceof Error ? error.message : String(error)}`);
      failed.push(id);
    }
  }
  if (dropped.length > 0) {
    await admin`delete from harness.identities where user_id in ${admin(dropped)}`;
  }
  if (failed.length === 0) await closeRun(admin);
}
