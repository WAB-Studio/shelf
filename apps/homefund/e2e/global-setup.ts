/**
 * Layer 3's ground: the browser's login, the rows the specs read, and the
 * teardown that drops them. Playwright calls the default export once, before any
 * spec, and calls the function it returns once after the last one.
 *
 * The login uses no mailbox and sends nothing. The storage state a spec starts
 * from carries the session cookie `@supabase/ssr` would have written, over an
 * access token the project itself signed — so the proxy, `requireUser()` and
 * every policy see a real `auth.uid()`, and the auth server is never asked to
 * deliver a link to an address that bounces into someone's inbox. Two identities
 * get one state each: the one every spec runs as, and the one RF-100 needs a
 * second role for.
 *
 * Every row here belongs to one of those two users, which nothing else writes,
 * so the purge below is a reset rather than a deletion of someone's data. It runs
 * at both ends: a crashed run leaves the next one a clean queue.
 *
 * The two users are the ones `HARNESS_LANE` selects, and every id below comes
 * from them, so a run on one lane never names a row another lane owns.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { test as base } from "@playwright/test";
import { closeRun, openRun } from "@repo/harness-registry";
import type { TransactionSql } from "postgres";

import { TIME_ZONE } from "@/lib/locales";

import { fixtureSql } from "../scripts/harness/fixtures";
import {
  HARNESS_BASE_URL,
  HARNESS_EMAIL,
  HARNESS_LANE_SUFFIX,
  HARNESS_MEMBER_EMAIL,
  harnessSession,
  sessionCookies,
} from "../scripts/harness/session";

export const STORAGE_STATE = `private/harness-storage${HARNESS_LANE_SUFFIX}.json`;

// The second identity's cookies. A spec that reads the roster as a plain member
// names this state; every other spec keeps the first identity's.
export const MEMBER_STORAGE_STATE = `private/harness-member-storage${HARNESS_LANE_SUFFIX}.json`;

const SCOPE_FILE = resolve(
  process.cwd(),
  `private/harness-e2e${HARNESS_LANE_SUFFIX}.json`,
);

export type E2eScope = {
  userId: string;
  memberUserId: string;
  accountId: string;
  accountName: string;
  categoryId: string;
  categoryName: string;
};

/**
 * The specs' entry point instead of `@playwright/test`'s own: every one of them
 * reads the database back, and the pool has to be closed or the worker outlives
 * its tests.
 */
export const test = base.extend<object, { harnessDatabase: void }>({
  harnessDatabase: [
    // The empty pattern is required: Playwright reads the destructuring to learn
    // which fixtures this one depends on, and it depends on none.
    async ({}, use) => {
      await use();
      await fixtureSql.end();
    },
    { scope: "worker", auto: true },
  ],
});

export function readScope(): E2eScope {
  return JSON.parse(readFileSync(SCOPE_FILE, "utf8")) as E2eScope;
}

// The claims the stamping triggers read: a fixture writes as the owner role but
// speaks for the harness user, so `auth.uid()` resolves inside every trigger.
function claimsFor(userId: string): string {
  return JSON.stringify({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
  });
}

/**
 * Runs `fn` in one transaction that speaks for the harness user, which is what
 * the stamping triggers read, while the owner's privileges do the writing. A
 * spec seeds its own rows through this and drops them itself; nothing here is
 * tracked, so a spec that leaks a row leaks it until the teardown purge.
 */
export async function asHarnessUser(
  fn: (tx: TransactionSql) => Promise<void>,
): Promise<void> {
  await asUser(readScope().userId, fn);
}

/**
 * The same, for a caller that holds the id rather than the scope file: `purge`
 * runs before that file is written. Every write inside leaves the trail a row
 * naming this actor, which is the column `purgeAuditTrail` reads them back by —
 * a delete run without claims stamps an actor nothing can name again.
 */
