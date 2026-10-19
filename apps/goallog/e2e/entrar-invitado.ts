import { randomUUID } from "node:crypto";

import { registerEphemeralIdentity } from "@repo/harness-registry";
import type postgres from "postgres";

// An invitation is two rows: the list entry and the Auth user. GoalLog's sign-in is closed to
// sign-up (`shouldCreateUser: false`), so the user is minted here, through the registry, before any
// send; the send creates no row of its own and every row it signs in is registered under the run.
export async function invite(db: postgres.Sql, email: string): Promise<string> {
  const id = randomUUID();
  const lower = email.toLowerCase();
  await db`insert into goals.allowed_emails (email) values (${lower}) on conflict do nothing`;
  await registerEphemeralIdentity(db, { id, email: lower });
  return id;
}
