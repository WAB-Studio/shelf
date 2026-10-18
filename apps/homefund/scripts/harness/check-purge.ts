/**
 * M21: `purgeIdentity` removes a fund leader together with what the fund's own accounts
 * and scope hold — debt terms, installment plans, statements, budgets, planned payments,
 * recurring rules, movements — without a RESTRICT stopping the group's cascade, and takes
 * nothing that belongs to anyone else.
 *
 * Run: HARNESS_LANE=<n> scripts/supabase-local.sh exec env TSX_TSCONFIG_PATH=scripts/harness/tsconfig.json \
 *   node --import tsx --env-file=.env.local scripts/harness/check-purge.ts
 *
 * Every row is seeded under identities this process registers as ephemeral and is removed
 * by its exact id; no pattern, no window, no other lane's row.
 */
import { randomUUID } from "node:crypto";

import type { TransactionSql } from "postgres";

import { assert, report } from "./assert";
import {
  cleanup,
  createMembershipFreeUser,
  fixtureSql,
  purgeIdentity,
  setSuite,
  type HarnessUser,
} from "./fixtures";

type Tx = TransactionSql;

type Fund = {
  groupId: string;
  cashId: string;
  cardId: string;
  categoryId: string;
  leader: HarnessUser;
};

const GROUP_TABLES = [
  "debt_terms",
  "installment_plans",
  "account_statements",
  "budgets",
  "planned_payments",
  "recurring_rules",
  "transactions",
] as const;
type GroupTable = (typeof GROUP_TABLES)[number];
type Counts = Record<GroupTable, number>;

const funds: Fund[] = [];

// An expense carries its split in the same transaction: the sum is checked at commit.
async function spend(
  tx: Tx,
  accountId: string,
  categoryId: string,
  amountCents: number,
  description: string,
): Promise<void> {
  const [row] = await tx<{ id: string }[]>`
    insert into transactions (from_account_id, amount_cents, occurred_at, description)
    values (${accountId}, ${amountCents}, current_date, ${description})
    returning id`;
  await tx`
    insert into transaction_splits (transaction_id, category_id, amount_cents)
    values (${row.id}, ${categoryId}, ${amountCents})`;
}

async function asActor<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const claims = JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated" });
  return (await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    return fn(tx);
  })) as T;
}

// A fund with one row of each kind the group scope can hold, all on its own accounts.
async function seedFund(leader: HarnessUser, member?: HarnessUser): Promise<Fund> {
  const fund: Fund = {
    groupId: randomUUID(),
    cashId: randomUUID(),
    cardId: randomUUID(),
    categoryId: randomUUID(),
    leader,
  };
  const memberRow = randomUUID();

  await asActor(leader.id, async (tx) => {
    await tx`insert into groups (id, name, cash_mode) values (${fund.groupId}, ${`Purge fund l${process.env.HARNESS_LANE ?? ""}`}, 'per_member')`;
    await tx`
      insert into group_members (id, group_id, user_id, name, role)
      values (${randomUUID()}, ${fund.groupId}, ${leader.id}, 'Purge leader', 'leader')`;
    if (member) {
      await tx`
        insert into group_members (id, group_id, user_id, name, role)
        values (${memberRow}, ${fund.groupId}, ${member.id}, 'Purge member', 'member')`;
    }
    await tx`
      insert into accounts (id, group_id, is_shared, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values
        (${fund.cashId}, ${fund.groupId}, true, 'Purge group cash', 'asset', 'cash', 100000, current_date),
        (${fund.cardId}, ${fund.groupId}, true, 'Purge group card', 'liability', 'card', -50000, current_date)`;
    await tx`
      insert into categories (id, group_id, name, kind, color)
      values (${fund.categoryId}, ${fund.groupId}, 'Purge group food', 'expense', '#4C8C4A')`;
    await tx`
      insert into debt_terms (account_id, debt_kind, annual_rate)
      values (${fund.cardId}, 'revolving', 0.25)`;
    await tx`
      insert into installment_plans (account_id, principal_cents, n_installments, frequency, start_date)
      values (${fund.cardId}, 120000, 6, 'monthly', current_date)`;
    await tx`
      insert into account_statements (account_id, period_start, cut_off_date, closing_balance_cents)
      values (${fund.cardId}, current_date - 30, current_date, -50000)`;
    await tx`
      insert into budgets (group_id, category_id, account_id, period, limit_cents, threshold_pct)
      values (${fund.groupId}, ${fund.categoryId}, ${fund.cardId}, 'monthly', 80000, 80)`;
    await tx`
      insert into planned_payments (group_id, from_account_id, to_account_id, amount_cents, due_date, created_by)
      values (${fund.groupId}, ${fund.cashId}, ${fund.cardId}, 10000, current_date + 5, ${leader.id})`;
    await tx`
      insert into recurring_rules (group_id, from_account_id, amount_cents, category_id, frequency, interval_n, day_of_month, next_run_on, created_by)
      values (${fund.groupId}, ${fund.cashId}, 5000, ${fund.categoryId}, 'monthly', 1, 5, current_date + 5, ${leader.id})`;
    await spend(tx, fund.cashId, fund.categoryId, 7000, "purge leader spends");
  });

  if (member) {
    await asActor(member.id, async (tx) => {
      await spend(tx, fund.cardId, fund.categoryId, 3000, "purge member spends");
    });
  }

  funds.push(fund);
  return fund;
}