async function asUser(
  userId: string,
  fn: (tx: TransactionSql) => Promise<void>,
): Promise<void> {
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claimsFor(userId)}, true)`;
    await fn(tx);
  });
}

export type SeedDelivery = {
  merchant: string | null;
  amountCents: number | null;
  accountId: string | null;
  categoryId: string | null;
  categorySource: "merchant" | "interpreter" | "credential_default" | null;
  // Writes the merchant memory as already trusted, which is what makes a card
  // complete enough to accept in one tap (RF-94).
  trusted?: boolean;
  text?: string;
};

/**
 * Replaces the queue with exactly these deliveries, so a test states the state it
 * runs against instead of inheriting the previous test's.
 */
export async function seedQueue(rows: SeedDelivery[]): Promise<string[]> {
  const { userId } = readScope();

  await clearQueue();

  const ids: string[] = [];

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claimsFor(userId)}, true)`;

    for (const row of rows) {
      const text =
        row.text ?? `Bancolombia: Compraste en ${row.merchant ?? "un comercio"}`;
      const merchantKey = row.merchant?.toUpperCase() ?? null;

      // The memory goes first: the queue joins a delivery to it by merchant key.
      if (row.trusted && merchantKey && row.categoryId) {
        await tx`
          insert into ingest_merchants (
            owner_user_id, merchant_key, merchant_label, state, trusted_category_id, streak)
          values (${userId}, ${merchantKey}, ${row.merchant}, 'trusted', ${row.categoryId}, 2)`;
      }

      const [delivery] = await tx<{ id: string }[]>`
        insert into ingest_deliveries (
          external_ref, raw_text, shape_hash, merchant_key, merchant_label,
          proposed_amount_cents, proposed_account_id, proposed_category_id,
          category_source, proposed_direction, proposed_occurred_at, proposed_description)
        values (
          ${randomUUID()},
          ${text},
          ${createHash("sha256").update(text).digest("hex")},
          ${merchantKey},
          ${row.merchant},
          ${row.amountCents},
          ${row.accountId},
          ${row.categoryId},
          ${row.categorySource},
          'expense',
          (now() at time zone ${TIME_ZONE})::date,
          ${row.merchant})
        returning id`;

      ids.push(delivery.id);
    }
  });

  return ids;
}

export async function clearQueue(): Promise<void> {
  const { userId } = readScope();

  await asUser(userId, async (tx) => {
    await tx`delete from ingest_deliveries where owner_user_id = ${userId}`;
    await tx`delete from ingest_shapes where owner_user_id = ${userId}`;
    await tx`delete from ingest_merchants where owner_user_id = ${userId}`;
  });
}

// The roster the members specs read: the harness user leads, the second identity
// belongs. Names sort in this order, which is the order `listMembers` renders, so
// a spec can name a row by its position without reading the DOM around it.
export const LEADER_MEMBER_NAME = "Harness lider";
export const PLAIN_MEMBER_NAME = "Harness miembro";

/**
 * One group with both roles on its roster, replacing whatever a crashed run left
 * behind. Written under the leader's claims so the stamping triggers see them,
 * and in one transaction because `assert_group_keeps_leader` refuses a group that
 * commits without a leader.
 */
