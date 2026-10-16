// Lands the one-time token row the harness consumes to mint a session, which is
// the only way back in once a refresh-token family is revoked. Touches nothing
// but the synthetic harness identities. GoTrue verifies `type=magiclink` against
// `auth.users.recovery_token`, while `newestTokenHash` reads `one_time_tokens`,
// so both have to carry the same hash.
//
// With no argument it covers the whole lane `HARNESS_LANE` names, creating the
// identity when it is missing: that is the one command that bootstraps a new
// lane. With an address it covers that address alone, and refuses one that has
// no user — an unknown address there is a typo, not a lane.
import { randomBytes, randomUUID } from "node:crypto";

import { assertSuiteDatabase } from "@repo/harness-registry";

import { fixtureSql } from "./fixtures";
import {
  ensureHarnessAuthUser,
  HARNESS_EMAIL,
  HARNESS_MEMBER_EMAIL,
} from "./session";

async function land(email: string, create: boolean): Promise<void> {
  const [existing] = await fixtureSql<{ id: string }[]>`
    select id from auth.users where email = ${email}`;
  if (!existing && !create) throw new Error(`no auth.users row for ${email}`);

  const userId = existing?.id ?? (await ensureHarnessAuthUser(email));
  const hash = randomBytes(32).toString("hex");

  await fixtureSql`
    update auth.users
    set recovery_token = ${hash}, recovery_sent_at = now(), updated_at = now()
    where id = ${userId}`;

  await fixtureSql`
    delete from auth.one_time_tokens
    where user_id = ${userId} and token_type = 'recovery_token'`;

  await fixtureSql`
    insert into auth.one_time_tokens
      (id, user_id, token_type, token_hash, relates_to, created_at, updated_at)
    values
      (${randomUUID()}, ${userId}, 'recovery_token', ${hash}, ${email}, now(), now())`;

  console.log(
    `landed a recovery token for ${email} (${userId})${existing ? "" : ", identity created"}`,
  );
}

void (async () => {
  try {
    assertSuiteDatabase();
    const named = process.argv[2];

    if (named) await land(named, false);
    else {
      await land(HARNESS_EMAIL, true);
      await land(HARNESS_MEMBER_EMAIL, true);
    }

    process.exit(0);
  } catch (error) {
    console.error(`FAILED  ${(error as Error).message}`);
    process.exit(1);
  }
})();