async function countFund(fund: Fund): Promise<Counts> {
  const [row] = await fixtureSql<Record<GroupTable, string>[]>`
    select
      (select count(*) from debt_terms where account_id in (${fund.cashId}, ${fund.cardId}))::text as debt_terms,
      (select count(*) from installment_plans where account_id in (${fund.cashId}, ${fund.cardId}))::text as installment_plans,
      (select count(*) from account_statements where account_id in (${fund.cashId}, ${fund.cardId}))::text as account_statements,
      (select count(*) from budgets where group_id = ${fund.groupId})::text as budgets,
      (select count(*) from planned_payments where group_id = ${fund.groupId})::text as planned_payments,
      (select count(*) from recurring_rules where group_id = ${fund.groupId})::text as recurring_rules,
      (select count(*) from transactions where group_id = ${fund.groupId})::text as transactions`;
  return Object.fromEntries(GROUP_TABLES.map((t) => [t, Number(row[t])])) as Counts;
}

async function seedPersonalBook(user: HarnessUser): Promise<{ accountId: string }> {
  const accountId = randomUUID();
  const categoryId = randomUUID();
  await asActor(user.id, async (tx) => {
    await tx`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${categoryId}, ${user.id}, 'Purge personal food', 'expense', '#4C8C4A')`;
    await tx`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${accountId}, ${user.id}, 'Purge personal bank', 'asset', 'bank', 90000, current_date)`;
    await spend(tx, accountId, categoryId, 1500, "purge personal spend");
  });
  return { accountId };
}

async function personalCounts(accountId: string): Promise<{ accounts: number; movements: number }> {
  const [row] = await fixtureSql<{ a: string; m: string }[]>`
    select (select count(*) from accounts where id = ${accountId})::text as a,
           (select count(*) from transactions where from_account_id = ${accountId})::text as m`;
  return { accounts: Number(row.a), movements: Number(row.m) };
}

async function userExists(id: string): Promise<boolean> {
  const [row] = await fixtureSql<{ n: string }[]>`select count(*)::text as n from auth.users where id = ${id}`;
  return Number(row.n) === 1;
}