export async function seedGroup(): Promise<{ groupId: string }> {
  const scope = readScope();
  const groupId = randomUUID();

  await clearGroup();

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claimsFor(scope.userId)}, true)`;

    await tx`
      insert into groups (id, name, cash_mode)
      values (${groupId}, 'Fondo de la prueba', 'per_member')`;

    await tx`
      insert into group_members (group_id, user_id, name, role)
      values
        (${groupId}, ${scope.userId}, ${LEADER_MEMBER_NAME}, 'leader'),
        (${groupId}, ${scope.memberUserId}, ${PLAIN_MEMBER_NAME}, 'member')`;
  });

  return { groupId };
}

/**
 * Every group either harness identity belongs to, with its roster on the cascade.
 * Runs at both ends of the run and before each seeding: layer 2 asserts the
 * members page 404s for the first identity, so a group left behind here is that
 * layer's failure tomorrow.
 */
export async function clearGroup(): Promise<void> {
  const scope = readScope();
  const users = [scope.userId, scope.memberUserId];

  await asUser(scope.userId, async (tx) => {
    await tx`
      delete from groups
      where id in (
        select group_id from group_members where user_id in ${tx(users)})`;
    await tx`delete from group_members where user_id in ${tx(users)}`;
  });
}

export async function clearLedger(): Promise<void> {
  const { userId } = readScope();

  await asUser(userId, async (tx) => {
    // A delivery points at the movement it recorded, and the queue is what a spec
    // reads next, so it goes first. Splits and labels ride the movement's cascade:
    // deleting a split on its own trips the trigger that keeps an expense carrying
    // one, and that trigger stands down only once the parent is gone.
    await tx`delete from ingest_deliveries where owner_user_id = ${userId}`;
    await tx`delete from transactions where owner_user_id = ${userId}`;
    await tx`delete from recurring_rules where owner_user_id = ${userId}`;
  });
}

/**
 * One generated movement still awaiting review (RF-31), which is what raises the
 * dashboard's other amber badge — the pair is what the overflow test needs.
 */
export async function seedUnreviewedMovement(): Promise<void> {
  const scope = readScope();

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claimsFor(scope.userId)}, true)`;

    const [rule] = await tx<{ id: string }[]>`
      insert into recurring_rules (
        from_account_id, amount_cents, category_id, description,
        frequency, interval_n, day_of_month, next_run_on)
      values (
        ${scope.accountId}, 1500000, ${scope.categoryId}, 'Harness recurrente',
        'monthly', 1, 1, (now() at time zone ${TIME_ZONE})::date)
      returning id`;

    const [movement] = await tx<{ id: string }[]>`
      insert into transactions (
        from_account_id, amount_cents, occurred_at, description, recurring_rule_id)
      values (
        ${scope.accountId}, 1500000, (now() at time zone ${TIME_ZONE})::date,
        'Harness generado', ${rule.id})
      returning id`;

    await tx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      values (${movement.id}, ${scope.categoryId}, 1500000)`;
  });
}

// Everything the harness user owns, child before parent. The specs write through
// the interface, so the rows a run leaves behind are not all tracked by id, and a
// run must end at the row counts it found — `audit_log` apart, which
// `purgeAuditTrail` takes down to the same footing.
async function purge(userId: string): Promise<void> {
  await asUser(userId, async (tx) => {
    await tx`delete from ingest_deliveries where owner_user_id = ${userId}`;
    await tx`delete from ingest_merchants where owner_user_id = ${userId}`;
    await tx`delete from ingest_shapes where owner_user_id = ${userId}`;
    // A contribution is named before its goal even though it cascades: an aporte
    // that outlived its goal would be a leak no later count could explain.
    await tx`
      delete from goal_contributions
      where goal_id in (select id from savings_goals where owner_user_id = ${userId})`;
    await tx`delete from savings_goals where owner_user_id = ${userId}`;
    await tx`delete from budgets where owner_user_id = ${userId}`;
    await tx`delete from planned_payments where owner_user_id = ${userId}`;
    // These three hang off an account rather than off a user. `debt_terms` goes
    // before `accounts` in particular: its row is what makes an account's deletion
    // fail rather than cascade.
    await tx`
      delete from installment_plans
      where account_id in (select id from accounts where owner_user_id = ${userId})`;
    await tx`
      delete from account_statements
      where account_id in (select id from accounts where owner_user_id = ${userId})`;
    await tx`
      delete from debt_terms
      where account_id in (select id from accounts where owner_user_id = ${userId})`;
    // Splits and labels ride the movement's cascade; see `clearLedger`.
    await tx`delete from transactions where owner_user_id = ${userId}`;
    await tx`delete from recurring_rules where owner_user_id = ${userId}`;
    await tx`delete from webhook_credentials where owner_user_id = ${userId}`;
    await tx`delete from labels where owner_user_id = ${userId}`;
    await tx`delete from categories where owner_user_id = ${userId}`;
    await tx`delete from accounts where owner_user_id = ${userId}`;
    // The group goes before its members: `assert_group_keeps_leader` refuses to
    // leave a live group leaderless, and the cascade from a deleted group is the
    // one path that may take a leader row with it.
    await tx`
      delete from groups
      where id in (select group_id from group_members where user_id = ${userId})`;
    await tx`delete from group_members where user_id = ${userId}`;
  });
}

/**
 * The trail rows the two harness identities left behind. RF-44 makes the log
 * append-only and RNF-14's purge its only deleter; this is the exception the
 * user granted, because every row it names was fabricated by a run of this
 * harness — some 945 of them per run, kept for weeks — and the viewer reads its
 * first page by scanning every one of them, which is what put that screen's
 * query over the 8 s `statement_timeout` once a run in two.
 *
 * Bounded to those two ids on the two columns that name a person: a real user's
 * row carries neither, so none is reachable from here. What the harness writes
 * without claims lands with both columns null and is unreachable in turn, which
 * is why every delete above runs under `asUser`.
 */
async function purgeAuditTrail(userIds: string[]): Promise<void> {
  await fixtureSql`
    delete from audit_log
    where actor_user_id in ${fixtureSql(userIds)}
       or owner_user_id in ${fixtureSql(userIds)}`;
}

async function seedScope(userId: string, memberUserId: string): Promise<E2eScope> {
  const scope: E2eScope = {
    userId,
    memberUserId,
    accountId: randomUUID(),
    accountName: "Cuenta de la bandeja",
    categoryId: randomUUID(),
    categoryName: "Mercado de prueba",
  };

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claimsFor(userId)}, true)`;

    await tx`
      insert into accounts (
        id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (
        ${scope.accountId}, ${userId}, ${scope.accountName}, 'asset', 'bancaria',
        5000000, (now() at time zone ${TIME_ZONE})::date)`;

    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${scope.categoryId}, ${userId}, ${scope.categoryName}, 'expense', '#4C8C4A')`;
  });

  return scope;
}

/**
 * One identity's storage state, written from the session layer 2 already drives
 * the app with. The browser never visits a magic link: obtaining one means asking
 * the auth server to SEND it, and these addresses bounce into a real mailbox.
 */
async function signIn(email: string, storageState: string): Promise<void> {
  const cookies = await sessionCookies(email);
  const { hostname } = new URL(HARNESS_BASE_URL);

  const state = {
    cookies: cookies.map(({ name, value }) => ({
      name,
      value,
      domain: hostname,
      path: "/",
      // A session cookie, so nothing survives the browser that read it.
      expires: -1,
      // The browser client reads the same cookie from `document.cookie`.
      httpOnly: false,
      secure: false,
      sameSite: "Lax" as const,
    })),
    origins: [],
  };

  mkdirSync(dirname(storageState), { recursive: true });
  writeFileSync(storageState, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Before either `harnessSession` call, so the heartbeat this starts covers the
  // whole run — both calls register their identity `shared` on the way in.
  await openRun("e2e", fixtureSql);

  const [session, memberSession] = await Promise.all([
    harnessSession(),
    harnessSession(HARNESS_MEMBER_EMAIL),
  ]);
  const userId = session.user.id;
  const memberUserId = memberSession.user.id;

  await purge(userId);
  const scope = await seedScope(userId, memberUserId);
  // `private/` is gitignored, so a fresh clone reaches this write without it.
  mkdirSync(dirname(SCOPE_FILE), { recursive: true });
  writeFileSync(SCOPE_FILE, `${JSON.stringify(scope, null, 2)}\n`, "utf8");
  // After the scope file, which is what `clearGroup` reads both ids from.
  await clearGroup();
  // Last of the writes, so the rows the purge above stamped go down with the
  // ones the previous run left.
  await purgeAuditTrail([userId, memberUserId]);

  await signIn(HARNESS_EMAIL, STORAGE_STATE);
  await signIn(HARNESS_MEMBER_EMAIL, MEMBER_STORAGE_STATE);

  console.log(
    `harness users ${userId} <${session.user.email}> and ${memberUserId} <${memberSession.user.email}> carry their own session cookie`,
  );

  return async () => {
    try {
      await clearGroup();
      await purge(userId);
      await purgeAuditTrail([userId, memberUserId]);
      await closeRun(fixtureSql);
    } finally {
      await fixtureSql.end();
    }
  };
}