async function attempt(userId: string): Promise<string | null> {
  try {
    await purgeIdentity(userId);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Removes every fund this process seeded, by exact id, so the registry's own purge
// finds nothing that blocks it whether or not the code under test did its job.
async function teardown(): Promise<void> {
  for (const fund of funds) {
    await asActor(fund.leader.id, async (tx) => {
      await tx`delete from transactions where group_id = ${fund.groupId}`;
      await tx`delete from planned_payments where group_id = ${fund.groupId}`;
      await tx`delete from recurring_rules where group_id = ${fund.groupId}`;
      await tx`delete from budgets where group_id = ${fund.groupId}`;
      await tx`delete from installment_plans where account_id in (${fund.cashId}, ${fund.cardId})`;
      await tx`delete from account_statements where account_id in (${fund.cashId}, ${fund.cardId})`;
      await tx`delete from debt_terms where account_id in (${fund.cashId}, ${fund.cardId})`;
      await tx`delete from groups where id = ${fund.groupId}`;
    });
  }
}

async function main(): Promise<void> {
  setSuite("queries");

  const leader = await createMembershipFreeUser();
  const member = await createMembershipFreeUser();
  const other = await createMembershipFreeUser();
  const leader2 = await createMembershipFreeUser();

  try {
    const fundA = await seedFund(leader, member);
    const fundB = await seedFund(other);
    const memberBook = await seedPersonalBook(member);
    const otherBook = await seedPersonalBook(other);

    const seededA = await countFund(fundA);
    const seededB = await countFund(fundB);
    assert(
      "P0 seed",
      GROUP_TABLES.every((t) => seededA[t] >= 1 && seededB[t] >= 1) && seededA.transactions === 2,
      `fund A ${JSON.stringify(seededA)}, fund B ${JSON.stringify(seededB)}`,
    );

    const failure = await attempt(leader.id);

    assert("P1 leader purged: purgeIdentity resolves", failure === null, failure ?? "resolved");
    assert(
      "P1 leader purged: no auth.users row",
      !(await userExists(leader.id)),
      (await userExists(leader.id)) ? "auth row remains" : "gone",
    );

    const afterA = await countFund(fundA);
    const [groupRow] = await fixtureSql<{ n: string }[]>`
      select count(*)::text as n from groups where id = ${fundA.groupId}`;
    assert(
      "P2 group rows gone",
      GROUP_TABLES.every((t) => afterA[t] === 0) && Number(groupRow.n) === 0,
      `fund A after ${JSON.stringify(afterA)}, group rows ${groupRow.n}`,
    );

    const afterB = await countFund(fundB);
    assert(
      "P3 bystander fund kept",
      GROUP_TABLES.every((t) => afterB[t] === seededB[t]) &&
        (await userExists(other.id)) &&
        JSON.stringify(await personalCounts(otherBook.accountId)) === JSON.stringify({ accounts: 1, movements: 1 }),
      `fund B after ${JSON.stringify(afterB)}`,
    );

    const memberAfter = await personalCounts(memberBook.accountId);
    assert(
      "P4 member's own book kept",
      memberAfter.accounts === 1 && memberAfter.movements === 1 && (await userExists(member.id)),
      `member personal ${JSON.stringify(memberAfter)}`,
    );

    // One transaction: a row the purge cannot take (a movement in another fund that this
    // identity created, RESTRICT on created_by) fails the delete at its last step, after the
    // group's deletes; every row it deleted before must come back.
    const fundA2 = await seedFund(leader2);
    const seededA2 = await countFund(fundA2);
    await asActor(leader2.id, async (tx) => {
      await spend(tx, fundB.cashId, fundB.categoryId, 100, "purge blocker");
    });
    await fixtureSql`
      update transactions set created_by = ${leader2.id}
      where group_id = ${fundB.groupId} and description = 'purge blocker'`;
    const failure2 = await attempt(leader2.id);
    const afterA2 = await countFund(fundA2);
    assert(
      "P5 one transaction",
      failure2 !== null &&
        GROUP_TABLES.every((t) => afterA2[t] === seededA2[t]) &&
        (await userExists(leader2.id)),
      `purge ${failure2 === null ? "resolved (the blocker did not block)" : "rejected"}, fund A2 ${JSON.stringify(afterA2)} of ${JSON.stringify(seededA2)}`,
    );
  } finally {
    await teardown();
    await cleanup();
    await fixtureSql.end();
  }

  report();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
