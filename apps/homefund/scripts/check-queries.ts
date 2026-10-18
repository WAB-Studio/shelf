/**
 * Layer 1 of the harness: the app's OWN query functions, driven against the
 * remote database with RLS on. `scripts/check-rls.ts` builds every fixture with
 * raw SQL and proves the policies without ever executing the code a screen runs;
 * this executes exactly that code and asserts on what comes back.
 *
 * No transaction wraps a suite. `withUserDb` opens and commits its own, and
 * running the production control flow rather than a replica of it is the point.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { openRun } from "@repo/harness-registry";
import postgres from "postgres";
import type { z } from "zod";

// FIRST, and it has to stay first: it plants the counted pool `@/db/client` picks
// up, and a client already built is a client that cannot be instrumented.
import { roundTrips } from "./harness/instrument";

import {
  createInstallmentPlanAction,
  recordDebtPaymentAction,
} from "@/app/actions/installment-plans";
import { getAccountBalances } from "@/db/queries/account-balances";
import {
  getReconcileSheet,
  listAccountReconciliations,
  reconcileAccount,
} from "@/db/queries/account-reconciliations";
import {
  getAccountStatementHistory,
  listAccountStatements,
  recordAccountStatement,
} from "@/db/queries/account-statements";
import { getShellSummary } from "@/db/queries/app-shell";
import {
  archiveAccount,
  createAccount,
  listAccounts,
  restoreAccount,
  updateAccount,
} from "@/db/queries/accounts";
import { getAuditFilterOptions, listAuditLog } from "@/db/queries/audit-log";
import {
  archiveBudget,
  createBudget,
  listBudgetsWithStatus,
  resolveBudgetPlace,
  updateBudget,
} from "@/db/queries/budgets";
import { resolveWithdrawalTarget, withdrawCash } from "@/db/queries/cash";
import {
  createCategory,
  listCategories,
  listParentCategories,
  listUsedCategoryColors,
  updateCategory,
} from "@/db/queries/categories";
import { createGroup } from "@/db/queries/create-group";
import { getDebtDetail } from "@/db/queries/debt-detail";
import { getDebtOverview } from "@/db/queries/debt-overview";
import { getCurrentStatement } from "@/db/queries/debt-statements";
import { getDebtTerms, upsertDebtTerms } from "@/db/queries/debt-terms";
import { getDebtsScreenData } from "@/db/queries/debts-screen";
import type { DebtsScreenData } from "@/db/queries/debts-screen";
import { readExport } from "@/db/queries/export";
import {
  claimInviteForUser,
  createMember,
  listMembers,
} from "@/db/queries/group-members";
import { getUserGroup, updateGroupSettings } from "@/db/queries/groups";
import { readImportScope } from "@/db/queries/import-preview";
import {
  countPendingDeliveries,
  listOwnMerchants,
  listPendingDeliveries,
  listSilencedShapes,
  restoreShape,
} from "@/db/queries/ingest-review";
import {
  createInstallmentPlan,
  listPlanPositions,
  listPlansForAccount,
  recordDebtPayment,
} from "@/db/queries/installment-plans";
import {
  createLabel,
  listLabels,
  listManagedLabels,
  listUsedLabelColors,
  updateLabel,
} from "@/db/queries/labels";
import { seedPersonalCategories } from "@/db/queries/personal-space";
import {
  createPlannedPayment,
  listPlannedPayments,
  settlePlannedPayment,
} from "@/db/queries/planned-payments";
import {
  categoryFitsRuleAccount,
  countUnreviewedGenerated,
  createRecurringRule,
  listRecurringRules,
} from "@/db/queries/recurring-rules";
import { getMemberContributions } from "@/db/queries/reports/contributions";
import { getDashboardData } from "@/db/queries/reports/dashboard";
import { getExpensesByCategory } from "@/db/queries/reports/expenses-by-category";
import { getMonthlyFlow, getSixMonthFlow } from "@/db/queries/reports/monthly-flow";
import { netWorthByOwner } from "@/db/queries/reports/net-worth";
import { getReportsData } from "@/db/queries/reports/reports-screen";
import {
  addGoalContribution,
  archiveGoal,
  createGoal,
  listGoalsWithProgress,
} from "@/db/queries/savings-goals";
import {
  getLastUsedAccountId,
  getTransactionFormOptions,
} from "@/db/queries/transaction-form";
import {
  createTransaction,
  deleteTransaction,
  getTransactionById,
  getTransactionTotals,
  listTransactions,
  updateTransaction,
} from "@/db/queries/transactions";
import { updateAccountAction } from "@/app/actions/accounts";
import { createRecurringRuleAction, updateRecurringRuleAction } from "@/app/actions/recurring-rules";
import { recordBilledAmount } from "@/db/queries/debt-statements";
import { updateRecurringRule } from "@/db/queries/recurring-rules";
import {
  buildEffectiveRefs,
  processRow,
  type RawRow,
} from "@/lib/spreadsheet/import-pipeline";
import { commitImport } from "@/db/queries/import-commit";
import type { CommitInput } from "@/db/queries/import-commit";
import { getUserLocale, upsertUserLocale } from "@/db/queries/user-locale";
import {
  getWebhookCredentialOptions,
  issueWebhookCredential,
  listWebhookCredentials,
} from "@/db/queries/webhook-credentials";
import { getSessionUser, withUserDb } from "@/db/session";
import { BASE_CURRENCY } from "@/lib/currency";
import {
  addCivilMonths,
  budgetAnchor,
  currentMonthRange,
  lastSixMonthStarts,
  todayInBogota,
} from "@/lib/dates";
import { pgErrorCode } from "@/lib/db-error";
import { provisionalMemberName } from "@/lib/validation/member";
import { CATEGORY_COLORS } from "@/lib/fund/category-color";
import { SEED_CATEGORIES } from "@/lib/fund/seed";
import {
  accountRowSchema,
  categoryRowSchema,
  memberRowSchema,
  recurringRuleRowSchema,
  SHEET_ENTITIES,
  transactionRowSchema,
} from "@/lib/spreadsheet/schema";
import { createTransactionSchema } from "@/lib/validation/transaction";
import { and, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { transactions } from "@/db/schema";
import en from "@/messages/en.json";
import es from "@/messages/es.json";

import { assert, report, skip } from "./harness/assert";
import type { FixtureTable, HarnessScope, HarnessUser } from "./harness/fixtures";
import {
  asOwner,
  asUser,
  cleanup,
  countOwnedMovements,
  createHarnessUser,
  createMembershipFreeUser,
  findUserByEmail,
  fixtureSql,
  seedHarnessScope,
  track,
  YEAR_OF_MOVEMENTS,
} from "./harness/fixtures";
import { HARNESS_EMAIL } from "./harness/session";

// The user the decisions note as already seeded. Read once for the transcript,
// never written, and no assertion depends on it.
const SEEDED_USER_ID = "30e3acba-7122-404e-b961-c65a98bf1e37";

let counter = 0;

function next(name: string): string {
  counter += 1;
  return `Q${counter}. ${name}`;
}

// The entity/record pairs this run wrote THROUGH the app's own functions, which
// the audit invariant then reads back. Fixture rows are not in here.
const written: { entity: FixtureTable; recordId: string }[] = [];

function keep(entity: FixtureTable, recordId: string): void {
  track(entity, recordId);
  written.push({ entity, recordId });
}

function summarise(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} rows`;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return `keys: ${Object.keys(value).join(", ")}`;
  return String(value);
}

// The driver's message hangs off the cause chain, like its sqlstate: the thrown
// DrizzleQueryError only says which query failed, never why.
function rootMessage(error: unknown): string {
  let current: unknown = error;
  let message = String(error);

  for (let hop = 0; hop < 5; hop++) {
    if (typeof current !== "object" || current === null) break;
    if ("message" in current && typeof current.message === "string") {
      message = current.message;
    }
    current = "cause" in current ? current.cause : undefined;
  }

  return message.split("\n")[0];
}

function refusal(error: unknown): string {
  return `sqlstate ${pgErrorCode(error) ?? "none"} — ${rootMessage(error)}`;
}

async function checkRead(name: string, run: () => Promise<unknown>): Promise<void> {
  const label = next(name);
  try {
    assert(label, true, summarise(await run()));
  } catch (error) {
    assert(label, false, refusal(error));
  }
}

type Outcome = { ok: boolean; detail: string };

/**
 * A write path and the two things worth knowing about it: what it returned, and
 * what the row reads back as. A refusal reports its sqlstate AND its message —
 * a bare code names the wrong defect as often as the right one.
 */
async function checkWrite<T>(
  name: string,
  run: () => Promise<T>,
  outcome: (value: T) => Promise<Outcome> | Outcome,
): Promise<T | null> {
  const label = next(name);
  try {
    const value = await run();
    const { ok, detail } = await outcome(value);
    assert(label, ok, detail);
    return value;
  } catch (error) {
    assert(label, false, refusal(error));
    return null;
  }
}

// The same drive-and-assert as `checkWrite`, under the name a read belongs under:
// `checkRead` above asserts the literal `true`, so it passes on `[]` and on another
// user's rows alike. A read that has something to say about its rows uses this.
const checkReadValue = checkWrite;

// Reads back as the owner, outside RLS: the assertion is about what was STORED,
// not about what a policy would show.
async function readColumn<T>(
  table: string,
  idColumn: string,
  id: string,
  column: string,
): Promise<T | undefined> {
  const [row] = await fixtureSql<{ value: T }[]>`
    select ${fixtureSql(column)} as value
    from ${fixtureSql(table)}
    where ${fixtureSql(idColumn)} = ${id}`;

  return row?.value;
}

// A civil date shifted by whole days, in the UTC-midday scheme `lib/dates.ts`
// reads every date through, so a day either side of a DST-observing zone never
// slips.
function shiftDate(base: string, days: number): string {
  const date = new Date(`${base}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(date);
}

type SilencedFixture = {
  shapeId: string;
  sampleText: string;
  silencedIds: string[];
  humanRejectedId: string;
};

/**
 * One silenced shape as RF-92 leaves it: a delivery a person rejected by hand before
 * the memory existed, then the memory, then two deliveries that memory discarded on
 * arrival. Nothing here names `status` or `silenced_on_arrival` — the trigger settles
 * both, so the fixture is what the database decides rather than what the harness wants.
 */
async function seedSilencedShape(
  userId: string,
  tag: string,
): Promise<SilencedFixture> {
  const shapeHash = createHash("sha256").update(randomUUID()).digest("hex");
  const sampleText = `Harness mensaje silenciado ${tag}`;
  const ref = (suffix: string) => `harness-${tag}-${suffix}-${shapeHash.slice(0, 12)}`;
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
  });

  return fixtureSql.begin<SilencedFixture>(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;

    // Inserted while no memory exists, so it arrives pending and the rejection below is
    // a person's — the one row a restore must never touch.
    const [human] = await tx<{ id: string }[]>`
      insert into ingest_deliveries (external_ref, raw_text, shape_hash)
      values (${ref("human")}, ${sampleText}, ${shapeHash}) returning id`;
    await tx`
      update ingest_deliveries set status = 'rejected', resolved_at = now()
      where id = ${human.id} and status = 'pending'`;

    const [shape] = await tx<{ id: string }[]>`
      insert into ingest_shapes (shape_hash, decision, sample_text)
      values (${shapeHash}, 'rejected', ${sampleText}) returning id`;

    const silenced = await tx<{ id: string }[]>`
      insert into ingest_deliveries (external_ref, raw_text, shape_hash)
      values (${ref("silenced-a")}, ${sampleText}, ${shapeHash}),
             (${ref("silenced-b")}, ${sampleText}, ${shapeHash})
      returning id`;

    return {
      shapeId: shape.id,
      sampleText,
      silencedIds: silenced.map((row) => row.id),
      humanRejectedId: human.id,
    };
  });
}

type SilencedFixtures = {
  // Restored by the write suite; the read suite then proves it is gone.
  restored: SilencedFixture;
  // Left silenced, so the read has rows of its own to be asserted on.
  listed: SilencedFixture;
};

// A pending invitation, written as the owner but under the leader's claims, the
// way `seedHarnessScope` writes its rows: the stamping triggers read auth.uid()
// while the owner's privileges do the insert.
async function seedPendingInvite({
  groupId,
  memberId,
  actorId,
  name,
  email,
  archived,
}: {
  groupId: string;
  memberId: string;
  actorId: string;
  name: string;
  email: string;
  archived: boolean;
}): Promise<void> {
  const claims = JSON.stringify({
    sub: actorId,
    role: "authenticated",
    aud: "authenticated",
  });

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`
      insert into group_members (id, group_id, name, role, invite_email, archived_at)
      values (${memberId}, ${groupId}, ${name}, 'member', ${email},
        ${archived ? tx`now()` : null})`;
  });

  track("group_members", memberId);
}

/**
 * A second identity inside the leader's group: a plain member, who reads the
 * leader's personal accounts (RF-58) and can write none of them, since
 * `can_write_account` admits only their owner or a shared group account. It is
 * what `canWrite` has to be driven against — a fabricated boolean would prove
 * nothing about the policy the screens are asking after.
 */
async function seedFellowMember(
  actorId: string,
  groupId: string,
): Promise<HarnessUser> {
  const user = await createMembershipFreeUser();
  const memberId = randomUUID();
  const claims = JSON.stringify({
    sub: actorId,
    role: "authenticated",
    aud: "authenticated",
  });

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    await tx`
      insert into group_members (id, group_id, user_id, name, role)
      values (${memberId}, ${groupId}, ${user.id}, 'Harness miembra', 'member')`;
  });

  track("group_members", memberId);

  return user;
}

type MemberSnapshot = {
  id: string;
  user_id: string | null;
  invite_email: string | null;
  name: string;
  archived_at: string | null;
};

// Every row of a group, archived ones included: the UPDATE this replaced carried
// no WHERE, so the whole group is the blast radius a claim has to leave alone.
async function readGroupMembers(groupId: string): Promise<MemberSnapshot[]> {
  return fixtureSql<MemberSnapshot[]>`
    select id, user_id, invite_email, name, archived_at::text as archived_at
    from group_members where group_id = ${groupId} order by id`;
}

// The limit the write suite's card is given, and the only limit in the run: the
// consolidated credit totals are asserted against it.
// Round trips of getShellSummary, measured before the fund joined it: BEGIN, settle, the statement, COMMIT.
const SHELL_TRIPS = 4;

const CREDIT_LIMIT_CENTS = 500000000;

// The write suite's own plan: three lines of this, one closed by its payment.
const CARD_LINE_CENTS = 40000000;

// Three equal lines, so a payment of two of them plus a few cents leaves a
// remainder no line can take.
const PLAN_LINE_CENTS = 100000;
const PLAN_REMAINDER_CENTS = 5000;

// The day of the month the fixture debt cuts its statements on.
const CUT_OFF_DAY = 15;

// RF-124: a second currency in the same run, so a report that folds it beside
// the peso ones never adds the two into one figure. Spent out of a dollar
// account that carries no other movement, so this is the whole of its pocket.
const USD_EXPENSE_CENTS = 250000;

// RF-123: a card purchase abroad the issuer has not billed yet. Booked on the
// no-limit debt so Q64-Q72's credit-total assertions, keyed to the OTHER debt,
// stay untouched, and `getAccountBalances` narrowed to that other debt keeps
// its one row (`getAccountBalances narrows to the ids it is given`).
const CARD_FOREIGN_CENTS = 15000;
const CARD_FOREIGN_COUNTER_CENTS = 60000000;

// The two pockets a card purchase and a plain expense leave in the same
// currency and the same owner: net worth and monthly flow fold every account
// of one owner into one bucket per currency, so the two sum here too.
const USD_OWED_AND_SPENT_CENTS = USD_EXPENSE_CENTS + CARD_FOREIGN_CENTS;

// RF-122: the confirmed second leg of a contribution into the group's own
// dollar account — what the pot received, never the sender's peso amount.
const CONTRIBUTION_COP_CENTS = 12000000;
const CONTRIBUTION_USD_CENTS = 500000;

// The fund's whole dollar figure, by hand, from what this run itself put in
// dollars: the leader's own spending, negative, plus the group's own account,
// which holds nothing but the contribution above. Never read off
// `dashboard.netWorth` — a row duplicated there would double this the same
// way and the check would pass on a defect it exists to catch.
const FUND_USD_NET_WORTH_CENTS = CONTRIBUTION_USD_CENTS - USD_OWED_AND_SPENT_CENTS;

type DebtFixture = {
  // A liability whose terms name NO credit limit, opened six months back so its
  // past statement periods are there to be cut.
  unlimitedAccountId: string;
  unlimitedName: string;
  openedOn: string;
  // A plan on the scope's terms-less liability, its three lines a month apart.
  planId: string;
  dueDates: string[];
};

/**
 * The two debts the installment, credit and statement checks read, beside the card
 * the write suite creates: a liability that carries terms without a limit (RF-117)
 * and a plan on a liability that carries no terms at all (RF-81, RF-82). Written as
 * the owner under the caller's claims, the way `seedHarnessScope` writes: the
 * stamping triggers see `auth.uid()` while the owner's privileges do the insert.
 */
async function seedDebtFixture(
  userId: string,
  scope: HarnessScope,
): Promise<DebtFixture> {
  const today = todayInBogota();
  const fixture: DebtFixture = {
    unlimitedAccountId: randomUUID(),
    unlimitedName: "Harness credit line",
    openedOn: addCivilMonths(today, -6),
    planId: randomUUID(),
    dueDates: [today, addCivilMonths(today, 1), addCivilMonths(today, 2)],
  };
  const claims = JSON.stringify({
    sub: userId,
    role: "authenticated",
    aud: "authenticated",
  });

  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;

    await tx`
      insert into accounts
        (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values
        (${fixture.unlimitedAccountId}, ${userId}, ${fixture.unlimitedName},
         'liability', 'card', -1200000, ${fixture.openedOn})`;

    // No credit limit and no minimum percentage: the limit is what the credit
    // totals must skip, and the cut-off day is what gives the history periods.
    await tx`
      insert into debt_terms
        (account_id, debt_kind, annual_rate, minimum_payment_cents,
         credit_limit_cents, statement_cut_off_day, payment_due_day)
      values
        (${fixture.unlimitedAccountId}, 'revolving', 0.2400, 30000,
         null, ${CUT_OFF_DAY}, 4)`;

    await tx`
      insert into installment_plans
        (id, account_id, description, principal_cents, n_installments, frequency, start_date)
      values
        (${fixture.planId}, ${scope.liabilityAccountId}, 'Harness plan without terms',
         ${PLAN_LINE_CENTS * 3}, 3, 'monthly', ${today})`;

    await tx`
      insert into installment_lines (plan_id, seq, due_date, amount_cents) values
        (${fixture.planId}, 1, ${fixture.dueDates[0]}, ${PLAN_LINE_CENTS}),
        (${fixture.planId}, 2, ${fixture.dueDates[1]}, ${PLAN_LINE_CENTS}),
        (${fixture.planId}, 3, ${fixture.dueDates[2]}, ${PLAN_LINE_CENTS})`;
  });

  track("accounts", fixture.unlimitedAccountId);
  track("debt_terms", fixture.unlimitedAccountId);
  // The lines go with the plan: the foreign key cascades.
  track("installment_plans", fixture.planId);

  return fixture;
}

// Which of a plan's lines a movement closed, read as the owner and in due order:
// the allocation is oldest-first, so WHICH lines were taken is the assertion, not
// how many.
async function readPaidLines(planId: string): Promise<string> {
  const rows = await fixtureSql<{ seq: number; paid: boolean }[]>`
    select seq, paid_transaction_id is not null as paid
    from installment_lines where plan_id = ${planId} order by due_date, seq`;

  return rows.map((row) => `${row.seq}:${row.paid}`).join(", ");
}

type WriteResults = {
  accountId: string | null;
  transactionId: string | null;
  withdrawalId: string | null;
  // RF-124 fixtures: a personal account settling in a second currency, and the
  // group's own account in that same one, so the read suite can prove the
  // reports never fold one into the other.
  usdAccountId: string | null;
  groupUsdAccountId: string | null;
  // The RF-122 contribution: group-scoped (its to-account is the pot), so
  // `purgeIdentity` never reaches it through `owner_user_id`, yet its
  // from-account is `scope.assetAccountId`, personal. `readSuite` deletes it by
  // hand once nothing reads it again — see the call site there.
  contributionTransactionId: string | null;
  // The dollar expense's own category, distinct from `scope.categoryId`: the
  // foreign card purchase spends the latter, so the two dollar amounts land in
  // different category rows and neither assertion can pass by adding them.
  usdCategoryId: string | null;
};

/**
 * Suite Q-write: every write path, with a realistic argument set, asserted on
 * its return value and on the row read back. It runs first because Q1 is the
 * failing-before assertion and the account it creates is what the suites below
 * read; a dependent falls back to a seeded row only when its parent was refused.
 */
async function writeSuite(
  userId: string,
  scope: HarnessScope,
  groupless: HarnessUser,
  silenced: SilencedFixture,
  debt: DebtFixture,
): Promise<WriteResults> {
  const today = todayInBogota();
  const personal = { ownerUserId: userId } as const;

  const account = await checkWrite(
    "createAccount",
    () =>
      createAccount({
        name: "Harness tarjeta",
        kind: "liability",
        subtype: "card",
        ownerUserId: userId,
        groupId: null,
        isShared: false,
        institution: "Bancolombia",
        lastFour: "4321",
        settlementCurrency: BASE_CURRENCY,
        amountMinor: 1500,
        balanceOn: today,
      }),
    ({ accountId }) => {
      keep("accounts", accountId);
      return { ok: true, detail: `account ${accountId}` };
    },
  );

  // The seeded card stands in when the create was refused, so the edit paths are
  // still measured against a row the caller really owns.
  const accountId = account?.accountId ?? scope.liabilityAccountId;

  await checkWrite(
    "updateAccount",
    () =>
      updateAccount({
        accountId,
        name: "Harness tarjeta editada",
        subtype: "card",
        isShared: false,
        institution: "Davivienda",
        lastFour: "9876",
        settlementCurrency: BASE_CURRENCY,
        amountMinor: 1800,
        balanceOn: today,
      }),
    async (updated) => ({
      ok: updated,
      detail: `updated = ${updated}, name = ${await readColumn("accounts", "id", accountId, "name")}`,
    }),
  );

  await checkWrite(
    "archiveAccount",
    () => archiveAccount({ accountId }),
    async (archived) => ({
      ok: archived,
      detail: `archived = ${archived}, archived_at = ${await readColumn("accounts", "id", accountId, "archived_at")}`,
    }),
  );

  await checkWrite(
    "restoreAccount",
    () => restoreAccount({ accountId }),
    async (restored) => ({
      ok: restored,
      detail: `restored = ${restored}, archived_at = ${await readColumn("accounts", "id", accountId, "archived_at")}`,
    }),
  );

  const category = await checkWrite(
    "createCategory",
    () =>
      createCategory({
        scope: personal,
        name: "Harness transporte",
        kind: "expense",
        parentId: null,
        color: "#B4542F",
      }),
    ({ categoryId }) => {
      keep("categories", categoryId);
      return { ok: true, detail: `category ${categoryId}` };
    },
  );

  const categoryId = category?.categoryId ?? scope.categoryId;

  await checkWrite(
    "updateCategory",
    () =>
      updateCategory({
        categoryId,
        name: "Harness transporte editada",
        parentId: null,
        color: "#2F6FB4",
      }),
    async (updated) => ({
      ok: updated,
      detail: `updated = ${updated}, name = ${await readColumn("categories", "id", categoryId, "name")}`,
    }),
  );

  // RF-121, RF-124: a personal account that settles in a currency other than
  // the base one, so `netWorthByOwner`, the dashboard, the monthly flow and the
  // per-category totals each have a second currency to keep apart from pesos.
  const usdAccount = await checkWrite(
    "createAccount opens an account in a second currency",
    () =>
      createAccount({
        name: "Harness dólares",
        kind: "asset",
        subtype: "bank",
        ownerUserId: userId,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "USD",
        amountMinor: 0,
        balanceOn: today,
      }),
    ({ accountId }) => {
      keep("accounts", accountId);
      return { ok: true, detail: `account ${accountId}` };
    },
  );

  const usdAccountId = usdAccount?.accountId ?? scope.assetAccountId;

  await checkWrite(
    "createTransaction books a dollar expense beside the peso ones",
    () =>
      createTransaction({
        fromAccountId: usdAccountId,
        toAccountId: null,
        amountCents: USD_EXPENSE_CENTS,
        occurredAt: today,
        description: "Harness gasto en dólares",
        externalRef: null,
        splits: [{ categoryId, amountCents: USD_EXPENSE_CENTS }],
        labelIds: [],
      }),
    async ({ transactionId }) => {
      keep("transactions", transactionId);
      const currency = await readColumn<string>("transactions", "id", transactionId, "currency");
      const stored = await readColumn<string | number>("transactions", "id", transactionId, "amount_cents");
      return {
        ok: currency === "USD" && Number(stored) === USD_EXPENSE_CENTS,
        detail: `movement ${transactionId}, currency = ${currency}, amount_cents = ${stored}`,
      };
    },
  );

  // RF-121: the group's own account in that second currency, so a contribution
  // into it (RF-66, RF-122) gives `getMemberContributions` a second currency of
  // its own — never folded into what the same member put into the group's peso
  // accounts.
  const groupUsdAccount = await checkWrite(
    "createAccount opens the group's own account in a second currency",
    () =>
      createAccount({
        name: "Harness fondo dólares",
        kind: "asset",
        subtype: "bank",
        ownerUserId: null,
        groupId: scope.groupId,
        isShared: true,
        institution: null,
        lastFour: null,
        settlementCurrency: "USD",
        amountMinor: 0,
        balanceOn: today,
      }),
    ({ accountId }) => {
      keep("accounts", accountId);
      return { ok: true, detail: `account ${accountId}` };
    },
  );

  const groupUsdAccountId = groupUsdAccount?.accountId ?? null;

  const contribution = await checkWrite(
    "createTransaction confirms a contribution's dollar leg (RF-122)",
    () =>
      createTransaction({
        fromAccountId: scope.assetAccountId,
        toAccountId: groupUsdAccountId,
        amountCents: CONTRIBUTION_COP_CENTS,
        currency: BASE_CURRENCY,
        counterAmountCents: CONTRIBUTION_USD_CENTS,
        counterIsEstimate: false,
        occurredAt: today,
        description: "Harness aporte en dólares",
        externalRef: null,
        splits: [],
        labelIds: [],
      }),
    async ({ transactionId }) => {
      keep("transactions", transactionId);
      const counter = await readColumn<string | number>("transactions", "id", transactionId, "counter_amount_cents");
      const stored = await readColumn<string | number>("transactions", "id", transactionId, "amount_cents");
      return {
        ok: Number(counter) === CONTRIBUTION_USD_CENTS && Number(stored) === CONTRIBUTION_COP_CENTS,
        detail: `movement ${transactionId}, amount_cents = ${stored}, counter_amount_cents = ${counter}`,
      };
    },
  );

  // Driven by the membership-free user, never the run's own: `seedHarnessScope`
  // already made that one a leader, and RF-55 holds a user to one live
  // membership — the refusal that follows is asserted in `invariantSuite`.
  await checkWrite(
    "createGroup",
    () =>
      asUser(groupless, () =>
        createGroup({
          name: "Harness fondo nuevo",
          leaderName: "Harness leader",
          cashMode: "shared",
          locale: "es",
        }),
      ),
    async ({ groupId }) => {
      track("groups", groupId);

      // Four rows in one round trip, read as the owner: the group, the leader
      // the caller became, the cash account `cash_mode = 'shared'` seeds and the
      // categories a new fund files against. Not `keep`: the audit invariant
      // reads the trail of the run's own user, and none of this is written by it.
      const [written] = await fixtureSql<
        {
          group_name: string | null;
          member_id: string | null;
          account_id: string | null;
          category_ids: string[] | null;
        }[]
      >`
        select
          (select name from groups where id = ${groupId}) as group_name,
          (select id from group_members
             where group_id = ${groupId} and user_id = ${groupless.id}
               and role = 'leader') as member_id,
          (select id from accounts
             where group_id = ${groupId} and subtype = 'cash') as account_id,
          (select array_agg(id) from categories where group_id = ${groupId})
            as category_ids`;

      const categoryIds = written.category_ids ?? [];
      if (written.member_id !== null) track("group_members", written.member_id);
      if (written.account_id !== null) track("accounts", written.account_id);
      for (const categoryId of categoryIds) track("categories", categoryId);

      const expectedCategories = SEED_CATEGORIES.reduce(
        (total, category) => total + 1 + (category.children?.length ?? 0),
        0,
      );

      return {
        ok:
          written.group_name === "Harness fondo nuevo" &&
          written.member_id !== null &&
          written.account_id !== null &&
          categoryIds.length === expectedCategories,
        detail: `group ${groupId} named ${written.group_name}, leader member ${written.member_id}, cash account ${written.account_id}, ${categoryIds.length} of ${expectedCategories} categories`,
      };
    },
  );

  // The other half of what `createGroup` writes, for the personal-only user RF-55 allows:
  // the confirm route calls this inside its own `withUserDb`, so the proof opens one too.
  const seeded = await createMembershipFreeUser();

  await checkWrite(
    "seedPersonalCategories",
    () =>
      asUser(seeded, () =>
        withUserDb((tx) => seedPersonalCategories(tx, { userId: seeded.id, locale: "es" })),
      ),
    async (written) => {
      const rows = await fixtureSql<
        { id: string; owner_user_id: string | null; group_id: string | null }[]
      >`
        select id, owner_user_id, group_id from categories
        where owner_user_id = ${seeded.id}`;
      for (const row of rows) track("categories", row.id);

      const expected = SEED_CATEGORIES.reduce(
        (total, category) => total + 1 + (category.children?.length ?? 0),
        0,
      );
      const personal = rows.every(
        (row) => row.owner_user_id === seeded.id && row.group_id === null,
      );

      return {
        ok: written === expected && rows.length === expected && personal,
        detail: `reported ${written} rows, ${rows.length} of ${expected} landed, every one owned by the user and in no group = ${personal}`,
      };
    },
  );

  await checkWrite(
    "createMember",
    () =>
      createMember({
        groupId: scope.groupId,
        name: "Harness invitada",
        inviteEmail: `harness-${randomUUID()}@example.invalid`,
      }),
    ({ memberId }) => {
      keep("group_members", memberId);
      return { ok: true, detail: `member ${memberId}` };
    },
  );

  // RF-06 from the three sides that decide it, driven by three sessions rather
  // than three arguments: the claim reads the caller's own identity, so who runs
  // it IS the input. The middle call is why this assertion exists — the UPDATE it
  // replaced carried no WHERE, and for a caller already in the group it stamped
  // her user_id onto every row of it and then reported "claimed".
  const invitee = await createMembershipFreeUser();
  const leaderEmail = process.env.HARNESS_USER_EMAIL ?? "";

  await checkWrite(
    "claimInviteForUser",
    async () => {
      const invitedId = randomUUID();
      const archivedId = randomUUID();
      const leaderInviteId = randomUUID();

      await seedPendingInvite({
        groupId: scope.groupId,
        memberId: invitedId,
        actorId: userId,
        name: "Harness invitada con login",
        email: invitee.email,
        archived: false,
      });
      // Archived and invited: the row the proved escalation wrote onto.
      await seedPendingInvite({
        groupId: scope.groupId,
        memberId: archivedId,
        actorId: userId,
        name: "Harness invitada archivada",
        email: `harness-${randomUUID()}@example.invalid`,
        archived: true,
      });

      const claimed = await asUser(invitee, () =>
        claimInviteForUser({ email: invitee.email }),
      );
      const [claimedRow] = await fixtureSql<
        { user_id: string | null; invite_email: string | null }[]
      >`select user_id, invite_email from group_members where id = ${invitedId}`;

      // The leader is in the group and holds no invitation: nothing may move.
      const before = await readGroupMembers(scope.groupId);
      const none = await claimInviteForUser({ email: leaderEmail });
      const after = await readGroupMembers(scope.groupId);

      // Now she does hold one, and her live leader row already carries her
      // user_id, so `group_members_user_unique` refuses the claim (RF-55).
      await seedPendingInvite({
        groupId: scope.groupId,
        memberId: leaderInviteId,
        actorId: userId,
        name: "Harness lider invitada",
        email: leaderEmail,
        archived: false,
      });
      const already = await claimInviteForUser({ email: leaderEmail });

      return {
        claimed,
        claimedRow,
        before,
        untouched: JSON.stringify(before) === JSON.stringify(after),
        none,
        already,
      };
    },
    (result) => ({
      ok:
        result.claimed === "claimed" &&
        result.claimedRow.user_id === invitee.id &&
        result.claimedRow.invite_email === null &&
        result.none === "none" &&
        result.untouched &&
        result.already === "already-in-group",
      detail: `invited caller = ${result.claimed}, her row carries her user_id = ${
        result.claimedRow.user_id === invitee.id
      } and invite_email = ${result.claimedRow.invite_email}; uninvited member = ${
        result.none
      }, ${result.before.length} group rows unchanged = ${
        result.untouched
      }; member holding a live membership = ${result.already}`,
    }),
  );

  const label = await checkWrite(
    "createLabel",
    () => createLabel({ scope: personal, name: "Harness viaje", color: "#7A4CB4" }),
    ({ labelId }) => {
      keep("labels", labelId);
      return { ok: true, detail: `label ${labelId}` };
    },
  );

  const labelId = label?.labelId ?? scope.labelId;

  await checkWrite(
    "updateLabel",
    () => updateLabel({ labelId, name: "Harness viaje editada", color: "#B44C7A" }),
    async (updated) => ({
      ok: updated,
      detail: `updated = ${updated}, name = ${await readColumn("labels", "id", labelId, "name")}`,
    }),
  );

  const budget = await checkWrite(
    "createBudget",
    () =>
      createBudget({
        ownerUserId: userId,
        groupId: null,
        categoryId: scope.categoryId,
        accountId: null,
        labelId: null,
        period: "monthly",
        limitCents: 40000000,
        thresholdPct: 80,
        name: "Harness mercado",
      }),
    ({ budgetId }) => {
      keep("budgets", budgetId);
      return { ok: true, detail: `budget ${budgetId}` };
    },
  );

  const budgetId = budget?.budgetId ?? randomUUID();

  await checkWrite(
    "updateBudget",
    () =>
      updateBudget({
        budgetId,
        accountId: null,
        labelId: null,
        period: "weekly",
        limitCents: 20000000,
        thresholdPct: 90,
        name: "Harness mercado semanal",
      }),
    async (updated) => ({
      ok: updated,
      detail:
        budget === null
          ? "updated = false — createBudget was refused, so this run has no budget to edit"
          : `updated = ${updated}, period = ${await readColumn("budgets", "id", budgetId, "period")}`,
    }),
  );

  // RF-120 from the read that has to honour it: the two calls partition the caller's
  // readable budgets, and an archived one derives its spent the same way a live one does.
  await checkWrite(
    "listBudgetsWithStatus partitions the archived from the live",
    async () => {
      const { budgetId: archivedId } = await createBudget({
        ownerUserId: userId,
        groupId: null,
        categoryId: scope.categoryId,
        accountId: null,
        labelId: null,
        period: "monthly",
        limitCents: 30000000,
        thresholdPct: 70,
        name: "Harness mercado archivado",
      });
      keep("budgets", archivedId);
      await archiveBudget({ budgetId: archivedId });

      const [live, archived] = await Promise.all([
        listBudgetsWithStatus(),
        listBudgetsWithStatus(undefined, { archived: true }),
      ]);

      return { archivedId, live, archived };
    },
    ({ archivedId, live, archived }) => {
      const liveIds = live.map((budget) => budget.id);
      const archivedIds = archived.map((budget) => budget.id);
      const overlap = liveIds.filter((id) => archivedIds.includes(id));

      return {
        ok:
          overlap.length === 0 &&
          archivedIds.includes(archivedId) &&
          liveIds.includes(budgetId),
        detail: `${liveIds.length} live and ${archivedIds.length} archived, ${overlap.length} named by both; the archived one is on the archived side = ${archivedIds.includes(archivedId)}, the edited one on the live side = ${liveIds.includes(budgetId)}`,
      };
    },
  );

  const goal = await checkWrite(
    "createGoal",
    () =>
      createGoal({
        ownerUserId: userId,
        groupId: null,
        name: "Harness viaje",
        targetAmountCents: 200000000,
        targetDate: null,
        accountId: null,
        initialContributionCents: 5000000,
      }),
    ({ goalId }) => {
      keep("savings_goals", goalId);
      return { ok: true, detail: `goal ${goalId}` };
    },
  );

  const goalId = goal?.goalId ?? randomUUID();

  await checkWrite(
    "addGoalContribution",
    () => addGoalContribution({ goalId, amountCents: 1500000 }),
    async ({ contributionId }) => {
      keep("goal_contributions", contributionId);
      const stored = await readColumn<string | number>("goal_contributions", "id", contributionId, "amount_cents");
      return {
        ok: Number(stored) === 1500000,
        detail: `contribution ${contributionId}, amount_cents = ${stored}`,
      };
    },
  );

  // The same partition on the goals, plus the identity RF-120 rests on: archiving writes no
  // aporte, so an archived goal's progress is still the sum of the rows it always had.
  await checkWrite(
    "listGoalsWithProgress partitions the archived from the live",
    async () => {
      const { goalId: archivedId } = await createGoal({
        ownerUserId: userId,
        groupId: null,
        name: "Harness viaje archivado",
        targetAmountCents: 100000000,
        targetDate: null,
        accountId: null,
        initialContributionCents: 2500000,
      });
      keep("savings_goals", archivedId);
      await archiveGoal({ goalId: archivedId });

      const [live, archived] = await Promise.all([
        listGoalsWithProgress(),
        listGoalsWithProgress({ archived: true }),
      ]);
      // Read as the owner: the sum the progress must equal, taken from the rows themselves.
      const [{ sum }] = await fixtureSql<{ sum: string }[]>`
        select coalesce(sum(amount_cents), 0)::text as sum
        from goal_contributions where goal_id = ${archivedId}`;

      return { archivedId, live, archived, contributed: Number(sum) };
    },
    ({ archivedId, live, archived, contributed }) => {
      const liveIds = live.map((goal) => goal.id);
      const archivedIds = archived.map((goal) => goal.id);
      const overlap = liveIds.filter((id) => archivedIds.includes(id));
      const savedCents = archived.find((goal) => goal.id === archivedId)?.savedCents;

      return {
        ok:
          overlap.length === 0 &&
          archivedIds.includes(archivedId) &&
          liveIds.includes(goalId) &&
          savedCents === contributed,
        detail: `${liveIds.length} live and ${archivedIds.length} archived, ${overlap.length} named by both; the archived one reads ${savedCents} cents against ${contributed} summed from its aportes, the live one is on the live side = ${liveIds.includes(goalId)}`,
      };
    },
  );

  // D5: the straight line runs from the day a goal opened, and a goal opened
  // today has spent none of it — so the naive comparison never flagged one whose
  // due date had already gone. Two edges the fix must land on both sides of, both
  // opened today: a target date two months gone with 38% saved (the figure
  // measured live) reads behind from its first day, and a target date with 90
  // days of runway left does not read behind just because the goal is new.
  await checkWrite(
    "listGoalsWithProgress reads a goal opened today as behind once its target date has passed",
    async () => {
      const targetAmountCents = 100000000;
      const savedCents = 38000000; // 38%, the figure measured live

      const [overdue, reachable] = await Promise.all([
        createGoal({
          ownerUserId: userId,
          groupId: null,
          name: "Harness meta vencida",
          targetAmountCents,
          targetDate: shiftDate(today, -60),
          accountId: null,
          initialContributionCents: savedCents,
        }),
        createGoal({
          ownerUserId: userId,
          groupId: null,
          name: "Harness meta con plazo",
          targetAmountCents,
          targetDate: shiftDate(today, 90),
          accountId: null,
          initialContributionCents: savedCents,
        }),
      ]);
      keep("savings_goals", overdue.goalId);
      keep("savings_goals", reachable.goalId);

      const rows = await listGoalsWithProgress();

      return {
        overdue: rows.find((goal) => goal.id === overdue.goalId),
        reachable: rows.find((goal) => goal.id === reachable.goalId),
      };
    },
    ({ overdue, reachable }) => ({
      ok: overdue?.behindPace === true && reachable?.behindPace === false,
      detail: `opened today, target date two months gone, 38% saved — behindPace = ${overdue?.behindPace}; opened today with 90 days of runway — behindPace = ${reachable?.behindPace}`,
    }),
  );

  // Not new, but must not move: an old goal already behind the straight line
  // keeps reading that way — the branch above only answers when the goal opened
  // on the very day its ritmo is read, and must never shadow this one.
  await checkWrite(
    "listGoalsWithProgress leaves an old, already-overdue goal reading behind",
    async () => {
      const targetAmountCents = 100000000;
      const savedCents = 38000000;

      const [{ id: oldGoalId }] = await fixtureSql<{ id: string }[]>`
        insert into savings_goals (owner_user_id, name, target_amount_cents, target_date, created_at)
        values (
          ${userId},
          'Harness meta vieja atrasada',
          ${targetAmountCents},
          ${shiftDate(today, -30)},
          now() - interval '90 days')
        returning id`;
      keep("savings_goals", oldGoalId);

      const [{ id: contributionId }] = await fixtureSql<{ id: string }[]>`
        insert into goal_contributions (goal_id, amount_cents)
        values (${oldGoalId}, ${savedCents})
        returning id`;
      keep("goal_contributions", contributionId);

      const rows = await listGoalsWithProgress();

      return rows.find((goal) => goal.id === oldGoalId);
    },
    (goal) => ({
      ok: goal?.behindPace === true,
      detail: `opened 90 days ago, target date a month gone, 38% saved — behindPace = ${goal?.behindPace}`,
    }),
  );

  const planned = await checkWrite(
    "createPlannedPayment",
    () =>
      createPlannedPayment({
        fromAccountId: scope.assetAccountId,
        toAccountId: null,
        amountCents: 9000000,
        categoryId: scope.categoryId,
        dueDate: today,
        remindOn: null,
        description: "Harness arriendo",
      }),
    ({ plannedPaymentId }) => {
      keep("planned_payments", plannedPaymentId);
      return { ok: true, detail: `planned payment ${plannedPaymentId}` };
    },
  );

  const plannedPaymentId = planned?.plannedPaymentId ?? randomUUID();

  await checkWrite(
    "settlePlannedPayment",
    () =>
      settlePlannedPayment({
        plannedPaymentId,
        fromAccountId: scope.assetAccountId,
        toAccountId: null,
        amountCents: 9000000,
        categoryId: scope.categoryId,
        occurredAt: today,
        description: "Harness arriendo",
      }),
    async (result) => {
      if (result.settled) keep("transactions", result.transactionId);
      return {
        ok: result.settled,
        detail: result.settled
          ? `movement ${result.transactionId}, status = ${await readColumn("planned_payments", "id", plannedPaymentId, "status")}`
          : "settled = false, the payment was not pending",
      };
    },
  );

  await checkWrite(
    "createRecurringRule",
    () =>
      createRecurringRule({
        fromAccountId: scope.assetAccountId,
        toAccountId: null,
        amountCents: 3500000,
        categoryId: scope.categoryId,
        description: "Harness suscripción",
        frequency: "monthly",
        intervalN: 1,
        dayOfMonth: 5,
        nextRunOn: today,
        endsOn: null,
      }),
    async ({ recurringRuleId }) => {
      keep("recurring_rules", recurringRuleId);
      return {
        ok: true,
        detail: `rule ${recurringRuleId}, next_run_on = ${await readColumn("recurring_rules", "id", recurringRuleId, "next_run_on")}`,
      };
    },
  );

  await checkWrite(
    "upsertDebtTerms",
    () =>
      upsertDebtTerms({
        accountId,
        debtKind: "revolving",
        annualRate: "0.2800",
        minimumPaymentCents: 5000000,
        minimumPaymentPct: null,
        creditLimitCents: CREDIT_LIMIT_CENTS,
        statementCutOffDay: 15,
        paymentDueDay: 5,
        avalCents: null,
      }),
    async (terms) => {
      keep("debt_terms", terms.accountId);
      return {
        ok: terms.accountId === accountId,
        detail: `terms on ${terms.accountId}, annual_rate = ${await readColumn("debt_terms", "account_id", accountId, "annual_rate")}`,
      };
    },
  );

  await checkWrite(
    "createInstallmentPlan",
    () =>
      createInstallmentPlan({
        accountId,
        description: "Harness nevera",
        principalCents: CARD_LINE_CENTS * 3,
        nInstallments: 3,
        frequency: "monthly",
        interestRate: "0.0200",
        downPaymentCents: null,
        avalCents: null,
        startDate: today,
        merchant: "Harness store",
        lines: [
          { seq: 1, dueDate: today, amountCents: CARD_LINE_CENTS },
          { seq: 2, dueDate: today, amountCents: CARD_LINE_CENTS },
          { seq: 3, dueDate: today, amountCents: CARD_LINE_CENTS },
        ],
      }),
    async ({ planId }) => {
      keep("installment_plans", planId);
      const stored = await readColumn<string | number>("installment_plans", "id", planId, "n_installments");
      return {
        ok: Number(stored) === 3,
        detail: `plan ${planId}, n_installments = ${stored}`,
      };
    },
  );

  await checkWrite(
    "recordDebtPayment",
    () =>
      recordDebtPayment({
        fromAccountId: scope.assetAccountId,
        toAccountId: accountId,
        amountCents: CARD_LINE_CENTS,
        occurredAt: today,
      }),
    async ({ transactionId, paidLineIds }) => {
      keep("transactions", transactionId);
      const kind = await readColumn<string>("transactions", "id", transactionId, "kind");
      const stored = await readColumn<string | number>("transactions", "id", transactionId, "amount_cents");
      return {
        ok: kind === "transfer" && Number(stored) === CARD_LINE_CENTS && paidLineIds.length === 1,
        detail: `movement ${transactionId}, lines paid = ${paidLineIds.length}, kind = ${kind}, amount_cents = ${stored}`,
      };
    },
  );

  // RF-82 end to end through the app's own allocator: two lines closed oldest
  // first, the third left standing because the payment does not cover it whole,
  // and the cents over the two returned unallocated.
  await checkWrite(
    "recordDebtPayment closes the oldest lines and hands back the remainder",
    () =>
      recordDebtPayment({
        fromAccountId: scope.assetAccountId,
        toAccountId: scope.liabilityAccountId,
        amountCents: PLAN_LINE_CENTS * 2 + PLAN_REMAINDER_CENTS,
        occurredAt: today,
      }),
    async ({ transactionId, paidLineIds, remainderCents }) => {
      keep("transactions", transactionId);
      const paid = await readPaidLines(debt.planId);

      return {
        ok:
          paidLineIds.length === 2 &&
          remainderCents === PLAN_REMAINDER_CENTS &&
          paid === "1:true, 2:true, 3:false",
        detail: `${paidLineIds.length} lines closed, remainder ${remainderCents} cents of the ${PLAN_LINE_CENTS * 2 + PLAN_REMAINDER_CENTS} paid, lines by seq = ${paid}`,
      };
    },
  );

  // RF-16: a debt is paid from an asset. The kinds are read in the statement that
  // reads the lines, one statement ahead of the INSERT, so the refusal costs no
  // movement — and a movement written and rolled back would still burn an id.
  const notFromAsset = next("a payment from a liability writes no movement");
  const movementsBefore = await fixtureSql<{ total: string }[]>`
    select count(*)::text as total from transactions
    where from_account_id = ${scope.liabilityAccountId}`;
  try {
    const { transactionId } = await recordDebtPayment({
      fromAccountId: scope.liabilityAccountId,
      toAccountId: accountId,
      amountCents: PLAN_LINE_CENTS,
      occurredAt: today,
    });
    // Tracked, not left behind: an accepted call is the failure this asserts on.
    track("transactions", transactionId);
    assert(notFromAsset, false, `it was accepted as movement ${transactionId}`);
  } catch (error) {
    const movementsAfter = await fixtureSql<{ total: string }[]>`
      select count(*)::text as total from transactions
      where from_account_id = ${scope.liabilityAccountId}`;
    assert(
      notFromAsset,
      pgErrorCode(error) === "23514" &&
        rootMessage(error).includes("comes from an asset account") &&
        movementsAfter[0].total === movementsBefore[0].total,
      `${refusal(error)}; movements out of the liability ${movementsBefore[0].total} before, ${movementsAfter[0].total} after`,
    );
  }

  // The action's own reading of the refusals, which the dialog shows: all three
  // arrive as 23514, and only the message tells the source's from the rest. The
  // client logs each one as it maps it, so a failed action is loud above.
  await checkReadValue(
    "recordDebtPaymentAction answers a liability source with the source's key",
    () =>
      recordDebtPaymentAction({
        fromAccountId: scope.liabilityAccountId,
        toAccountId: accountId,
        amount: "1000",
        occurredAt: today,
      }),
    (result) => ({
      ok: result?.serverError === "installments.errors.notFromAsset",
      detail: `serverError = ${result?.serverError ?? "none"}`,
    }),
  );

  // Aiming a payment at an account that is no debt is the same mistake as aiming a
  // plan at one, so the two paths answer with the same key.
  await checkReadValue(
    "recordDebtPaymentAction answers a destination that is no debt with the account key",
    () =>
      recordDebtPaymentAction({
        fromAccountId: scope.assetAccountId,
        toAccountId: scope.cashAccountId,
        amount: "1000",
        occurredAt: today,
      }),
    (result) => ({
      ok: result?.serverError === "installments.errors.notLiability",
      detail: `serverError = ${result?.serverError ?? "none"}`,
    }),
  );

  await checkReadValue(
    "createInstallmentPlanAction answers an asset account with that same key",
    () =>
      createInstallmentPlanAction({
        accountId: scope.assetAccountId,
        description: null,
        principal: "1000",
        nInstallments: 3,
        frequency: "monthly",
        interestRate: null,
        downPayment: null,
        aval: null,
        startDate: today,
        merchant: null,
      }),
    async (result) => {
      const [row] = await fixtureSql<{ total: string }[]>`
        select count(*)::text as total from installment_plans
        where account_id = ${scope.assetAccountId}`;

      return {
        ok:
          result?.serverError === "installments.errors.notLiability" &&
          row.total === "0",
        detail: `serverError = ${result?.serverError ?? "none"}, plans on the asset = ${row.total}`,
      };
    },
  );

  // The leftover key, and it is reachable: the shared peso schema bounds only the
  // upper end, so a zero clears Zod and the kinds guard and is refused by
  // `transactions_amount_positive` — one more 23514, and neither kind's message.
  await checkReadValue(
    "recordDebtPaymentAction answers a zero with the payment key, and writes nothing",
    async () => {
      const movements = async () => {
        const [row] = await fixtureSql<{ total: string }[]>`
          select count(*)::text as total from transactions
          where from_account_id = ${scope.assetAccountId}
            and to_account_id = ${accountId}`;

        return row.total;
      };

      const before = await movements();
      const result = await recordDebtPaymentAction({
        fromAccountId: scope.assetAccountId,
        toAccountId: accountId,
        amount: "0",
        occurredAt: today,
      });

      return { result, before, after: await movements() };
    },
    ({ result, before, after }) => ({
      ok:
        result?.serverError === "installments.errors.paymentInvalid" &&
        after === before,
      detail: `serverError = ${result?.serverError ?? "none"}, movements into the debt ${before} before, ${after} after`,
    }),
  );

  // RF-121, RF-123, RF-124: a card purchase abroad, spent in dollars and not
  // yet billed. Booked on the no-limit debt — never `accountId`, which
  // `getAccountBalances narrows to the ids it is given` already reads as a
  // single-currency account — so its dollar pocket rides beside its peso debt
  // and Q64-Q72 read the two apart.
  await checkWrite(
    "createTransaction books a foreign-currency card purchase as an estimate",
    () =>
      createTransaction({
        fromAccountId: debt.unlimitedAccountId,
        toAccountId: null,
        amountCents: CARD_FOREIGN_CENTS,
        currency: "USD",
        counterAmountCents: CARD_FOREIGN_COUNTER_CENTS,
        counterIsEstimate: true,
        occurredAt: today,
        description: "Harness compra en dólares",
        externalRef: null,
        splits: [{ categoryId: scope.categoryId, amountCents: CARD_FOREIGN_CENTS }],
        labelIds: [],
      }),
    async ({ transactionId }) => {
      keep("transactions", transactionId);
      const estimate = await readColumn<boolean>("transactions", "id", transactionId, "counter_is_estimate");
      const stored = await readColumn<string | number>("transactions", "id", transactionId, "amount_cents");
      return {
        ok: estimate === true && Number(stored) === CARD_FOREIGN_CENTS,
        detail: `movement ${transactionId}, amount_cents = ${stored}, counter_is_estimate = ${estimate}`,
      };
    },
  );

  await checkWrite(
    "issueWebhookCredential",
    () =>
      issueWebhookCredential({
        name: "Harness shortcut",
        defaultAccountId: scope.assetAccountId,
        defaultCategoryId: scope.categoryId,
      }),
    ({ id, token }) => {
      keep("webhook_credentials", id);
      // The plaintext is never printed: this return is the only moment it exists.
      return { ok: token.startsWith("whk_"), detail: `credential ${id}` };
    },
  );

  const movement = await checkWrite(
    "createTransaction",
    () =>
      createTransaction({
        fromAccountId: scope.assetAccountId,
        toAccountId: null,
        amountCents: 2500000,
        occurredAt: today,
        description: "Harness mercado",
        externalRef: null,
        splits: [{ categoryId: scope.categoryId, amountCents: 2500000 }],
        labelIds: [scope.labelId],
      }),
    async ({ transactionId }) => {
      keep("transactions", transactionId);
      const kind = await readColumn<string>("transactions", "id", transactionId, "kind");
      const stored = await readColumn<string | number>("transactions", "id", transactionId, "amount_cents");
      return {
        ok: kind === "expense" && Number(stored) === 2500000,
        detail: `movement ${transactionId}, kind = ${kind}, amount_cents = ${stored}`,
      };
    },
  );

  const transactionId = movement?.transactionId ?? randomUUID();

  await checkWrite(
    "updateTransaction",
    () =>
      updateTransaction({
        transactionId,
        fromAccountId: scope.assetAccountId,
        toAccountId: null,
        amountCents: 2700000,
        occurredAt: today,
        description: "Harness mercado corregido",
        splits: [{ categoryId: scope.categoryId, amountCents: 2700000 }],
        labelIds: [],
      }),
    async (updated) => {
      const stored = await readColumn<string | number>("transactions", "id", transactionId, "amount_cents");
      return {
        ok: updated === "done" && Number(stored) === 2700000,
        detail: `updated = ${updated}, amount_cents = ${stored}`,
      };
    },
  );

  await checkWrite(
    "deleteTransaction",
    () => deleteTransaction({ transactionId }),
    async (deleted) => {
      const stillThere = (await readColumn("transactions", "id", transactionId, "id")) !== undefined;
      return {
        ok: deleted === "done" && !stillThere,
        detail: `deleted = ${deleted}, row still there = ${stillThere}`,
      };
    },
  );

  const withdrawal = await checkWrite(
    "withdrawCash",
    () =>
      withdrawCash({
        sourceAccountId: scope.assetAccountId,
        amountCents: 500000,
        cashAccountName: "Efectivo",
      }),
    async (result) => {
      keep("transactions", result.transactionId);
      if (result.createdCashAccount) keep("accounts", result.targetCashAccountId);
      const kind = await readColumn<string>("transactions", "id", result.transactionId, "kind");
      const stored = await readColumn<string | number>("transactions", "id", result.transactionId, "amount_cents");
      const targetSubtype = await readColumn<string>("accounts", "id", result.targetCashAccountId, "subtype");
      return {
        ok: kind === "transfer" && Number(stored) === 500000 && targetSubtype === "cash",
        detail: `movement ${result.transactionId}, cash account created = ${result.createdCashAccount}, target subtype = ${targetSubtype}, kind = ${kind}, amount_cents = ${stored}`,
      };
    },
  );

  // RF-99: the shape memory and the deliveries it discarded move in one statement. The
  // read-back is the whole promise — two silenced deliveries back in the queue with the
  // flag cleared, and the rejection this person made still standing.
  await checkWrite(
    "restoreShape",
    () => restoreShape({ shapeId: silenced.shapeId }),
    async ({ deliveriesRestored }) => {
      const [row] = await fixtureSql<
        { shapes: string; queued: string; human: string | null }[]
      >`
        select
          (select count(*)::text from ingest_shapes
             where id = ${silenced.shapeId}) as shapes,
          (select count(*)::text from ingest_deliveries
             where id in ${fixtureSql(silenced.silencedIds)}
               and status = 'pending' and silenced_on_arrival = false) as queued,
          (select status from ingest_deliveries
             where id = ${silenced.humanRejectedId}) as human`;

      return {
        ok:
          deliveriesRestored === 2 &&
          row.shapes === "0" &&
          row.queued === "2" &&
          row.human === "rejected",
        detail: `restored ${deliveriesRestored} deliveries, ${row.shapes} memories left, ${row.queued} of 2 back in the queue unflagged, the person's own rejection still ${row.human}`,
      };
    },
  );

  // The contract names this `setUserLocale`; the module exports `upsertUserLocale`.
  await checkWrite(
    "upsertUserLocale",
    () => upsertUserLocale("en"),
    async () => ({
      ok: (await readColumn("app_users", "id", userId, "locale")) === "en",
      detail: `locale = ${await readColumn("app_users", "id", userId, "locale")}`,
    }),
  );

  // RF-56 from the side that has to write something: `per_member` names no shared pot, so the
  // switch to `shared` has to land one — and the second call has to find it rather than add a
  // second, which is what `withdrawCash` needs to keep hitting the same account. Last in the
  // suite: it changes where the group's cash sits, and every path above reads that.
  await checkWrite(
    "updateGroupSettings",
    async () => {
      const settings = {
        groupId: scope.groupId,
        name: "Harness fondo compartido",
        cashMode: "shared",
        locale: "es",
      } as const;
      const cashAccounts = async () =>
        fixtureSql<{ id: string }[]>`
          select id from accounts
          where group_id = ${scope.groupId} and subtype = 'cash' and archived_at is null`;

      const first = await updateGroupSettings(settings);
      const afterFirst = await cashAccounts();
      const second = await updateGroupSettings(settings);
      const afterSecond = await cashAccounts();
      for (const row of afterSecond) keep("accounts", row.id);

      return { first, second, afterFirst, afterSecond };
    },
    async ({ first, second, afterFirst, afterSecond }) => ({
      ok:
        first &&
        second &&
        afterFirst.length === 1 &&
        afterSecond.length === 1 &&
        afterSecond[0].id === afterFirst[0].id,
      detail: `both calls admitted = ${first && second}, ${afterFirst.length} cash account after the first and ${afterSecond.length} after the second, the same one = ${afterSecond[0]?.id === afterFirst[0]?.id}, cash_mode = ${await readColumn("groups", "id", scope.groupId, "cash_mode")}`,
    }),
  );

  return {
    accountId: account?.accountId ?? null,
    transactionId: movement?.transactionId ?? null,
    withdrawalId: withdrawal?.transactionId ?? null,
    usdAccountId: usdAccount?.accountId ?? null,
    groupUsdAccountId: groupUsdAccount?.accountId ?? null,
    contributionTransactionId: contribution?.transactionId ?? null,
    usdCategoryId: categoryId,
  };
}

/**
 * Suite Q-read: every screen-level read, each called with its real argument
 * shape. A wrong shape is a false failure — a `{start, endExclusive}` window
 * passed as a string reports a bogus syntax error — so each call mirrors the
 * signature, not a guess at it.
 */
async function readSuite(
  userId: string,
  scope: HarnessScope,
  writes: WriteResults,
  silenced: SilencedFixtures,
  debt: DebtFixture,
  groupless: HarnessUser,
  fellow: HarnessUser,
): Promise<void> {
  const personal = { ownerUserId: userId } as const;
  const debtAccountId = writes.accountId ?? scope.liabilityAccountId;

  // RF-124: net worth per owner, folded again by currency alone — the fund's
  // own total (RF-88) never adds the run's dollar pocket to its peso one, and
  // this month's flow keeps the same split.
  await checkReadValue(
    "getDashboardData splits net worth and this month's flow by currency",
    () => getDashboardData(),
    (dashboard) => {
      const memberUsd = dashboard.netWorth.find(
        (bucket) =>
          bucket.bucket === "member" &&
          bucket.ownerUserId === userId &&
          bucket.currency === "USD",
      );
      const totalUsd = dashboard.totalNetWorth.find((total) => total.currency === "USD");
      const totalCop = dashboard.totalNetWorth.find(
        (total) => total.currency === BASE_CURRENCY,
      );
      const usdFlow = dashboard.monthFlow.find((flow) => flow.currency === "USD");

      return {
        ok:
          memberUsd?.netWorthCents === -USD_OWED_AND_SPENT_CENTS &&
          totalUsd?.netWorthCents === FUND_USD_NET_WORTH_CENTS &&
          totalCop !== undefined &&
          usdFlow?.expenseCents === USD_OWED_AND_SPENT_CENTS &&
          usdFlow.incomeCents === 0,
        detail: `the leader's dollar bucket reads ${memberUsd?.netWorthCents ?? "no"} cents against the expected ${-USD_OWED_AND_SPENT_CENTS}; the fund's dollar total ${totalUsd?.netWorthCents ?? "no"} against the expected ${FUND_USD_NET_WORTH_CENTS}; the peso total reads ${totalCop?.netWorthCents ?? "no"} cents; this month's dollar flow spent ${usdFlow?.expenseCents ?? "no"} of the expected ${USD_OWED_AND_SPENT_CENTS}`,
      };
    },
  );
  await checkRead("getReportsData", () => getReportsData());
  await checkReadValue(
    "getMonthlyFlow keeps this month's dollars out of the peso row",
    () => getMonthlyFlow(currentMonthRange()),
    (rows) => {
      const usd = rows.find((row) => row.currency === "USD");
      const cop = rows.find((row) => row.currency === BASE_CURRENCY);

      return {
        ok:
          usd?.expenseCents === USD_OWED_AND_SPENT_CENTS &&
          usd.incomeCents === 0 &&
          usd.netCents === -USD_OWED_AND_SPENT_CENTS &&
          cop !== undefined &&
          cop.expenseCents !== usd.expenseCents,
        detail: `dollars this month: income ${usd?.incomeCents ?? "no"}, expense ${usd?.expenseCents ?? "no"} against the expected ${USD_OWED_AND_SPENT_CENTS}; pesos this month spent ${cop?.expenseCents ?? "no"} of their own`,
      };
    },
  );
  await checkReadValue(
    "getSixMonthFlow never mixes a currency's series with another's",
    () => getSixMonthFlow(),
    (rows) => {
      const monthStarts = lastSixMonthStarts();
      const currentMonth = monthStarts[monthStarts.length - 1];
      const usdRows = rows.filter((row) => row.currency === "USD");
      const copRows = rows.filter((row) => row.currency === BASE_CURRENCY);
      const currentUsd = usdRows.find((row) => row.monthStart === currentMonth);
      const priorMonthsFlat = usdRows
        .filter((row) => row.monthStart !== currentMonth)
        .every((row) => row.incomeCents === 0 && row.expenseCents === 0);

      return {
        ok:
          usdRows.length === 6 &&
          copRows.length === 6 &&
          currentUsd?.expenseCents === USD_OWED_AND_SPENT_CENTS &&
          priorMonthsFlat,
        detail: `${usdRows.length} dollar months of 6, the current one spent ${currentUsd?.expenseCents ?? "no"} of the expected ${USD_OWED_AND_SPENT_CENTS}, the other five flat = ${priorMonthsFlat}; ${copRows.length} peso months of 6`,
      };
    },
  );
  await checkReadValue(
    "getExpensesByCategory answers one row per category and currency",
    () => getExpensesByCategory(currentMonthRange()),
    (rows) => {
      const dollarExpense = rows.find(
        (row) => row.currency === "USD" && row.categoryId === writes.usdCategoryId,
      );
      const dollarPurchase = rows.find(
        (row) => row.currency === "USD" && row.categoryId === scope.categoryId,
      );

      return {
        ok:
          dollarExpense?.totalCents === USD_EXPENSE_CENTS &&
          dollarPurchase?.totalCents === CARD_FOREIGN_CENTS,
        detail: `"${dollarExpense?.name ?? "no category"}" in dollars totals ${dollarExpense?.totalCents ?? "no"} against ${USD_EXPENSE_CENTS}; the card's own category in dollars totals ${dollarPurchase?.totalCents ?? "no"} against ${CARD_FOREIGN_CENTS}, so the two never fold into one row`,
      };
    },
  );
  await checkReadValue(
    "getMemberContributions counts what the pot received in its own currency",
    () => getMemberContributions(currentMonthRange()),
    (rows) => {
      const mine = rows.find((row) => row.userId === userId && row.currency === "USD");

      return {
        ok: mine?.contributionCents === CONTRIBUTION_USD_CENTS,
        detail: `the leader's dollar contribution reads ${mine?.contributionCents ?? "no"} cents against the confirmed ${CONTRIBUTION_USD_CENTS}`,
      };
    },
  );

  // The contribution is group-scoped (its to-account is the pot), so
  // `purgeIdentity(userId)` never reaches it through `owner_user_id` — it deletes
  // `transactions` before it deletes `groups`, and only the group's cascade would
  // otherwise take this row. Left in place, it still names `scope.assetAccountId`
  // when `purgeIdentity` reaches that account, and the RESTRICT fires. Nothing
  // below this line reads it, so it is dropped here, under the same claims
  // `purgeAuditTrail([...dropped])` already reaches at the end of the run.
  const contributionTransactionId = writes.contributionTransactionId;
  if (contributionTransactionId) {
    await asOwner(userId, async (tx) => {
      await tx`delete from transactions where id = ${contributionTransactionId}`;
    });
  }

  // A pure reducer over two reads, not a round trip of its own.
  await checkReadValue(
    "netWorthByOwner answers one bucket per owner and currency",
    async () =>
      netWorthByOwner(await listAccounts({ archived: false }), await getAccountBalances()),
    (buckets) => {
      const mine = buckets.filter(
        (bucket) => bucket.bucket === "member" && bucket.ownerUserId === userId,
      );
      const usd = mine.find((bucket) => bucket.currency === "USD");
      const cop = mine.find((bucket) => bucket.currency === BASE_CURRENCY);

      return {
        ok: mine.length === 2 && usd?.netWorthCents === -USD_OWED_AND_SPENT_CENTS && cop !== undefined,
        detail: `${mine.length} bucket(s) for this owner; dollars read ${usd?.netWorthCents ?? "no"} against ${-USD_OWED_AND_SPENT_CENTS}, pesos read ${cop?.netWorthCents ?? "no"}`,
      };
    },
  );
  await checkRead("getAccountBalances", () => getAccountBalances());
  await checkRead("listTransactions", () => listTransactions({}, { limit: 20 }));
  await checkRead("getTransactionById", () =>
    getTransactionById(writes.withdrawalId ?? randomUUID()),
  );
  await checkRead("getTransactionFormOptions", () => getTransactionFormOptions());
  await checkRead("getLastUsedAccountId", () => getLastUsedAccountId());
  await checkRead("listAccounts", () => listAccounts({ archived: false }));
  await checkRead("listCategories", () => listCategories(personal, "expense"));
  await checkRead("listParentCategories", () =>
    listParentCategories(personal, "expense"),
  );
  await checkRead("listUsedCategoryColors", () => listUsedCategoryColors(personal));
  await checkRead("listLabels", () => listLabels(personal));
  await checkRead("listManagedLabels", () => listManagedLabels(personal));
  await checkRead("listUsedLabelColors", () => listUsedLabelColors(personal));
  await checkRead("listMembers", () =>
    listMembers(scope.groupId, { archived: false }),
  );
  await checkRead("listBudgetsWithStatus", () => listBudgetsWithStatus());
  await checkRead("listGoalsWithProgress", () => listGoalsWithProgress());
  await checkRead("listPlannedPayments", () => listPlannedPayments());
  await checkRead("listRecurringRules", () => listRecurringRules());
  await checkRead("countUnreviewedGenerated", () => countUnreviewedGenerated());
  await checkRead("getDebtsScreenData", () => getDebtsScreenData());
  await checkRead("getDebtOverview", () => getDebtOverview());
  // The screen fans four reads out (RNF-09); the count is what says they never
  // chained and never went one read per debt — the writability of every debt
  // rides the roster's own projection, not a statement of its own. The first call
  // is unmeasured on
  // purpose: the driver counts the statements that open a connection too, and the
  // fan-out opens as many as it has reads.
  await checkReadValue(
    "getDebtsScreenData costs one round trip per fanned-out read",
    async () => {
      await getDebtsScreenData();
      const unitBefore = roundTrips();
      await getAccountBalances();
      const unit = roundTrips() - unitBefore;

      const before = roundTrips();
      await getDebtsScreenData();

      return { unit, trips: roundTrips() - before };
    },
    ({ unit, trips }) => ({
      ok: trips === unit * 4,
      detail: `${trips} round trips for the screen, ${unit} for a single read`,
    }),
  );

  // RF-117: the summed limit and the summed available cover exactly the debts that
  // carry a limit. The one without a limit owes, so counting it as a zero would
  // drag the available below the figure asserted here.
  await checkReadValue(
    "getDebtsScreenData sums the credit of the debts that carry a limit",
    async () => {
      const [screen, balances] = await Promise.all([
        getDebtsScreenData(),
        getAccountBalances([debtAccountId]),
      ]);

      return { screen, owedCents: Math.abs(balances[0]?.balanceCents ?? 0) };
    },
    ({ screen, owedCents }) => {
      const limited = screen.withTerms.find((row) => row.accountId === debtAccountId);
      const unlimited = screen.withTerms.find(
        (row) => row.accountId === debt.unlimitedAccountId,
      );

      return {
        ok:
          limited?.creditLimitCents === CREDIT_LIMIT_CENTS &&
          unlimited?.creditLimitCents === null &&
          unlimited.owedCents > 0 &&
          screen.totals.creditLimitCents === CREDIT_LIMIT_CENTS &&
          screen.totals.availableCreditCents === CREDIT_LIMIT_CENTS - owedCents,
        detail: `${screen.withTerms.length} debts with terms, limit summed ${screen.totals.creditLimitCents} of ${CREDIT_LIMIT_CENTS}, available ${screen.totals.availableCreditCents} against ${CREDIT_LIMIT_CENTS - owedCents}; the debt with no limit owes ${unlimited?.owedCents ?? "no row"} and reports a limit of ${unlimited?.creditLimitCents ?? "null"}`,
      };
    },
  );

  // RF-79: the rate the row states is the twelfth root of the annual one, not the
  // linear twelfth, and it is the very rate the interest figure was struck at —
  // the screen reads the percentage off this and divides nothing.
  await checkReadValue(
    "getDebtOverview states the effective monthly rate its interest was struck at",
    async () => {
      const [overview, annualRate] = await Promise.all([
        getDebtOverview(),
        readColumn<string>(
          "debt_terms",
          "account_id",
          debt.unlimitedAccountId,
          "annual_rate",
        ),
      ]);

      return { overview, annual: Number(annualRate) };
    },
    ({ overview, annual }) => {
      const row = overview.find(
        (candidate) => candidate.accountId === debt.unlimitedAccountId,
      );
      if (row === undefined) return { ok: false, detail: "the debt reports no row" };

      const compounded = (1 + row.monthlyRatePct) ** 12 - 1;

      return {
        ok:
          Math.abs(compounded - annual) < 1e-9 &&
          row.monthlyRatePct !== annual / 12 &&
          row.monthlyInterestCents === Math.round(row.owedCents * row.monthlyRatePct),
        detail: `rate ${row.monthlyRatePct} compounds to ${compounded} against the stored ${annual}, the linear twelfth being ${annual / 12}; ${row.monthlyInterestCents} cents of interest against ${Math.round(row.owedCents * row.monthlyRatePct)} on ${row.owedCents} owed`,
      };
    },
  );

  // RF-121, RF-124: the debt now holds a dollar pocket beside its peso one
  // (`0032_one_balance_per_currency.sql`'s `account_balances` answers one row
  // per account AND currency). `pockets` in `debt-overview.ts` folds that
  // 1:N back to one row per account before the join to `debt_terms` — this is
  // what the length check catches if it ever regresses to the naive join the
  // comment there warns against, which answered the debt once per currency
  // and would have doubled its owed, its limit and its interest with every
  // other liability that ever holds two.
  await checkReadValue(
    "getDebtOverview answers one row per account even when it holds two currencies",
    () => getDebtOverview(),
    (overview) => {
      const rows = overview.filter(
        (candidate) => candidate.accountId === debt.unlimitedAccountId,
      );
      const [row] = rows;
      const foreign = row?.otherOwed.find((pocket) => pocket.currency === "USD");

      return {
        ok:
          rows.length === 1 &&
          row?.currency === BASE_CURRENCY &&
          foreign?.owedCents === CARD_FOREIGN_CENTS &&
          row.otherOwed.length === 1,
        detail: `${rows.length} row(s) for the debt against the 1 a 1:1 join would answer; its own pocket is in ${row?.currency ?? "no currency"}, its dollar pocket owes ${foreign?.owedCents ?? "no"} cents against the expected ${CARD_FOREIGN_CENTS}, of ${row?.otherOwed.length ?? 0} foreign pocket(s)`,
      };
    },
  );

  // RF-124: the screen's consolidated totals carry the dollar pocket in its
  // own set, never folded into the peso figures the flat `totals` above read.
  await checkReadValue(
    "getDebtsScreenData totals the dollar pocket the card holds beside its peso debt",
    () => getDebtsScreenData(),
    (screen) => {
      const usd = screen.totals.byCurrency.find((set) => set.currency === "USD");
      const cop = screen.totals.byCurrency.find((set) => set.currency === BASE_CURRENCY);

      return {
        ok:
          usd?.owedCents === CARD_FOREIGN_CENTS &&
          usd.debtCount === 1 &&
          usd.monthlyInterestCents === 0 &&
          cop !== undefined &&
          screen.totals.currency === BASE_CURRENCY,
        detail: `dollar set owes ${usd?.owedCents ?? "no"} cents across ${usd?.debtCount ?? 0} debt(s) against the expected ${CARD_FOREIGN_CENTS} on 1; peso set owes ${cop?.owedCents ?? "no"}; the flat totals read in ${screen.totals.currency}`,
      };
    },
  );

  // RF-16: the source picker is filtered out of the roster the screen already
  // read, and a debt is never paid from another debt.
  await checkReadValue(
    "getDebtsScreenData offers every live asset to pay from, and no liability",
    async () => {
      const [screen, accounts] = await Promise.all([
        getDebtsScreenData(),
        listAccounts({ archived: false }),
      ]);

      return { screen, accounts };
    },
    ({ screen, accounts }) => {
      const kindById = new Map(accounts.map((account) => [account.id, account.kind]));
      const assets = accounts.filter((account) => account.kind === "asset");
      const offered = screen.payFrom.filter(
        (source) => kindById.get(source.id) !== "asset",
      );

      return {
        ok: offered.length === 0 && screen.payFrom.length === assets.length,
        detail: `${screen.payFrom.length} sources offered against ${assets.length} live assets, ${offered.length} of them not an asset`,
      };
    },
  );

  // RF-83: the tile names the debt the earliest due date belongs to — by id as
  // well as by name, since the badge on the table's row is placed by the id — and
  // its figure is that debt's minimum plus the installments falling due by then.
  await checkReadValue(
    "getDebtsScreenData names the debt behind the next payment",
    () => getDebtsScreenData(),
    (screen) => {
      const dated = screen.withTerms.filter((row) => row.nextDueDate !== null);
      const earliest = dated.reduce<(typeof dated)[number] | null>(
        (soonest, row) =>
          soonest !== null && (soonest.nextDueDate ?? "") <= (row.nextDueDate ?? "")
            ? soonest
            : row,
        null,
      );
      const expected =
        earliest === null
          ? null
          : (earliest.minimumPaymentCents ?? 0) + earliest.dueInstallmentsCents;
      const tile = screen.totals.nextPayment;

      return {
        ok:
          earliest !== null &&
          tile?.accountId === earliest.accountId &&
          tile.name === earliest.name &&
          tile.date === earliest.nextDueDate &&
          tile.amountCents === expected,
        detail: `${tile?.amountCents ?? "no"} cents due on ${tile?.date ?? "no date"} on "${tile?.name ?? "no debt"}" (${tile?.accountId ?? "no account"}), against ${expected ?? "no"} cents on "${earliest?.name ?? "no debt"}" (${earliest?.accountId ?? "no account"}) of the ${dated.length} dated debts`,
      };
    },
  );

  // RF-83, RF-79: the consolidated rate is struck on the same balance the tile
  // above it states — the no-terms debts included — so applying it to that total
  // gives back the summed interest to the cent. An average of the rows' rates, or
  // a rate struck over the debts that carry terms alone, would not.
  await checkReadValue(
    "getDebtsScreenData states the rate its summed interest was struck at",
    () => getDebtsScreenData(),
    (screen) => {
      const { owedCents, monthlyInterestCents, monthlyRatePct } = screen.totals;
      const struck = Math.round(owedCents * monthlyRatePct);
      const withTermsOwed = screen.withTerms.reduce(
        (sum, row) => sum + row.owedCents,
        0,
      );
      const highest = screen.withTerms.reduce(
        (top, row) => Math.max(top, row.monthlyRatePct),
        0,
      );

      return {
        ok:
          monthlyRatePct > 0 &&
          Math.abs(struck - monthlyInterestCents) <= 1 &&
          // A no-terms debt owes in this fund, so the two denominators differ and
          // the assertion above is the one that tells them apart.
          withTermsOwed < owedCents &&
          monthlyRatePct < highest,
        detail: `rate ${monthlyRatePct} on ${owedCents} owed gives ${struck} cents against the summed ${monthlyInterestCents}; ${withTermsOwed} of that balance carries terms, and the dearest debt is at ${highest}`,
      };
    },
  );

  // RF-58, RF-100: the writability every surface of the screen reads, driven by a
  // fellow member who really cannot write — not by a fabricated boolean. The same
  // caller's INSERT is refused by the policy, so the flag and the database agree.
  await checkReadValue(
    "getDebtsScreenData reports the writability the policies would admit",
    async () => {
      const mine = await getDebtsScreenData();
      const theirs = await asUser(fellow, () => getDebtsScreenData());

      let refused: string | null = null;
      try {
        const { planId } = await asUser(fellow, () =>
          createInstallmentPlan({
            accountId: debtAccountId,
            description: "Harness plan a member may not write",
            principalCents: 300000,
            nInstallments: 3,
            frequency: "monthly",
            interestRate: null,
            downPaymentCents: null,
            avalCents: null,
            startDate: todayInBogota(),
            merchant: null,
            lines: [],
          }),
        );
        // It landed, which is the failure this assertion is here to catch; the
        // row is tracked so the run still drops what it wrote.
        track("installment_plans", planId);
      } catch (error) {
        refused = pgErrorCode(error) ?? "none";
      }

      return { mine, theirs, refused };
    },
    ({ mine, theirs, refused }) => {
      const rows = (screen: DebtsScreenData) => [
        ...screen.withTerms,
        ...screen.withoutTerms,
      ];
      const owned = rows(mine);
      const read = rows(theirs);
      const seenByBoth = read.filter((row) =>
        owned.some((own) => own.accountId === row.accountId),
      );

      return {
        ok:
          owned.length > 0 &&
          owned.every((row) => row.canWrite) &&
          // The member reads every one of them and writes none.
          seenByBoth.length === owned.length &&
          read.every((row) => !row.canWrite) &&
          refused === "42501",
        detail: `the owner writes ${owned.filter((row) => row.canWrite).length} of ${owned.length} debts; the member reads ${seenByBoth.length} of them and writes ${read.filter((row) => row.canWrite).length}, and her plan was refused with ${refused ?? "nothing"}`,
      };
    },
  );

  // RF-82: the position a debt's lines add up to, read across its plans. The
  // write suite closed one of the card's three lines with a movement.
  await checkReadValue(
    "listPlanPositions states the paid-down card's position",
    () => listPlanPositions(),
    (positions) => {
      const card = positions.find((position) => position.accountId === debtAccountId);

      return {
        ok:
          card?.linesTotal === 3 &&
          card.linesPaid === 1 &&
          card.pendingCents === CARD_LINE_CENTS * 2 &&
          card.nextDueDate === todayInBogota() &&
          card.nextAmountCents === CARD_LINE_CENTS,
        detail: `${card?.linesPaid ?? "no"} of ${card?.linesTotal ?? "no"} lines paid, ${card?.pendingCents ?? "no"} cents pending, next ${card?.nextAmountCents ?? "no"} cents on ${card?.nextDueDate ?? "no date"}`,
      };
    },
  );

  // A plan sits on any liability: one whose account carries no `debt_terms` row
  // still has a position to state (RF-81).
  await checkReadValue(
    "listPlanPositions states the position of a debt with no terms",
    async () => {
      const [positions, terms] = await Promise.all([
        listPlanPositions(),
        getDebtTerms(scope.liabilityAccountId),
      ]);

      return { positions, terms };
    },
    ({ positions, terms }) => {
      const plan = positions.find(
        (position) => position.accountId === scope.liabilityAccountId,
      );

      return {
        ok:
          terms === null &&
          plan?.linesTotal === 3 &&
          plan.linesPaid === 2 &&
          plan.pendingCents === PLAN_LINE_CENTS &&
          plan.nextDueDate === debt.dueDates[2] &&
          plan.nextAmountCents === PLAN_LINE_CENTS,
        detail: `terms = ${terms === null ? "none" : "some"}, ${plan?.linesPaid ?? "no"} of ${plan?.linesTotal ?? "no"} lines paid, ${plan?.pendingCents ?? "no"} cents pending, next ${plan?.nextAmountCents ?? "no"} cents on ${plan?.nextDueDate ?? "no date"}`,
      };
    },
  );

  // The policies are the whole scope: a debt outside the caller's is absent, not
  // refused, and so is an account that is no liability.
  await checkReadValue(
    "getDebtDetail is null for another identity and for an asset",
    async () => ({
      stranger: await asUser(groupless, () => getDebtDetail(debt.unlimitedAccountId)),
      asset: await getDebtDetail(scope.assetAccountId),
    }),
    ({ stranger, asset }) => ({
      ok: stranger === null && asset === null,
      detail: `the second identity reads ${stranger === null ? "null" : "the debt"}, the asset reads ${asset === null ? "null" : "a debt"}`,
    }),
  );

  // The narrowing argument no caller has ever passed: it rendered as a record
  // cast to an array and was unusable at every arity (RNF-07).
  await checkReadValue(
    "getAccountBalances narrows to the ids it is given",
    async () => {
      const asked = [scope.assetAccountId, debtAccountId];
      const [all, narrowed] = await Promise.all([
        getAccountBalances(),
        getAccountBalances(asked),
      ]);

      return { asked, all, narrowed };
    },
    ({ asked, all, narrowed }) => {
      const byId = new Map(all.map((row) => [row.accountId, row.balanceCents]));
      const same = narrowed.every(
        (row) => byId.get(row.accountId) === row.balanceCents,
      );

      return {
        ok:
          narrowed.length === asked.length &&
          asked.every((id) => narrowed.some((row) => row.accountId === id)) &&
          same,
        detail: `${narrowed.length} of the ${all.length} accounts came back for ${asked.length} ids, every balance the same as unnarrowed = ${same}`,
      };
    },
  );

  // RF-121, RF-124: `listAccounts` reads every balance through a correlated
  // subquery, never a join to the view — a join would answer the account once
  // per currency it holds, the same 1:N `getDebtOverview` folds back with its
  // own `pockets` CTE.
  await checkReadValue(
    "listAccounts answers one row for a debt holding two currencies",
    () => listAccounts({ archived: false }),
    (accounts) => {
      const rows = accounts.filter(
        (account) => account.id === debt.unlimitedAccountId,
      );
      const [account] = rows;
      const settlement = account?.balances[0];
      const foreign = account?.balances.find((balance) => balance.currency === "USD");

      return {
        ok:
          rows.length === 1 &&
          account?.balances.length === 2 &&
          settlement?.currency === BASE_CURRENCY &&
          foreign?.balanceCents === -CARD_FOREIGN_CENTS,
        detail: `${rows.length} row(s) for the debt, ${account?.balances.length ?? 0} pocket(s) on it, the first in ${settlement?.currency ?? "no currency"}, the dollar one reading ${foreign?.balanceCents ?? "no"} cents against ${-CARD_FOREIGN_CENTS}`,
      };
    },
  );

  await checkRead("getDebtTerms", () => getDebtTerms(debtAccountId));
  await checkRead("listPlansForAccount", () => listPlansForAccount(debtAccountId));
  await checkRead("listAuditLog", () => listAuditLog({ limit: 20, offset: 0 }));
  await checkRead("getAuditFilterOptions", () => getAuditFilterOptions());
  await checkRead("listWebhookCredentials", () => listWebhookCredentials());
  await checkRead("getWebhookCredentialOptions", () => getWebhookCredentialOptions());
  await checkRead("listPendingDeliveries", () => listPendingDeliveries());
  await checkRead("countPendingDeliveries", () => countPendingDeliveries());
  await checkRead("getShellSummary", () => getShellSummary());
  await checkRead("listOwnMerchants", () => listOwnMerchants());
  await checkReadValue(
    "listSilencedShapes",
    () => listSilencedShapes(),
    (shapes) => {
      const listed = shapes.find((shape) => shape.id === silenced.listed.shapeId);
      const restoredStillNamed = shapes.some(
        (shape) => shape.id === silenced.restored.shapeId,
      );

      return {
        ok:
          listed?.silencedCount === 2 &&
          listed.sampleText === silenced.listed.sampleText &&
          !restoredStillNamed,
        detail: `${shapes.length} silenced, the seeded one counts ${listed?.silencedCount ?? "no"} discarded deliveries and samples "${listed?.sampleText ?? "nothing"}"; the restored one is ${restoredStillNamed ? "still named" : "gone"}`,
      };
    },
  );
  await checkRead("readExport", () => readExport({ entityKeys: [...SHEET_ENTITIES] }));
  await checkRead("readImportScope", () => readImportScope());
  await checkRead("getUserLocale", () => getUserLocale());

  // D7: the RF-49 template leaves external_ref blank for a brand-new row, and a
  // blank cell parses to null — not undefined — so `.optional()` refused every
  // new row the template itself offers. No database round trip here: the five
  // row schemas that carry external_ref are pure zod, driven directly rather
  // than through a parsed workbook, to isolate the one column under test.
  await checkReadValue(
    "sheet row schemas accept a blank external_ref cell",
    async () => {
      const today = todayInBogota();
      const rows: { schema: z.ZodType; row: Record<string, unknown> }[] = [
        {
          schema: accountRowSchema,
          row: {
            name: "Harness fila",
            kind: "asset",
            subtype: "bank",
            placement: "personal",
            institution: null,
            lastFour: "",
            amount: "1000",
            balanceOn: today,
          },
        },
        {
          schema: memberRowSchema,
          row: { name: "Harness fila", email: undefined },
        },
        {
          schema: categoryRowSchema,
          row: { name: "Harness fila", kind: "expense", parent: null, color: "#E11D48" },
        },
        {
          schema: recurringRuleRowSchema,
          row: {
            fromAccount: "Harness cuenta",
            toAccount: null,
            amount: "1000",
            category: "Harness categoría",
            description: null,
            frequency: "monthly",
            intervalN: 1,
            dayOfMonth: null,
            nextRunOn: today,
            endsOn: null,
          },
        },
        {
          schema: transactionRowSchema,
          row: {
            fromAccount: "Harness cuenta",
            toAccount: null,
            amount: "1000",
            category: "Harness categoría",
            occurredAt: today,
            description: null,
          },
        },
      ];
      const overlong = "x".repeat(201);

      return rows.map(({ schema, row }) => ({
        blank: schema.safeParse({ ...row, externalRef: null }).success,
        absent: schema.safeParse(row).success,
        overlong: schema.safeParse({ ...row, externalRef: overlong }).success,
      }));
    },
    (results) => {
      const blank = results.filter((row) => row.blank).length;
      const absent = results.filter((row) => row.absent).length;
      const overlongRejected = results.filter((row) => !row.overlong).length;

      return {
        ok: blank === results.length && absent === results.length && overlongRejected === results.length,
        detail: `blank external_ref accepted on ${blank} of ${results.length} row schemas, absent cell accepted on ${absent}, a 201-char external_ref rejected on ${overlongRejected}`,
      };
    },
  );

  // D7 follow-up: the assertion above drives only the light guard, in isolation,
  // as its own comment says. A blank cell also has to clear the authoritative
  // schema — `createTransactionSchema`, the THIRD gate `processRow` runs and the
  // one the movement form itself submits through — which declared its own
  // `externalRef` and kept it `.optional()` after the light guard's went
  // `.nullish()`. That gap left the RF-49 template's blank-reference row failing
  // in the app with a generic invalidCell while this file read 100/0.
  await checkReadValue(
    "a blank external_ref clears the authoritative transaction schema too",
    async () => {
      const guarded = transactionRowSchema.safeParse({
        externalRef: null,
        fromAccount: "Harness cuenta",
        toAccount: null,
        amount: "1000",
        category: "Harness categoría",
        occurredAt: todayInBogota(),
        description: null,
      });
      if (!guarded.success) return { guardedOk: false, authoritativeOk: false };

      // The shape `resolveAndShape` hands the authoritative schema once names
      // resolve to ids (RF-51's second gate) — an expense, one split, the light
      // guard's own `externalRef` riding through unchanged.
      const authoritative = createTransactionSchema.safeParse({
        fromAccountId: randomUUID(),
        toAccountId: null,
        amount: guarded.data.amount,
        occurredAt: guarded.data.occurredAt,
        description: guarded.data.description,
        externalRef: guarded.data.externalRef,
        splits: [{ categoryId: randomUUID(), amount: guarded.data.amount }],
        labelIds: [],
      });

      return { guardedOk: guarded.success, authoritativeOk: authoritative.success };
    },
    ({ guardedOk, authoritativeOk }) => ({
      ok: guardedOk && authoritativeOk,
      detail: `light guard ${guardedOk ? "accepted" : "refused"} the blank cell, authoritative schema ${authoritativeOk ? "accepted" : "refused"} it`,
    }),
  );
}

// The two modules that name a message key for an installment plan or a debt
// payment: the schema the form and the server share, and the action that maps the
// database's refusals onto keys.
const INSTALLMENT_KEY_SOURCES = [
  "lib/validation/installment-plan.ts",
  "app/actions/installment-plans.ts",
];

// Every `installments.*` literal a module names, trailing sentence punctuation
// dropped so a key inside a comment reads the same as one inside a string.
function namedInstallmentKeys(): string[] {
  const found = INSTALLMENT_KEY_SOURCES.flatMap((file) =>
    [...readFileSync(resolve(file), "utf8").matchAll(/installments\.[A-Za-z0-9_.]+/g)].map(
      (match) => match[0].replace(/\.+$/, ""),
    ),
  );

  return [...new Set(found)].sort();
}

// The leaf key paths under a message subtree, so two locales can be compared as
// sets rather than one string at a time.
function leafKeys(value: unknown, prefix: string): string[] {
  if (typeof value !== "object" || value === null) return [prefix];

  return Object.entries(value).flatMap(([key, child]) =>
    leafKeys(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

function translation(messages: object, key: string): string | undefined {
  const found = key.split(".").reduce<unknown>(
    (node, part) =>
      typeof node === "object" && node !== null && part in node
        ? (node as Record<string, unknown>)[part]
        : undefined,
    messages,
  );

  return typeof found === "string" ? found : undefined;
}

/**
 * Suite Q-invariant: three §2 facts, read back from rows THIS run wrote through
 * the real functions, then RF-55's one-membership rule, proven by the refusal it
 * raises. A refused write leaves nothing to read, so a read-back assertion skips
 * rather than passing on an absent row.
 */
async function invariantSuite(
  writes: WriteResults,
  restored: SilencedFixture,
): Promise<void> {
  const negativeOpening = next("a liability's opening balance is stored negative");
  if (writes.accountId === null) {
    skip(negativeOpening, "createAccount was refused, so no row was written");
  } else {
    const cents = await readColumn<string>(
      "accounts",
      "id",
      writes.accountId,
      "initial_balance_cents",
    );
    assert(
      negativeOpening,
      Number(cents) < 0,
      `initial_balance_cents = ${cents} for a liability opened at 1800 pesos`,
    );
  }

  const derivedKind = next("a movement's kind is the one its accounts imply");
  if (writes.withdrawalId === null) {
    skip(derivedKind, "withdrawCash was refused, so no movement was written");
  } else {
    const [row] = await fixtureSql<
      { kind: string; from_account_id: string | null; to_account_id: string | null }[]
    >`
      select kind, from_account_id, to_account_id
      from transactions where id = ${writes.withdrawalId}`;
    // No caller named `kind`: the column is generated, and the withdrawal names
    // both ends, which is what makes it a transfer.
    assert(
      derivedKind,
      row.kind === "transfer" &&
        row.from_account_id !== null &&
        row.to_account_id !== null,
      `kind = ${row.kind}, from = ${row.from_account_id !== null}, to = ${row.to_account_id !== null}`,
    );
  }

  // RF-101, on the schema side: the database refuses the pair with a check
  // constraint, and the very schema the form binds to refuses it first, with a
  // message. Same schema on both ends of the action (RNF-10), so one parse
  // proves the form and the server together.
  const selfTransfer = next("the shared schema refuses a transfer to the same account");
  const sameAccount = writes.accountId ?? randomUUID();
  const parsed = createTransactionSchema.safeParse({
    fromAccountId: sameAccount,
    toAccountId: sameAccount,
    amount: "10000",
    occurredAt: todayInBogota(),
    description: null,
    splits: [],
    labelIds: [],
  });
  const issues = parsed.success ? [] : parsed.error.issues;
  const sameIssue = issues.find(
    (issue) => issue.message === "transactions.errors.accountSame",
  );
  assert(
    selfTransfer,
    sameIssue !== undefined &&
      sameIssue.path.join(".") === "toAccountId" &&
      es.transactions.errors.accountSame.length > 0 &&
      en.transactions.errors.accountSame.length > 0,
    parsed.success
      ? "the payload parsed, which it must not"
      : `${issues.length} issue(s), accountSame at path ${sameIssue?.path.join(".") ?? "none"}, es "${es.transactions.errors.accountSame}", en "${en.transactions.errors.accountSame}"`,
  );

  // Every key the debt schema and the debt action can hand a form is a string a
  // person reads, in both locales — a key that resolves in one and not the other
  // is a screen that shows the key itself.
  const installmentKeys = next("every installments key the schema and the action name reads");
  const named = namedInstallmentKeys();
  const untranslated = named.filter(
    (key) => translation(es, key) === undefined || translation(en, key) === undefined,
  );
  const esKeys = leafKeys(es.installments, "installments");
  const enKeys = leafKeys(en.installments, "installments");
  assert(
    installmentKeys,
    named.length > 0 &&
      untranslated.length === 0 &&
      esKeys.sort().join(",") === enKeys.sort().join(","),
    `${named.length} keys named, ${untranslated.length} untranslated${
      untranslated.length > 0 ? ` (${untranslated.join(", ")})` : ""
    }; es holds ${esKeys.length} installments strings and en ${enKeys.length}`,
  );

  const audited = next("every write left an audit_log row naming its record");
  if (written.length === 0) {
    skip(audited, "no write path got through, so there is nothing to trace");
  } else {
    const recordIds = written.map((entry) => entry.recordId);
    const rows = await fixtureSql<{ entity: string; record_id: string }[]>`
      select distinct entity, record_id from audit_log
      where record_id in ${fixtureSql(recordIds)}`;
    const seen = new Set(rows.map((row) => `${row.entity}:${row.record_id}`));
    const missing = written.filter(
      (entry) => !seen.has(`${entry.entity}:${entry.recordId}`),
    );
    assert(
      audited,
      missing.length === 0,
      `${written.length} written, ${written.length - missing.length} traced${
        missing.length > 0 ? `, missing ${missing.map((e) => e.entity).join(", ")}` : ""
      }`,
    );
  }

  // RF-55: a user belongs to at most one live optional group. The run's own user
  // leads the seeded one, so the leader row `createGroup` writes second collides
  // on `group_members_user_unique` — a partial unique index over the unarchived
  // rows — and takes the whole transaction back with it.
  const oneMembership = next("a leader's second createGroup is refused");
  try {
    const { groupId } = await createGroup({
      name: "Harness fondo duplicado",
      leaderName: "Harness leader",
      cashMode: "shared",
      locale: "es",
    });
    // Tracked, not left behind: an accepted call is the failure this asserts on.
    track("groups", groupId);
    assert(oneMembership, false, `it was accepted as group ${groupId}`);
  } catch (error) {
    assert(
      oneMembership,
      pgErrorCode(error) === "23505" &&
        rootMessage(error).includes("group_members_user_unique"),
      refusal(error),
    );
  }

  // RF-99, read through the two screens that show it: the shape is off the silenced
  // list, the deliveries it discarded are waiting for review again, and the delivery
  // this person rejected by hand stayed rejected.
  const undone = next("an undone silence returns only what the machine discarded");
  const [shapes, pending] = await Promise.all([
    listSilencedShapes(),
    listPendingDeliveries(),
  ]);
  const queued = restored.silencedIds.filter((id) =>
    pending.some((delivery) => delivery.id === id),
  );
  const humanQueued = pending.some(
    (delivery) => delivery.id === restored.humanRejectedId,
  );

  assert(
    undone,
    !shapes.some((shape) => shape.id === restored.shapeId) &&
      queued.length === 2 &&
      !humanQueued,
    `the shape is ${shapes.some((shape) => shape.id === restored.shapeId) ? "still silenced" : "no longer silenced"}, ${queued.length} of 2 discarded deliveries are pending again, the person's rejection is ${humanQueued ? "back in the queue" : "still out of it"}`,
  );

  // D8: a fresh fund's categories, madre and hija alike, each draw their own
  // colour from `nextCategoryColor` — `create-group.ts` no longer copies a
  // child's colour from its parent.
  const fundPalette = next("a seeded fund's categories carry no repeated colour");
  const paletteLeader = await createMembershipFreeUser();
  const { groupId: paletteGroupId } = await asUser(paletteLeader, () =>
    createGroup({
      name: "Harness fondo paleta",
      leaderName: "Harness leader",
      cashMode: "shared",
      locale: "es",
    }),
  );
  track("groups", paletteGroupId);
  const [paletteSeeded] = await fixtureSql<
    { member_id: string | null; account_id: string | null }[]
  >`
    select
      (select id from group_members
         where group_id = ${paletteGroupId} and user_id = ${paletteLeader.id}
           and role = 'leader') as member_id,
      (select id from accounts
         where group_id = ${paletteGroupId} and subtype = 'cash') as account_id`;
  if (paletteSeeded.member_id !== null) track("group_members", paletteSeeded.member_id);
  if (paletteSeeded.account_id !== null) track("accounts", paletteSeeded.account_id);
  const fundCategoryRows = await fixtureSql<{ id: string; color: string | null }[]>`
    select id, color from categories where group_id = ${paletteGroupId}`;
  for (const row of fundCategoryRows) track("categories", row.id);
  const fundColours = fundCategoryRows.map((row) => row.color);
  assert(
    fundPalette,
    fundCategoryRows.length > 0 && new Set(fundColours).size === fundColours.length,
    `${new Set(fundColours).size} unique colour(s) of ${fundCategoryRows.length} categories`,
  );

  // The personal-space half of the same fix (`personal-space.ts`).
  const personalPalette = next(
    "a seeded personal space's categories carry no repeated colour",
  );
  const paletteSolo = await createMembershipFreeUser();
  await asUser(paletteSolo, () =>
    withUserDb((tx) =>
      seedPersonalCategories(tx, { userId: paletteSolo.id, locale: "es" }),
    ),
  );
  const personalCategoryRows = await fixtureSql<{ id: string; color: string | null }[]>`
    select id, color from categories where owner_user_id = ${paletteSolo.id}`;
  for (const row of personalCategoryRows) track("categories", row.id);
  const personalColours = personalCategoryRows.map((row) => row.color);
  assert(
    personalPalette,
    personalCategoryRows.length > 0 &&
      new Set(personalColours).size === personalColours.length,
    `${new Set(personalColours).size} unique colour(s) of ${personalCategoryRows.length} categories`,
  );

  // The part that used to revert itself: `categories.ts` forced a subcategory's
  // colour back to its parent's on every insert AND every update. Create a
  // parent and a child in distinct colours, edit the child through the real
  // `updateCategory` path, and read its colour back — it must still be the
  // child's own, never the parent's.
  const childKeepsOwnColour = next(
    "an edited subcategory keeps the colour it was given, not its parent's",
  );
  const paletteEditor = await createMembershipFreeUser();
  const editorScope = { ownerUserId: paletteEditor.id } as const;
  const { categoryId: paletteParentId } = await asUser(paletteEditor, () =>
    createCategory({
      scope: editorScope,
      name: "Harness paleta madre",
      kind: "expense",
      parentId: null,
      color: "#111111",
    }),
  );
  track("categories", paletteParentId);
  const { categoryId: paletteChildId } = await asUser(paletteEditor, () =>
    createCategory({
      scope: editorScope,
      name: "Harness paleta hija",
      kind: "expense",
      parentId: paletteParentId,
      color: "#222222",
    }),
  );
  track("categories", paletteChildId);
  await asUser(paletteEditor, () =>
    updateCategory({
      categoryId: paletteChildId,
      name: "Harness paleta hija editada",
      parentId: paletteParentId,
      color: "#333333",
    }),
  );
  const childColourAfterEdit = await readColumn<string>(
    "categories",
    "id",
    paletteChildId,
    "color",
  );
  assert(
    childKeepsOwnColour,
    childColourAfterEdit === "#333333",
    `parent #111111, child created #222222, child after edit ${childColourAfterEdit}`,
  );
}

// Fixed and far in the past: what `nextDayOfMonthOnOrAfter` computes off today
// always falls in a different year, so a `nextCutOffDate` that matches this one
// exactly can only have been read off the statement, never rolled from the term.
const STATEMENT_PERIOD_START = "2021-05-18";
const STATEMENT_CUT_OFF_DATE = "2021-06-18";
const STATEMENT_DUE_DATE = "2021-07-05";
const STATEMENT_CLOSING_MAGNITUDE_CENTS = 850000;

const ASSET_STATEMENT_PERIOD_START = "2021-05-01";
const ASSET_STATEMENT_CUT_OFF_DATE = "2021-05-31";
const ASSET_STATEMENT_CLOSING_MAGNITUDE_CENTS = 620000;

/**
 * RF-129, RF-130, RF-131: the write no suite above exercised, and the two reads
 * RF-131 retargeted onto it. Its own suite, run after every other identity has
 * settled, so the one statement it cuts on the fixture debt cannot shift a
 * round-trip count or a balance an earlier Q already asserted on.
 */
async function statementSuite(
  debt: DebtFixture,
  scope: HarnessScope,
): Promise<void> {
  const debtSigned = next(
    "recordAccountStatement signs a liability's magnitude negative",
  );
  const debtStatement = await recordAccountStatement({
    accountId: debt.unlimitedAccountId,
    periodStart: STATEMENT_PERIOD_START,
    cutOffDate: STATEMENT_CUT_OFF_DATE,
    paymentDueDate: STATEMENT_DUE_DATE,
    openingBalanceCents: null,
    closingBalanceCents: STATEMENT_CLOSING_MAGNITUDE_CENTS,
    creditsCents: null,
    debitsCents: null,
    minimumPaymentCents: null,
    interestChargedCents: null,
    feesChargedCents: null,
  });
  if (debtStatement === null) {
    skip(debtSigned, "recordAccountStatement was refused, so no row was written");
  } else {
    keep("account_statements", debtStatement.id);
    // The row itself, not the function's return: the sign is resolved in SQL,
    // and reading the return would only prove the payload round-tripped.
    const closing = await readColumn<string>(
      "account_statements",
      "id",
      debtStatement.id,
      "closing_balance_cents",
    );
    assert(
      debtSigned,
      closing === String(-STATEMENT_CLOSING_MAGNITUDE_CENTS),
      `a magnitude of ${STATEMENT_CLOSING_MAGNITUDE_CENTS} on a liability stored closing_balance_cents = ${closing}`,
    );
  }

  const assetSigned = next(
    "recordAccountStatement signs an asset's magnitude positive",
  );
  const assetStatement = await recordAccountStatement({
    accountId: scope.assetAccountId,
    periodStart: ASSET_STATEMENT_PERIOD_START,
    cutOffDate: ASSET_STATEMENT_CUT_OFF_DATE,
    paymentDueDate: null,
    openingBalanceCents: null,
    closingBalanceCents: ASSET_STATEMENT_CLOSING_MAGNITUDE_CENTS,
    creditsCents: null,
    debitsCents: null,
    minimumPaymentCents: null,
    interestChargedCents: null,
    feesChargedCents: null,
  });
  if (assetStatement === null) {
    skip(assetSigned, "recordAccountStatement was refused, so no row was written");
  } else {
    keep("account_statements", assetStatement.id);
    const closing = await readColumn<string>(
      "account_statements",
      "id",
      assetStatement.id,
      "closing_balance_cents",
    );
    assert(
      assetSigned,
      closing === String(ASSET_STATEMENT_CLOSING_MAGNITUDE_CENTS),
      `a magnitude of ${ASSET_STATEMENT_CLOSING_MAGNITUDE_CENTS} on an asset stored closing_balance_cents = ${closing}`,
    );
  }

  const nextDatesFromStatement = next(
    "getCurrentStatement and getDebtOverview both read the next dates off the statement",
  );
  if (debtStatement === null) {
    skip(nextDatesFromStatement, "no statement landed on the debt to read the dates off");
  } else {
    const [current, overview] = await Promise.all([
      getCurrentStatement(debt.unlimitedAccountId),
      getDebtOverview(),
    ]);
    const overviewRow = overview.find(
      (row) => row.accountId === debt.unlimitedAccountId,
    );
    assert(
      nextDatesFromStatement,
      current?.nextCutOffDate === STATEMENT_CUT_OFF_DATE &&
        current.nextDueDate === STATEMENT_DUE_DATE &&
        overviewRow?.nextDueDate === current.nextDueDate,
      `getCurrentStatement names ${current?.nextCutOffDate ?? "no"} cut-off and ${current?.nextDueDate ?? "no"} due, getDebtOverview names ${overviewRow?.nextDueDate ?? "no"} due for the same debt`,
    );
  }

  const historyCost = next(
    "getAccountStatementHistory costs two round trips, one per Promise.all read",
  );
  if (debtStatement === null) {
    skip(historyCost, "no statement landed on the debt to read the history of");
  } else {
    // The first call is unmeasured on purpose, the same reason
    // `getDebtsScreenData costs one round trip per fanned-out read` skips it:
    // the driver counts the statements that open a connection too.
    await listAccountStatements(debt.unlimitedAccountId);
    const unitBefore = roundTrips();
    await listAccountStatements(debt.unlimitedAccountId);
    const unit = roundTrips() - unitBefore;

    const before = roundTrips();
    const history = await getAccountStatementHistory(debt.unlimitedAccountId);
    const trips = roundTrips() - before;

    // The same formula `account-statements.ts` runs, written again here so the
    // gap it reports is checked against a figure this suite derived on its own,
    // never against the code under test.
    const [rawGap] = await fixtureSql<{ derived_cents: string }[]>`
      select
        a.initial_balance_cents
          + coalesce((
              select sum(case
                when t.currency = a.settlement_currency then t.amount_cents
                when t.counter_amount_cents is not null and not t.counter_is_estimate
                  then t.counter_amount_cents
                else 0
              end)
              from transactions t
              where t.to_account_id = a.id and t.occurred_at <= ${STATEMENT_CUT_OFF_DATE}
            ), 0)
          - coalesce((
              select sum(case
                when t.currency = a.settlement_currency then t.amount_cents
                when t.counter_amount_cents is not null and not t.counter_is_estimate
                  then t.counter_amount_cents
                else 0
              end)
              from transactions t
              where t.from_account_id = a.id and t.occurred_at <= ${STATEMENT_CUT_OFF_DATE}
            ), 0) as derived_cents
      from accounts a where a.id = ${debt.unlimitedAccountId}`;
    const expectedGap = -STATEMENT_CLOSING_MAGNITUDE_CENTS - Number(rawGap.derived_cents);
    const row = history?.statements.find((entry) => entry.id === debtStatement.id);

    assert(
      historyCost,
      trips === unit * 2 && row?.reconciliationGapCents === expectedGap,
      `${trips} round trips for the history, ${unit} for a single read of it; the gap read ${row?.reconciliationGapCents ?? "no"} cents against ${expectedGap} computed apart in raw SQL`,
    );
  }
}

/**
 * Suite Q-timing: what each screen-level read costs, in wall time and in round
 * trips counted at the driver. It PRINTS and asserts nothing — RNF-09 is a budget
 * on an HTTP response, and this is the attribution that has to explain the number
 * `check:http` reports, not a second verdict on it.
 *
 * Read as the user `scripts/seed-year.ts` loaded the year of movements onto, so
 * the numbers are the ones the requirement is stated against; against the run's
 * own throwaway user they would only say what an empty ledger costs. Nothing here
 * writes, so reading as another identity leaves that user's rows exactly as found.
 */
async function timingSuite(): Promise<void> {
  const seeded = await findUserByEmail(HARNESS_EMAIL);
  if (!seeded) {
    console.log(
      `REPORT  no ${HARNESS_EMAIL} identity, so there is no seeded ledger to time; run check:http once, then seed:year.`,
    );
    return;
  }

  const movements = await countOwnedMovements(seeded.id);
  console.log(
    `REPORT  timing as ${HARNESS_EMAIL}, who owns ${movements} movements${
      movements >= YEAR_OF_MOVEMENTS
        ? ""
        : ` — short of the ${YEAR_OF_MOVEMENTS} a year holds, so these numbers understate the requirement`
    }.`,
  );

  const timed = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    const trips = roundTrips();
    const started = performance.now();
    const value = await run();

    console.log(
      `REPORT  ${name} — ${Math.round(performance.now() - started)} ms over ${roundTrips() - trips} round trips, ${summarise(value)}.`,
    );
  };

  await asUser(seeded, async () => {
    // Cold: the pool has no connection to this database yet, and the first read
    // would charge the whole suite for opening one.
    await getUserGroup();

    console.log("");
    await timed("getDashboardData (the whole dashboard read-model)", () =>
      getDashboardData(),
    );
    // The same six reads again, one at a time: what the fan-out above is made of.
    await timed("  listAccounts", () => listAccounts({ archived: false }));
    await timed("  getAccountBalances", () => getAccountBalances());
    await timed("  getMonthlyFlow", () => getMonthlyFlow(currentMonthRange()));
    await timed("  getUserGroup", () => getUserGroup());
    await timed("  countUnreviewedGenerated", () => countUnreviewedGenerated());
    await timed("  countPendingDeliveries", () => countPendingDeliveries());
    // The shell's own read, on every route: the sidebar's name, role and count.
    await timed("getShellSummary (the layout's sidebar)", () => getShellSummary());

    // The rest of what a request for `/es` costs: the layout and the page each
    // call `getTransactionFormOptions`, and it awaits `getUserGroup()` before its
    // own fan-out rather than inside it.
    await timed("getTransactionFormOptions (layout, then page again)", () =>
      getTransactionFormOptions(),
    );
    await timed("listTransactions limit 3 (the dashboard's recent lines)", () =>
      listTransactions({}, { limit: 3 }),
    );
    await timed("resolveWithdrawalTarget", () => resolveWithdrawalTarget());

    console.log("");
    await timed("listTransactions unbounded (what /movements loads)", () =>
      listTransactions({}),
    );
    await timed("getReportsData (what /reports loads)", () => getReportsData());
    await timed("getDebtOverview (what /planning/debts folds into totals)", () =>
      getDebtOverview(),
    );
  });
}

/**
 * RF-137, RF-138: the sums an adjustment must stay out of, the sheet that reads the derived
 * figure for a day, and the write that books the gap. Its own suite, last, on accounts it opens
 * itself: the fixtures above keep every figure they asserted on. Every flow figure is compared
 * with what the same read said before the first adjustment, never against a constant.
 */
async function reconcileSuite(
  userId: string,
  scope: HarnessScope,
  fellow: HarnessUser,
): Promise<void> {
  const today = todayInBogota();
  const openedOn = shiftDate(today, -10);
  const range = currentMonthRange();
  const thisMonth = today.slice(0, 7);

  const open = async (
    name: string,
    kind: "asset" | "liability",
    currency: string,
    amountMinor: number,
    placement: "personal" | "group" = "personal",
  ): Promise<string> => {
    const { accountId } = await createAccount({
      name,
      kind,
      subtype: kind === "asset" ? "bank" : "card",
      ownerUserId: placement === "personal" ? userId : null,
      groupId: placement === "group" ? scope.groupId : null,
      isShared: placement === "group",
      institution: null,
      lastFour: null,
      settlementCurrency: currency,
      amountMinor,
      balanceOn: openedOn,
    });
    keep("accounts", accountId);
    return accountId;
  };

  const cop = await open("Harness cuadre COP", "asset", "COP", 1_000_000);
  const usd = await open("Harness cuadre USD", "asset", "USD", 0);
  const card = await open("Harness cuadre tarjeta", "liability", "COP", 300_000);
  const pot = await open("Harness cuadre fondo", "asset", "COP", 0, "group");
  const closed = await open("Harness cuadre archivada", "asset", "COP", 0);
  await archiveAccount({ accountId: closed });

  // A spend on the account a budget narrows to, so "spent" has something an adjustment could leak into.
  const spend = await createTransaction({
    fromAccountId: cop,
    toAccountId: null,
    amountCents: 300_000,
    occurredAt: today,
    description: "Harness cuadre gasto",
    externalRef: null,
    splits: [{ categoryId: scope.categoryId, amountCents: 300_000 }],
    labelIds: [],
  });
  keep("transactions", spend.transactionId);
  const { budgetId } = await createBudget({
    ownerUserId: userId,
    groupId: null,
    categoryId: scope.categoryId,
    accountId: cop,
    labelId: null,
    period: "monthly",
    limitCents: 90_000_000,
    thresholdPct: 80,
    name: "Harness cuadre presupuesto",
  });
  keep("budgets", budgetId);

  const snapshot = async () => {
    const [flow, six, budgets, byCategory, contributions, exported] = await Promise.all([
      getMonthlyFlow(range),
      getSixMonthFlow(),
      listBudgetsWithStatus(),
      getExpensesByCategory(range),
      getMemberContributions(range),
      readExport({ entityKeys: ["transactions"] }),
    ]);
    return { flow, six, budgets, byCategory, contributions, exported: exported.transactions ?? [] };
  };
  const before = await snapshot();
  const flowOf = (rows: Awaited<ReturnType<typeof getMonthlyFlow>>, currency: string) =>
    rows.find((row) => row.currency === currency);

  // Sheet reads, before anything is booked.
  const derivedToday = await getReconcileSheet(cop, today);
  const derivedYesterday = await getReconcileSheet(cop, shiftDate(today, -1));
  assert(
    next("The sheet's derived figure is the day's: opening + legs up to it, none after"),
    derivedToday?.account.derivedCents === 700_000 &&
      derivedYesterday?.account.derivedCents === 1_000_000,
    `derived on ${today} = ${derivedToday?.account.derivedCents}, on the day before = ${derivedYesterday?.account.derivedCents}; expected 700000 and 1000000 (the spend is dated ${today})`,
  );

  // The unit is the history read alone, warmed once for the driver's connection.
  await listAccountReconciliations(cop);
  const unitBefore = roundTrips();
  await listAccountReconciliations(cop);
  const unit = roundTrips() - unitBefore;
  const sheetBefore = roundTrips();
  await getReconcileSheet(cop, today);
  const sheetTrips = roundTrips() - sheetBefore;
  assert(
    next("The sheet costs two round trips, one per Promise.all read"),
    unit > 0 && sheetTrips === unit * 2,
    `${sheetTrips} round trips for the sheet, ${unit} for a single read`,
  );

  // Book two adjustments on the peso account in the current month: +1 200 000, then -800 000.
  const up = await reconcileAccount({
    accountId: cop,
    reconciledOn: today,
    realMagnitudeCents: 1_900_000,
    expectedDerivedCents: 700_000,
  });
  const down = await reconcileAccount({
    accountId: cop,
    reconciledOn: today,
    realMagnitudeCents: 1_100_000,
    expectedDerivedCents: 1_900_000,
  });
  const zero = await reconcileAccount({
    accountId: cop,
    reconciledOn: today,
    realMagnitudeCents: 1_100_000,
    expectedDerivedCents: 1_100_000,
  });
  const usdUp = await reconcileAccount({
    accountId: usd,
    reconciledOn: today,
    realMagnitudeCents: 50_000,
    expectedDerivedCents: 0,
  });
  const potUp = await reconcileAccount({
    accountId: pot,
    reconciledOn: today,
    realMagnitudeCents: 500_000,
    expectedDerivedCents: 0,
  });
  assert(
    next("reconcileAccount books a gap, signed, and reports it"),
    up.ok && up.gapCents === 1_200_000 && down.ok && down.gapCents === -800_000 &&
      zero.ok && zero.gapCents === 0 && usdUp.ok && potUp.ok,
    `gaps ${[up, down, zero].map((r) => (r.ok ? r.gapCents : r.reason)).join(", ")}`,
  );
  const ids = [up, down, zero].flatMap((r) => (r.ok ? [r.id] : []));

  const after = await snapshot();
  const copBefore = flowOf(before.flow, "COP");
  const copAfter = flowOf(after.flow, "COP");
  const usdBefore = flowOf(before.flow, "USD");
  const usdAfter = flowOf(after.flow, "USD");
  // The pot's +500 000 is a COP adjustment too, so the peso row carries 400 000 + 500 000.
  const COP_ADJUSTMENT = 400_000 + 500_000;

  assert(
    next("The month's income and expense leave adjustments out"),
    copAfter?.incomeCents === (copBefore?.incomeCents ?? 0) &&
      copAfter?.expenseCents === (copBefore?.expenseCents ?? 0),
    `income ${copBefore?.incomeCents} -> ${copAfter?.incomeCents}, expense ${copBefore?.expenseCents} -> ${copAfter?.expenseCents}`,
  );
  assert(
    next("The month's adjustment is its own signed sum"),
    (copAfter?.adjustmentCents ?? 0) - (copBefore?.adjustmentCents ?? 0) === COP_ADJUSTMENT,
    `adjustment ${copBefore?.adjustmentCents ?? 0} -> ${copAfter?.adjustmentCents}; expected +${COP_ADJUSTMENT}`,
  );
  assert(
    next("The month's net leaves adjustments out"),
    copAfter?.netCents === (copBefore?.netCents ?? 0),
    `net ${copBefore?.netCents} -> ${copAfter?.netCents}`,
  );

  const monthRow = (rows: typeof after.six, currency: string, month: string) =>
    rows.find((row) => row.currency === currency && row.monthStart.startsWith(month));
  const sixOthers = after.six.every((row) => {
    const prior = before.six.find(
      (entry) => entry.currency === row.currency && entry.monthStart === row.monthStart,
    );
    return row.monthStart.startsWith(thisMonth) || row.adjustmentCents === (prior?.adjustmentCents ?? 0);
  });
  const sixNow = monthRow(after.six, "COP", thisMonth);
  const sixWas = monthRow(before.six, "COP", thisMonth);
  assert(
    next("The six-month trend leaves adjustments out and carries them"),
    sixNow?.incomeCents === sixWas?.incomeCents &&
      sixNow?.expenseCents === sixWas?.expenseCents &&
      (sixNow?.adjustmentCents ?? 0) - (sixWas?.adjustmentCents ?? 0) === COP_ADJUSTMENT &&
      sixOthers,
    `this month: income ${sixWas?.incomeCents} -> ${sixNow?.incomeCents}, expense ${sixWas?.expenseCents} -> ${sixNow?.expenseCents}, adjustment ${sixWas?.adjustmentCents} -> ${sixNow?.adjustmentCents}; other months unchanged = ${sixOthers}`,
  );
  assert(
    next("A dollar account's adjustment lands in the dollar row only"),
    (usdAfter?.adjustmentCents ?? 0) - (usdBefore?.adjustmentCents ?? 0) === 50_000 &&
      usdAfter?.incomeCents === (usdBefore?.incomeCents ?? 0) &&
      (copAfter?.adjustmentCents ?? 0) - (copBefore?.adjustmentCents ?? 0) === COP_ADJUSTMENT,
    `usd adjustment ${usdBefore?.adjustmentCents ?? 0} -> ${usdAfter?.adjustmentCents}, cop +${(copAfter?.adjustmentCents ?? 0) - (copBefore?.adjustmentCents ?? 0)}`,
  );

  const budgetBefore = before.budgets.find((row) => row.id === budgetId);
  const budgetAfter = after.budgets.find((row) => row.id === budgetId);
  assert(
    next("A budget's spent is untouched by an adjustment on its account"),
    budgetBefore !== undefined && budgetBefore.spentCents === 300_000 &&
      budgetAfter?.spentCents === budgetBefore.spentCents,
    `spent ${budgetBefore?.spentCents} -> ${budgetAfter?.spentCents}`,
  );
  assert(
    next("The category breakdown is untouched by an adjustment"),
    JSON.stringify(after.byCategory) === JSON.stringify(before.byCategory),
    `${before.byCategory.length} categories before, ${after.byCategory.length} after`,
  );
  assert(
    next("Member contributions are untouched by an adjustment on a group account"),
    JSON.stringify(after.contributions) === JSON.stringify(before.contributions),
    `${before.contributions.length} rows before, ${after.contributions.length} after`,
  );
  assert(
    next("The export carries adjustments as movements, signed by their legs"),
    (() => {
      const adjustmentRows = (name: string) =>
        after.exported.filter(
          (row) =>
            row.description !== "Harness cuadre gasto" &&
            (row.toAccount === name || row.fromAccount === name),
        );
      const copRows = adjustmentRows("Harness cuadre COP");
      const gained = copRows.find((row) => row.toAccount === "Harness cuadre COP" && row.fromAccount === null);
      const lost = copRows.find((row) => row.fromAccount === "Harness cuadre COP" && row.toAccount === null);
      return (
        after.exported.length === before.exported.length + 4 &&
        gained?.amount === 1_200_000 &&
        lost?.amount === 800_000
      );
    })(),
    `${before.exported.length} transaction rows before, ${after.exported.length} after; expected +4 (up, down, dollar, pot; the zero gap books none)`,
  );

  // History.
  const history = await listAccountReconciliations(cop);
  const [newest, middle, oldest] = history;
  assert(
    next("The history derives «Según HomeFund» as counted minus gap"),
    middle?.gapCents === -800_000 && middle.countedCents === 1_100_000 && middle.derivedCents === 1_900_000 &&
      oldest?.derivedCents === 700_000 && newest?.gapCents === 0 && newest.transactionId === null &&
      newest.derivedCents === 1_100_000,
    `rows ${history.map((row) => `${row.derivedCents}/${row.countedCents}/${row.gapCents}`).join(" | ")}`,
  );
  assert(
    next("The history lists the newest first"),
    JSON.stringify(history.map((row) => row.id)) === JSON.stringify([...ids].reverse()),
    `order ${history.map((row) => row.id.slice(0, 4)).join(",")} against ${[...ids].reverse().map((id) => id.slice(0, 4)).join(",")}`,
  );

  // Refusals, each leaving the count of rows where it was.
  const countRows = async (accountId: string): Promise<number> => {
    const [row] = await fixtureSql<{ n: number }[]>`
      select count(*)::int as n from account_reconciliations where account_id = ${accountId}`;
    return row.n;
  };
  const rowsBefore = await countRows(cop);
  const stale = await reconcileAccount({
    accountId: cop,
    reconciledOn: today,
    realMagnitudeCents: 2_000_000,
    expectedDerivedCents: 1_100_001,
  });
  assert(
    next("A stale derived figure is refused and nothing is written"),
    !stale.ok && stale.reason === "stale" && (await countRows(cop)) === rowsBefore,
    `${JSON.stringify(stale)}, rows ${rowsBefore} -> ${await countRows(cop)}`,
  );

  const tomorrow = shiftDate(today, 1);
  const beforeOpen = shiftDate(openedOn, -1);
  const [tomorrowSheet, openSheet, yesterdaySheet, closedSheet] = await Promise.all([
    getReconcileSheet(cop, tomorrow),
    getReconcileSheet(cop, beforeOpen),
    getReconcileSheet(cop, shiftDate(today, -1)),
    getReconcileSheet(closed, today),
  ]);
  const attempt = (accountId: string, on: string, sheet: typeof tomorrowSheet) =>
    reconcileAccount({
      accountId,
      reconciledOn: on,
      realMagnitudeCents: 10_000,
      expectedDerivedCents: sheet?.account.derivedCents ?? 0,
    });
  const [future, early, late, archived, denied] = await Promise.all([
    attempt(cop, tomorrow, tomorrowSheet),
    attempt(cop, beforeOpen, openSheet),
    attempt(cop, shiftDate(today, -1), yesterdaySheet),
    attempt(closed, today, closedSheet),
    asUser(fellow, () => reconcileAccount({
      accountId: cop,
      reconciledOn: today,
      realMagnitudeCents: 10_000,
      expectedDerivedCents: 1_100_000,
    })),
  ]);
  assert(
    next("Each refusal is mapped, with the day it names"),
    !future.ok && future.reason === "future" &&
      !early.ok && early.reason === "beforeOpening" && early.date === openedOn &&
      !late.ok && late.reason === "beforeLatest" && late.date === today &&
      !archived.ok && archived.reason === "archived" &&
      !denied.ok && denied.reason === "denied" &&
      (await countRows(cop)) === rowsBefore,
    [future, early, late, archived, denied].map((r) => (r.ok ? "ok" : `${r.reason}${r.date ? `@${r.date}` : ""}`)).join(", "),
  );

  // A liability's magnitude is signed by its kind.
  const cardSheet = await getReconcileSheet(card, today);
  const owed = await reconcileAccount({
    accountId: card,
    reconciledOn: today,
    realMagnitudeCents: 450_000,
    expectedDerivedCents: cardSheet?.account.derivedCents ?? 0,
  });
  const counted = owed.ok
    ? await readColumn<string>("account_reconciliations", "id", owed.id, "counted_balance_cents")
    : undefined;
  assert(
    next("A card's typed magnitude is stored negative"),
    owed.ok && counted === "-450000" && owed.gapCents === -150_000,
    `counted_balance_cents = ${counted}, derived ${cardSheet?.account.derivedCents}, ${JSON.stringify(owed)}`,
  );

  // The listing and the write paths see the mark.
  const adjustment = history.find((row) => row.gapCents === -800_000);
  const listed = await listTransactions({ accountId: cop });
  const markedRow = listed.find((row) => row.id === adjustment?.transactionId);
  const spendRow = listed.find((row) => row.id === spend.transactionId);
  assert(
    next("The listing marks the adjustment and only it"),
    markedRow?.reconciliationId === adjustment?.id && spendRow?.reconciliationId === null,
    `adjustment row mark = ${markedRow?.reconciliationId}, spend mark = ${spendRow?.reconciliationId}`,
  );

  const adjustmentId = adjustment?.transactionId ?? randomUUID();
  const edited = await updateTransaction({
    transactionId: adjustmentId,
    fromAccountId: cop,
    toAccountId: null,
    amountCents: 1,
    occurredAt: today,
    description: "editado",
    splits: [{ categoryId: scope.categoryId, amountCents: 1 }],
    labelIds: [],
  });
  const removed = await deleteTransaction({ transactionId: adjustmentId });
  const kept = await readColumn<string>("transactions", "id", adjustmentId, "amount_cents");
  const missing = await deleteTransaction({ transactionId: randomUUID() });
  assert(
    next("Editing or deleting an adjustment is refused with its own reason"),
    edited === "adjustment" && removed === "adjustment" && kept === "800000" && missing === "missing",
    `update = ${edited}, delete = ${removed}, amount_cents still ${kept}, unknown id = ${missing}`,
  );

  // Round trips of the dashboard and the reports read-models, against the sum of their parts.
  const trips = async (run: () => Promise<unknown>): Promise<number> => {
    const started = roundTrips();
    await run();
    return roundTrips() - started;
  };
  await getReportsData();
  const group = await getUserGroup();
  const parts =
    (await trips(() => getExpensesByCategory(range))) +
    (await trips(() => getSixMonthFlow())) +
    (await trips(() => getMemberContributions(range))) +
    (await trips(() => getUserGroup())) +
    (await trips(() => getSessionUser())) +
    (group ? await trips(() => listMembers(group.id, { archived: false })) : 0);
  const reportsTrips = await trips(() => getReportsData());
  const flowTrips = await trips(() => getMonthlyFlow(range));
  const sixTrips = await trips(() => getSixMonthFlow());
  const readUnit = await trips(() => getMemberContributions(range));
  assert(
    next("The flow sums and the reports read keep their round trips"),
    flowTrips === readUnit && sixTrips === readUnit && reportsTrips === parts,
    `getMonthlyFlow ${flowTrips}, getSixMonthFlow ${sixTrips} against one read ${readUnit}; getReportsData ${reportsTrips} against its parts ${parts}`,
  );
}

// Export -> import into a fresh scope reproduces every balance and keeps adjustments out of income
// and expense (RF-50, RF-138). The import is `commitImport` itself, fed the rows `readExport` wrote.
async function reimportSuite(userId: string, scope: HarnessScope): Promise<void> {
  const today = todayInBogota();
  const importer = await createMembershipFreeUser();
  const prefix = "Harness reimport";

  const open = async (name: string, kind: "asset" | "liability", amountMinor: number) => {
    const { accountId } = await createAccount({
      name,
      kind,
      subtype: kind === "asset" ? "bank" : "card",
      ownerUserId: userId,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor,
      balanceOn: shiftDate(today, -10),
    });
    keep("accounts", accountId);
    return accountId;
  };
  const savings = await open(`${prefix} ahorros`, "asset", 1_000_000);
  const card = await open(`${prefix} tarjeta`, "liability", 300_000);

  const spend = async (amountCents: number, occurredAt: string) => {
    const { transactionId } = await createTransaction({
      fromAccountId: savings,
      toAccountId: null,
      amountCents,
      occurredAt,
      description: `${prefix} gasto`,
      externalRef: null,
      splits: [{ categoryId: scope.categoryId, amountCents }],
      labelIds: [],
    });
    keep("transactions", transactionId);
  };
  await spend(300_000, shiftDate(today, -5));
  await reconcileAccount({
    accountId: savings,
    reconciledOn: shiftDate(today, -2),
    realMagnitudeCents: 1_900_000,
    expectedDerivedCents: 700_000,
  });
  await spend(100_000, today);
  await reconcileAccount({
    accountId: savings,
    reconciledOn: today,
    realMagnitudeCents: 1_700_000,
    expectedDerivedCents: 1_800_000,
  });
  await reconcileAccount({
    accountId: card,
    reconciledOn: today,
    realMagnitudeCents: 450_000,
    expectedDerivedCents: -300_000,
  });

  // What a person would export: the fixture's own accounts and the movements that touch them.
  const exported = await readExport({ entityKeys: ["accounts", "transactions"] });
  const sheetAccounts = (exported.accounts ?? []).filter((row) => String(row.name).startsWith(prefix));
  const sheetMovements = (exported.transactions ?? []).filter(
    (row) =>
      String(row.fromAccount ?? "").startsWith(prefix) || String(row.toAccount ?? "").startsWith(prefix),
  );

  const pesos = (cents: number) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  const placeholder = new Map(sheetAccounts.map((row) => [String(row.name), randomUUID()]));
  const categoryPlaceholder = randomUUID();
  const idOf = (name: unknown) => (name == null ? null : placeholder.get(String(name)) ?? null);

  const input: CommitInput = {
    members: [],
    categories: [
      {
        status: "new",
        index: 0,
        sheetRow: 2,
        externalRef: null,
        placeholderId: categoryPlaceholder,
        object: { name: `${prefix} categoria`, kind: "expense", parentId: null, color: CATEGORY_COLORS[0] },
      },
    ],
    accounts: sheetAccounts.map((row, index) => ({
      status: "new" as const,
      index,
      sheetRow: index + 2,
      externalRef: row.externalRef as string | null,
      placeholderId: placeholder.get(String(row.name)) ?? null,
      object: {
        name: String(row.name),
        kind: row.kind as "asset" | "liability",
        subtype: row.subtype as never,
        placement: "personal" as const,
        institution: null,
        settlementCurrency: "COP" as const,
        // A liability exports its debt signed; the form takes the magnitude.
        amount: pesos(Math.abs(row.amount as number)),
        balanceOn: String(row.balanceOn),
      },
    })),
    recurringRules: [],
    transactions: [],
    adjustments: [],
  };
  sheetMovements.forEach((row, index) => {
    const common = {
      status: "new" as const,
      index,
      sheetRow: index + 2,
      externalRef: row.externalRef as string | null,
      placeholderId: null,
    };
    if ((row as Record<string, unknown>).adjustment === true) {
      input.adjustments!.push({
        ...common,
        object: {
          adjustment: true,
          accountId: (idOf(row.fromAccount) ?? idOf(row.toAccount))!,
          direction: row.fromAccount == null ? "up" : "down",
          amount: pesos(row.amount as number),
          occurredAt: String(row.occurredAt),
        },
      });
    } else {
      input.transactions.push({
        ...common,
        object: {
          fromAccountId: idOf(row.fromAccount),
          toAccountId: idOf(row.toAccount),
          amount: pesos(row.amount as number),
          occurredAt: String(row.occurredAt),
          description: (row.description as string | null) ?? null,
          externalRef: common.externalRef,
          splits: [{ categoryId: categoryPlaceholder, amount: pesos(row.amount as number) }],
          labelIds: [],
        },
      });
    }
  });

  let imported = "ok";
  try {
    await asUser(importer, () =>
      withUserDb((tx) => commitImport(tx, input, { userId: importer.id, groupId: null })),
    );
  } catch (error) {
    imported = rootMessage(error);
  }

  const figures = (owner: string) =>
    fixtureSql<{ name: string; balance: string; income: string; expense: string; adjusted: string }[]>`
      select a.name,
        private.account_settlement_balance_on(a.id, ${today}::date)::text as balance,
        coalesce((select sum(t.amount_cents) from transactions t
          where t.to_account_id = a.id and t.from_account_id is null and t.reconciliation_id is null), 0)::text as income,
        coalesce((select sum(t.amount_cents) from transactions t
          where t.from_account_id = a.id and t.to_account_id is null and t.reconciliation_id is null), 0)::text as expense,
        coalesce((select sum(case when t.to_account_id = a.id then t.amount_cents else -t.amount_cents end)
          from transactions t where t.reconciliation_id is not null
          and (t.to_account_id = a.id or t.from_account_id = a.id)), 0)::text as adjusted
      from accounts a where a.owner_user_id = ${owner} and a.name like ${prefix + "%"}
      order by a.name`;
  const [source, copy] = [await figures(userId), await figures(importer.id)];
  const same = (key: "balance" | "income" | "expense" | "adjusted") =>
    source.length === 2 && JSON.stringify(source.map((r) => r[key])) === JSON.stringify(copy.map((r) => r[key]));
  const brief = (rows: typeof source) =>
    rows.map((r) => `${r.name}: balance ${r.balance}, income ${r.income}, expense ${r.expense}, adjusted ${r.adjusted}`).join(" | ");

  assert(
    next("Export then import gives every account the balance it had"),
    imported === "ok" && same("balance"),
    `import ${imported}; source [${brief(source)}]; copy [${brief(copy)}]`,
  );
  assert(
    next("A re-imported adjustment stays out of income and expense and is still an adjustment"),
    imported === "ok" && same("income") && same("expense") && same("adjusted") &&
      copy.find((r) => r.name.endsWith("ahorros"))?.adjusted === "1100000",
    `source [${brief(source)}]; copy [${brief(copy)}]`,
  );

  const keys = async (owner: string) =>
    (await fixtureSql<{ external_ref: string }[]>`
      select t.external_ref from transactions t
      join accounts a on a.id = coalesce(t.to_account_id, t.from_account_id)
      where t.reconciliation_id is not null and t.owner_user_id = ${owner} and a.name like ${prefix + "%"}
      order by t.external_ref`).map((r) => r.external_ref);
  const [sourceKeys, copyKeys] = [await keys(userId), await keys(importer.id)];
  assert(
    next("A re-imported adjustment keeps the key its backup row carried"),
    sourceKeys.length > 0 && copyKeys.length === sourceKeys.length &&
      JSON.stringify(copyKeys) === JSON.stringify(sheetMovements.filter((r) => (r as Record<string, unknown>).adjustment === true).map((r) => r.externalRef).sort()),
    `copy keys ${copyKeys.length}, source adjustments ${sourceKeys.length}`,
  );

  // RF-51, RF-52: a workbook exported before the words were English still previews and
  // re-imports. Each row is the account row this very export wrote, with only the cell an
  // old file would have spelled differently.
  const olderBank = sheetAccounts.find((r) => String(r.name).endsWith("ahorros")) as unknown as RawRow;
  const olderCard = sheetAccounts.find((r) => String(r.name).endsWith("tarjeta")) as unknown as RawRow;
  const olderScope = await asUser(importer, () => readImportScope());
  const olderRefs = buildEffectiveRefs(olderScope, () => []);
  const preview = (raw: RawRow) =>
    processRow("accounts", raw, 0, 2, olderRefs, olderScope.existingRefs.accounts);
  const legacyRef = `harness-legacy-${randomUUID()}`;
  const legacyBank = preview({ ...olderBank, name: `${prefix} vieja`, subtype: "bancaria", externalRef: legacyRef });
  assert(
    next("A workbook written with «bancaria» previews with no error and reads as bank"),
    legacyBank.errors.length === 0 &&
      (legacyBank.object as { subtype?: string } | null)?.subtype === "bank" &&
      legacyBank.status === "new",
    `errors [${legacyBank.errors.map((e) => e.key)}], subtype ${(legacyBank.object as { subtype?: string } | null)?.subtype}, status ${legacyBank.status}`,
  );
  const legacyMismatch = preview({ ...olderCard, subtype: "efectivo", amount: Math.abs(Number(olderCard.amount)), externalRef: null });
  assert(
    next("An old word that does not fit its kind is refused on the subtype column"),
    legacyMismatch.errors.length === 1 &&
      legacyMismatch.errors[0].column === "subtype" &&
      legacyMismatch.errors[0].key === "accounts.errors.subtypeKindMismatch" &&
      legacyMismatch.object === null,
    `errors [${legacyMismatch.errors.map((e) => `${e.column}:${e.key}`)}]`,
  );

  const commitOlder = async (row: typeof legacyBank): Promise<string> => {
    try {
      await asUser(importer, () =>
        withUserDb((tx) =>
          commitImport(
            tx,
            {
              members: [],
              categories: [],
              accounts: [{ ...row, object: row.object as never }],
              recurringRules: [],
              transactions: [],
              adjustments: [],
            },
            { userId: importer.id, groupId: null },
          ),
        ),
      );
      return "ok";
    } catch (error) {
      return rootMessage(error);
    }
  };
  const firstLoad = await commitOlder(legacyBank);
  const afterScope = await asUser(importer, () => readImportScope());
  const again = processRow(
    "accounts",
    { ...olderBank, name: `${prefix} vieja`, subtype: "bancaria", externalRef: legacyRef },
    0,
    2,
    buildEffectiveRefs(afterScope, () => []),
    afterScope.existingRefs.accounts,
  );
  const secondLoad = again.status === "update" ? await commitOlder(again) : "not an update";
  const stored = await fixtureSql<{ id: string; subtype: string }[]>`
    select id, subtype from accounts where owner_user_id = ${importer.id} and external_ref = ${legacyRef}`;
  for (const row of stored) track("accounts", row.id);
  assert(
    next("Re-importing an old workbook updates the account it already holds and never duplicates it"),
    firstLoad === "ok" &&
      again.status === "update" &&
      again.errors.length === 0 &&
      secondLoad === "ok" &&
      stored.length === 1 &&
      stored[0].subtype === "bank",
    `first ${firstLoad}, second row ${again.status} [${again.errors.map((e) => e.key)}], commit ${secondLoad}, ${stored.length} stored as [${stored.map((r) => r.subtype)}]`,
  );
}

/**
 * RF-68, RF-40, RF-56: where a withdrawal lands, what it draws from, and the cash a fund
 * or a first withdrawal seeds. Every caller is its own membership-free user, so no
 * earlier suite has put a cash account in the way, and each case reads the STORED subtype
 * outside RLS: the claim is about the word written, not about what a query finds.
 */
async function cashSuite(): Promise<void> {
  const today = todayInBogota();
  const open = (
    user: HarnessUser,
    name: string,
    subtype: "bank" | "cash",
    groupId: string | null,
  ) =>
    asUser(user, async () => {
      const { accountId } = await createAccount({
        name,
        kind: "asset",
        subtype,
        ownerUserId: groupId === null ? user.id : null,
        groupId,
        isShared: groupId !== null,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor: 1_000_000,
        balanceOn: shiftDate(today, -3),
      });
      track("accounts", accountId);
      return accountId;
    });
  const found = async (column: "owner_user_id" | "group_id", id: string) => {
    const rows = await fixtureSql<{ id: string; subtype: string; group_id: string | null; owner_user_id: string | null }[]>`
      select id, subtype, group_id, owner_user_id from accounts
      where ${fixtureSql(column)} = ${id} order by created_at`;
    for (const row of rows) track("accounts", row.id);
    return rows;
  };
  const trackFund = async (groupId: string) => {
    for (const table of ["group_members", "categories"] as const) {
      const rows = await fixtureSql<{ id: string }[]>`select id from ${fixtureSql(table)} where group_id = ${groupId}`;
      for (const row of rows) track(table, row.id);
    }
  };
  const found_ = (rows: { subtype: string }[]) => rows.map((r) => r.subtype).join(",");

  // A per-member fund seeds its leader one personal cash and the fund none.
  const perMemberLeader = await createMembershipFreeUser();
  const { groupId: perMemberGroup } = await asUser(perMemberLeader, () =>
    createGroup({ name: "Harness fondo por miembro", leaderName: "Harness lider", cashMode: "per_member", locale: "es" }),
  );
  track("groups", perMemberGroup);
  await trackFund(perMemberGroup);
  const seededPersonal = await found("owner_user_id", perMemberLeader.id);
  const seededInGroup = await found("group_id", perMemberGroup);
  assert(
    next("A per-member fund seeds its leader one personal cash and the group none"),
    seededPersonal.length === 1 &&
      seededPersonal[0].subtype === "cash" &&
      seededPersonal[0].group_id === null &&
      seededInGroup.length === 0,
    `leader owns [${found_(seededPersonal)}], group holds ${seededInGroup.length}`,
  );

  // RF-68 under per_member: the caller's own cash, never the group's. RF-40: the sources
  // hold the bank and no cash of either owner.
  const groupCash = await open(perMemberLeader, "Harness caja del fondo", "cash", perMemberGroup);
  const memberBank = await open(perMemberLeader, "Harness banco por miembro", "bank", null);
  const perMemberTarget = await asUser(perMemberLeader, () => resolveWithdrawalTarget());
  const sourceIds = perMemberTarget.sourceAccounts.map((a) => a.id);
  assert(
    next("Under per_member a withdrawal targets the caller's own cash, not the group's"),
    perMemberTarget.targetCashAccountId === seededPersonal[0]?.id &&
      perMemberTarget.targetCashAccountId !== groupCash,
    `target ${perMemberTarget.targetCashAccountId}, own cash ${seededPersonal[0]?.id}, group cash ${groupCash}`,
  );
  assert(
    next("Cash never draws from cash: the sources hold the bank and no cash account"),
    sourceIds.includes(memberBank) &&
      !sourceIds.includes(groupCash) &&
      !sourceIds.includes(seededPersonal[0]?.id) &&
      perMemberTarget.sourceAccounts.every((a) => a.subtype !== "cash"),
    `sources [${perMemberTarget.sourceAccounts.map((a) => a.subtype).join(",")}]`,
  );

  // RF-68 under shared: the group's cash, though the caller also owns a cash of their own.
  const sharedLeader = await createMembershipFreeUser();
  const { groupId: sharedGroup } = await asUser(sharedLeader, () =>
    createGroup({ name: "Harness fondo compartido caja", leaderName: "Harness lider", cashMode: "shared", locale: "es" }),
  );
  track("groups", sharedGroup);
  await trackFund(sharedGroup);
  const sharedSeeded = await found("group_id", sharedGroup);
  const ownCash = await open(sharedLeader, "Harness caja propia", "cash", null);
  const sharedTarget = await asUser(sharedLeader, () => resolveWithdrawalTarget());
  assert(
    next("A shared fund seeds one group cash, and the withdrawal target under shared is that account"),
    sharedSeeded.length === 1 &&
      sharedSeeded[0].subtype === "cash" &&
      sharedSeeded[0].owner_user_id === null &&
      sharedTarget.targetCashAccountId === sharedSeeded[0].id &&
      sharedTarget.targetCashAccountId !== ownCash,
    `group holds [${found_(sharedSeeded)}], target ${sharedTarget.targetCashAccountId}, own cash ${ownCash}`,
  );

  // A withdrawal lands in the cash that exists; it creates nothing. Personal on both sides,
  // so the movement is the caller's alone and the identity purge can drop it.
  const holder = await createMembershipFreeUser();
  const holderBank = await open(holder, "Harness banco con caja", "bank", null);
  const holderCash = await open(holder, "Harness caja existente", "cash", null);
  const landed = await asUser(holder, () =>
    withdrawCash({ sourceAccountId: holderBank, amountCents: 100_000, cashAccountName: "Efectivo" }),
  );
  track("transactions", landed.transactionId);
  const landedSubtype = await readColumn<string>("accounts", "id", landed.targetCashAccountId, "subtype");
  const holderAccounts = await found("owner_user_id", holder.id);
  assert(
    next("A withdrawal lands in the existing cash and creates none"),
    landed.createdCashAccount === false &&
      landed.targetCashAccountId === holderCash &&
      landedSubtype === "cash" &&
      holderAccounts.length === 2,
    `created = ${landed.createdCashAccount}, target ${landed.targetCashAccountId} (${landedSubtype}), own cash ${holderCash}, ${holderAccounts.length} accounts`,
  );

  // A personal-only caller with no cash: the first withdrawal creates it as cash, the second reuses it.
  const personal = await createMembershipFreeUser();
  const personalBank = await open(personal, "Harness banco personal", "bank", null);
  const before = await asUser(personal, () => resolveWithdrawalTarget());
  const first = await asUser(personal, () =>
    withdrawCash({ sourceAccountId: personalBank, amountCents: 100_000, cashAccountName: "Efectivo" }),
  );
  const second = await asUser(personal, () =>
    withdrawCash({ sourceAccountId: personalBank, amountCents: 100_000, cashAccountName: "Efectivo" }),
  );
  track("transactions", first.transactionId);
  track("transactions", second.transactionId);
  const createdRows = (await found("owner_user_id", personal.id)).filter((r) => r.subtype !== "bank");
  assert(
    next("A caller with no cash gets one created as cash, and the second withdrawal reuses it"),
    before.targetCashAccountId === null &&
      before.reason === "no-cash-account" &&
      first.createdCashAccount === true &&
      second.createdCashAccount === false &&
      second.targetCashAccountId === first.targetCashAccountId &&
      createdRows.length === 1 &&
      createdRows[0].id === first.targetCashAccountId &&
      createdRows[0].subtype === "cash" &&
      createdRows[0].group_id === null,
    `before ${before.targetCashAccountId}/${before.reason}, first ${first.createdCashAccount}, second ${second.createdCashAccount}, stored [${found_(createdRows)}]`,
  );

  // M22. The lock is taken from outside the app on the exact key the contract names
  // (`cash:` + the scope id), so a withdrawal that takes the same lock must queue behind it
  // and one that takes none, or another key, runs straight through. Polling `pg_locks` says
  // when the app is waiting; nothing here sleeps for a fixed time.
  const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  // Its own connection: `fixtureSql` holds one, and the polling below has to keep using it.
  const holderSql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const holdScopeLock = async (scopeId: string) => {
    let open_!: () => void;
    const gate = new Promise<void>((done) => (open_ = done));
    let taken!: () => void;
    const acquired = new Promise<void>((done) => (taken = done));
    const tx = holderSql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`cash:${scopeId}`}, 0))`;
      taken();
      await gate;
    });
    await acquired;
    return async () => {
      open_();
      await tx;
    };
  };
  const waitingOn = async (scopeId: string) => {
    const [row] = await fixtureSql<{ n: number }[]>`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted
        and ((classid::bigint << 32) | objid::bigint) = hashtextextended(${`cash:${scopeId}`}, 0)`;
    return row.n;
  };
  const waitUntilWaiting = async (scopeId: string, count: number) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if ((await waitingOn(scopeId)) >= count) return true;
      await pause(25);
    }
    return false;
  };
  const cashRows = (userId: string) =>
    fixtureSql<{ id: string; archived: boolean; created_at: Date }[]>`
      select id, archived_at is not null as archived, created_at from accounts
      where owner_user_id = ${userId} and subtype = 'cash' order by created_at`;

  // Two first withdrawals at once: one new cash, both movements in it.
  const racer = await createMembershipFreeUser();
  const racerBank = await open(racer, "Harness banco carrera", "bank", null);
  const releaseRace = await holdScopeLock(racer.id);
  const raceRun = asUser(racer, () =>
    Promise.all([
      withdrawCash({ sourceAccountId: racerBank, amountCents: 100_000, cashAccountName: "Efectivo" }),
      withdrawCash({ sourceAccountId: racerBank, amountCents: 100_000, cashAccountName: "Efectivo" }),
    ]),
  );
  const bothQueued = await waitUntilWaiting(racer.id, 2);
  await releaseRace();
  const raced = await raceRun;
  for (const r of raced) track("transactions", r.transactionId);
  const racerCash = await cashRows(racer.id);
  for (const row of racerCash) track("accounts", row.id);
  const racerMoves = await fixtureSql<{ id: string }[]>`
    select id from transactions where owner_user_id = ${racer.id}`;
  assert(
    next("Two first withdrawals at once queue on the caller's scope lock and land in one new cash"),
    bothQueued &&
      racerCash.length === 1 &&
      raced.filter((r) => r.createdCashAccount).length === 1 &&
      raced.every((r) => r.targetCashAccountId === racerCash[0]?.id) &&
      racerMoves.length === 2,
    `both waited on cash:${racer.id} = ${bothQueued}, ${racerCash.length} cash accounts, created [${raced.map((r) => r.createdCashAccount)}], ${racerMoves.length} movements`,
  );
  const personalMoves = await fixtureSql<
    { from_account_id: string; to_account_id: string; kind: string; splits: number }[]
  >`
    select t.from_account_id, t.to_account_id, t.kind,
      (select count(*)::int from transaction_splits s where s.transaction_id = t.id) as splits
    from transactions t where t.owner_user_id = ${personal.id}`;
  const personalBalance = await readColumn<string>("account_balances", "id", first.targetCashAccountId, "balance_cents");
  assert(
    next("A withdrawal is a plain transfer source to cash with no split, and the cash balance is the sum of what came in"),
    personalMoves.length === 2 &&
      personalMoves.every(
        (m) =>
          m.kind === "transfer" &&
          m.from_account_id === personalBank &&
          m.to_account_id === first.targetCashAccountId &&
          m.splits === 0,
      ) &&
      Number(personalBalance) === 200_000,
    `moves [${personalMoves.map((m) => `${m.kind}/${m.splits}`)}], cash balance ${personalBalance}`,
  );

  // The cash is archived: it is no target, and the next withdrawal opens a new one.
  const archiver = await createMembershipFreeUser();
  const archiverBank = await open(archiver, "Harness banco archivada", "bank", null);
  const archivedCash = await open(archiver, "Harness caja archivada", "cash", null);
  await asUser(archiver, () => archiveAccount({ accountId: archivedCash }));
  const archivedTarget = await asUser(archiver, () => resolveWithdrawalTarget());
  const reopened = await asUser(archiver, () =>
    withdrawCash({ sourceAccountId: archiverBank, amountCents: 50_000, cashAccountName: "Efectivo" }),
  );
  track("transactions", reopened.transactionId);
  const archiverCash = await cashRows(archiver.id);
  for (const row of archiverCash) track("accounts", row.id);
  assert(
    next("An archived cash is no withdrawal target, and withdrawing opens a new cash"),
    archivedTarget.targetCashAccountId === null &&
      archivedTarget.reason === "no-cash-account" &&
      reopened.createdCashAccount === true &&
      reopened.targetCashAccountId !== archivedCash &&
      archiverCash.length === 2 &&
      archiverCash.filter((r) => !r.archived).length === 1 &&
      archiverCash.find((r) => !r.archived)?.id === reopened.targetCashAccountId,
    `target ${archivedTarget.targetCashAccountId}/${archivedTarget.reason}, reopened ${reopened.targetCashAccountId} (created ${reopened.createdCashAccount}), ${archiverCash.length} cash rows`,
  );

  // The group's cash is archived, then the fund goes shared: a live group cash appears.
  const archivedGroupCash = await asUser(perMemberLeader, () => archiveAccount({ accountId: groupCash }));
  await asUser(perMemberLeader, () =>
    updateGroupSettings({ groupId: perMemberGroup, name: "Harness fondo por miembro", cashMode: "shared", locale: "es" }),
  );
  const groupCashRows = await fixtureSql<{ id: string; archived: boolean }[]>`
    select id, archived_at is not null as archived from accounts
    where group_id = ${perMemberGroup} and subtype = 'cash' order by created_at`;
  for (const row of groupCashRows) track("accounts", row.id);
  const liveGroupCash = groupCashRows.filter((r) => !r.archived);
  const groupTarget = await asUser(perMemberLeader, () => resolveWithdrawalTarget());
  assert(
    next("Going shared with the group's only cash archived creates a second, live group cash"),
    archivedGroupCash &&
      groupCashRows.length === 2 &&
      liveGroupCash.length === 1 &&
      liveGroupCash[0].id !== groupCash &&
      groupTarget.targetCashAccountId === liveGroupCash[0]?.id,
    `${groupCashRows.length} group cash rows, ${liveGroupCash.length} live, target ${groupTarget.targetCashAccountId}`,
  );

  // Two live cash accounts: the older one is the target, for the read and for the write.
  const twin = await createMembershipFreeUser();
  const twinBank = await open(twin, "Harness banco gemelas", "bank", null);
  const olderCash = await open(twin, "Harness caja mayor", "cash", null);
  await pause(20);
  await open(twin, "Harness caja menor", "cash", null);
  const twinRows = await cashRows(twin.id);
  const twinTarget = await asUser(twin, () => resolveWithdrawalTarget());
  const twinMove = await asUser(twin, () =>
    withdrawCash({ sourceAccountId: twinBank, amountCents: 10_000, cashAccountName: "Efectivo" }),
  );
  track("transactions", twinMove.transactionId);
  assert(
    next("With two live cash accounts the oldest is the withdrawal target"),
    twinRows.length === 2 &&
      twinRows[0].id === olderCash &&
      twinTarget.targetCashAccountId === olderCash &&
      twinMove.targetCashAccountId === olderCash &&
      twinMove.createdCashAccount === false,
    `oldest ${olderCash}, read target ${twinTarget.targetCashAccountId}, write target ${twinMove.targetCashAccountId}`,
  );

  // Another scope's lock never makes this caller wait: A is held, B runs straight through.
  const slowOne = await createMembershipFreeUser();
  const slowBank = await open(slowOne, "Harness banco lenta", "bank", null);
  const quickOne = await createMembershipFreeUser();
  const quickBank = await open(quickOne, "Harness banco rapida", "bank", null);
  const releaseSlow = await holdScopeLock(slowOne.id);
  let slowSettled = false;
  const slowRun = asUser(slowOne, () =>
    withdrawCash({ sourceAccountId: slowBank, amountCents: 10_000, cashAccountName: "Efectivo" }),
  ).finally(() => {
    slowSettled = true;
  });
  const slowQueued = await waitUntilWaiting(slowOne.id, 1);
  const quickStarted = Date.now();
  const quick = await asUser(quickOne, () =>
    withdrawCash({ sourceAccountId: quickBank, amountCents: 10_000, cashAccountName: "Efectivo" }),
  );
  const quickMs = Date.now() - quickStarted;
  const slowStillWaiting = !slowSettled;
  await releaseSlow();
  const slow = await slowRun;
  track("transactions", quick.transactionId);
  track("transactions", slow.transactionId);
  for (const u of [slowOne, quickOne]) for (const row of await cashRows(u.id)) track("accounts", row.id);
  assert(
    next("A withdrawal waits only on its own scope: another caller's finishes while the first is still queued"),
    slowQueued && slowStillWaiting && quickMs < 2_000 && quick.createdCashAccount && slow.createdCashAccount,
    `first queued ${slowQueued}, still waiting when the second finished ${slowStillWaiting}, second took ${quickMs} ms`,
  );

  // Under 'shared' the scope id is the group's, not the caller's.
  const sharedBank = await open(sharedLeader, "Harness banco del lider compartido", "bank", null);
  const releaseGroup = await holdScopeLock(sharedGroup);
  const groupRun = asUser(sharedLeader, () =>
    withdrawCash({ sourceAccountId: sharedBank, amountCents: 10_000, cashAccountName: "Efectivo" }),
  );
  const groupQueued = await waitUntilWaiting(sharedGroup, 1);
  await releaseGroup();
  const groupMove = await groupRun;
  track("transactions", groupMove.transactionId);
  assert(
    next("Under shared the withdrawal queues on the group's lock and lands in the group's cash"),
    groupQueued && groupMove.targetCashAccountId === sharedSeeded[0]?.id && groupMove.createdCashAccount === false,
    `queued on cash:${sharedGroup} = ${groupQueued}, target ${groupMove.targetCashAccountId}`,
  );
  await holderSql.end();
}

async function main(): Promise<void> {
  // Opened before the first identity, so a kill between the two still leaves a
  // registry row a reaper can find dead: `createHarnessUser` would open the same
  // run on its own, but only once it has something to register under it.
  const run = await openRun("queries", fixtureSql);
  console.log(`REPORT  run ${run} — see harness.runs for a dead one's trail.`);

  const userId = await createHarnessUser();
  console.log(`REPORT  harness user ${userId}, created for this run and dropped after it.`);

  const scope = await seedHarnessScope(userId);
  // The create-a-fund path needs a caller who is in no group; the seeding above
  // made the run's own user a leader.
  const groupless = await createMembershipFreeUser();
  console.log(
    `REPORT  membership-free user ${groupless.id}, who drives the create-a-fund path.`,
  );

  // Read-only sanity, never an assertion: the seeded user's own rows are proof
  // that the connection points at the database the app uses.
  const [seeded] = await fixtureSql<{ accounts: string; categories: string }[]>`
    select
      (select count(*)::text from accounts where owner_user_id = ${SEEDED_USER_ID}) as accounts,
      (select count(*)::text from categories where owner_user_id = ${SEEDED_USER_ID}) as categories`;
  console.log(
    `REPORT  seeded user holds ${seeded.accounts} accounts and ${seeded.categories} categories; nothing below depends on them.`,
  );
  console.log("");

  // Two of the same fixture, because the suites run in order: the write suite restores
  // one, so the read suite would have nothing left to assert on if they shared it.
  const silenced: SilencedFixtures = {
    restored: await seedSilencedShape(userId, "restaurada"),
    listed: await seedSilencedShape(userId, "listada"),
  };

  const debt = await seedDebtFixture(userId, scope);

  // The other side of every write policy on a debt: someone who sees the fund's
  // debts and may write none of them.
  const fellow = await seedFellowMember(userId, scope.groupId);
  console.log(
    `REPORT  fellow member ${fellow.id}, who reads the leader's debts and writes none.`,
  );

  const writes = await writeSuite(userId, scope, groupless, silenced.restored, debt);
  console.log("");
  await readSuite(userId, scope, writes, silenced, debt, groupless, fellow);
  console.log("");
  await invariantSuite(writes, silenced.restored);
  console.log("");
  await statementSuite(debt, scope);
  console.log("");
  await timingSuite();
  console.log("");
  await reconcileSuite(userId, scope, fellow);
  console.log("");
  await reimportSuite(userId, scope);
  console.log("");
  await cashSuite();
  console.log("");
  await roundTripSuite(scope, userId);
  console.log("");
  await weeklyBudgetSuite(scope, userId);
  console.log("");
  await ledgerGuardSuite(userId, scope);
  console.log("");
  await reconcileStrangerSuite(userId, fellow);
  console.log("");
  await recurringRuleCategoryScopeSuite(scope, groupless);
  await recurringRuleCategoryFitSuite(userId, scope, groupless, fellow);
  console.log("");
  await serverEntriesSuite(scope);
  await inviteRefusalSuite();
  await inviteOnEditSuite();
  await e5Suite();
  await e6Suite();
  await importScopeOwnerSuite(userId, scope);
  await adjustmentFilterSuite(userId, scope);
  await negativeCountSuite(userId);
  await importCategoryScopeSuite();
  await categoryScopeSuite();
  await survivorsSuite();
  await idempotencySuite();
}

// The screens' round-trip budgets after the performance pass: the shared form
// options fan out inside ONE transaction, a movement edit pays one statement for
// its cause and none when it is unchanged, and the movements list takes a limit.
async function roundTripSuite(scope: HarnessScope, userId: string): Promise<void> {
  const today = todayInBogota();
  const trips = async (run: () => Promise<unknown>): Promise<number> => {
    const started = roundTrips();
    await run();
    return roundTrips() - started;
  };

  // The first call of a lane opens its connection, which the driver counts too.
  await listAccounts({ archived: false });
  const single = await trips(() => listAccounts({ archived: false }));
  await getTransactionFormOptions();
  const form = await trips(() => getTransactionFormOptions());
  // One transaction: the single read's BEGIN, settle and COMMIT once, plus the
  // other six reads as statements. Seven transactions cost seven times `single`.
  assert(
    next("getTransactionFormOptions opens one transaction, not seven"),
    form === single + 6,
    `${form} round trips for the form options, ${single} for one read of them`,
  );

  const created = await createTransaction({
    fromAccountId: scope.assetAccountId,
    toAccountId: null,
    amountCents: 1100,
    occurredAt: today,
    description: "Harness rendimiento",
    externalRef: null,
    splits: [{ categoryId: scope.categoryId, amountCents: 1100 }],
    labelIds: [],
  });
  keep("transactions", created.transactionId);
  const edit = (causedByTransactionId?: string | null) =>
    updateTransaction({
      transactionId: created.transactionId,
      fromAccountId: scope.assetAccountId,
      toAccountId: null,
      amountCents: 1100,
      occurredAt: today,
      description: "Harness rendimiento",
      splits: [{ categoryId: scope.categoryId, amountCents: 1100 }],
      labelIds: [],
      causedByTransactionId,
    });
  await edit();
  const bare = await trips(() => edit());
  const unchanged = await trips(() => edit(null));
  assert(
    next("An edit that leaves the cause alone pays one statement for it, in its own transaction"),
    unchanged === bare + 1,
    `${unchanged} round trips with the cause sent, ${bare} without it`,
  );

  const other = await createTransaction({
    fromAccountId: scope.assetAccountId,
    toAccountId: null,
    amountCents: 1200,
    occurredAt: today,
    description: "Harness causa",
    externalRef: null,
    splits: [{ categoryId: scope.categoryId, amountCents: 1200 }],
    labelIds: [],
  });
  keep("transactions", other.transactionId);
  await edit(other.transactionId);
  const set = await readColumn<string | null>(
    "transactions",
    "id",
    created.transactionId,
    "caused_by_transaction_id",
  );
  await edit(other.transactionId);
  await edit(null);
  const cleared = await readColumn<string | null>(
    "transactions",
    "id",
    created.transactionId,
    "caused_by_transaction_id",
  );
  assert(
    next("An edit sets, keeps and clears the cause inside the update"),
    set === other.transactionId && cleared === null,
    `cause after setting = ${set}, after clearing = ${cleared}`,
  );

  const capped = await listTransactions({}, { limit: 1 });
  const second = await listTransactions({}, { limit: 1, offset: 1 });
  assert(
    next("listTransactions honours a limit and an offset"),
    capped.length === 1 && second.length <= 1 && second[0]?.id !== capped[0].id,
    `${capped.length} rows at limit 1, offset 1 answered ${second[0]?.id ?? "none"} against ${capped[0]?.id}`,
  );
  // The movements screen caps the rows it draws but never its figures: a
  // 2 001-row set answers a limit of 2 000 and the full count and net.
  const SEEDED = 2001;
  const marker = `Harness tope ${randomUUID()}`;
  // One transaction: the split rule is checked at commit, so the movements and
  // their splits must land together.
  const seeded = await fixtureSql.begin(async (trx) => {
    const rows = await trx<{ id: string }[]>`
      insert into transactions (from_account_id, amount_cents, occurred_at, description, created_by, owner_user_id, group_id)
      select a.id, 100, ${today}::date, ${marker}, ${userId}, a.owner_user_id, a.group_id
      from accounts a, generate_series(1, ${SEEDED})
      where a.id = ${scope.cashAccountId}
      returning transactions.id
    `;
    await trx`
      insert into transaction_splits (transaction_id, category_id, amount_cents)
      select id, ${scope.categoryId}, 100 from transactions where description = ${marker}
    `;
    return rows;
  });
  for (const row of seeded) keep("transactions", row.id);
  const [truth] = await fixtureSql<{ count: number; net: string }[]>`
    select count(*)::int as count, (-sum(amount_cents))::text as net
    from transactions where description = ${marker}
  `;
  const filter = { accountId: scope.cashAccountId };
  const [drawn, totals] = await Promise.all([
    listTransactions(filter, { limit: 2000 }),
    getTransactionTotals(filter),
  ]);
  const [sql_] = await fixtureSql<{ count: number; net: string }[]>`
    select count(*)::int as count,
      coalesce(sum(case kind when 'income' then amount_cents when 'expense' then -amount_cents else 0 end), 0)::text as net
    from transactions where from_account_id = ${scope.cashAccountId} or to_account_id = ${scope.cashAccountId}
  `;
  const netTotal = totals.nets.reduce((sum, n) => sum + n.netCents, 0);
  assert(
    next("A capped movements list keeps the full count and net"),
    drawn.length === 2000 &&
      totals.count === sql_.count &&
      totals.count > 2000 &&
      String(netTotal) === sql_.net &&
      truth.count === SEEDED,
    `${drawn.length} rows drawn, count ${totals.count} against ${sql_.count}, net ${netTotal} against ${sql_.net}`,
  );

  // The shell carries the caller's fund in its one statement (RF-55), so the layout
  // does not pay `getUserGroup` another trip.
  const shell = await getShellSummary();
  const fund = await getUserGroup();
  assert(
    next("The shell summary names the leader's fund as getUserGroup does"),
    fund !== null && shell.group?.id === fund.id && shell.group?.name === fund.name,
    `shell ${JSON.stringify(shell.group)} against ${JSON.stringify(fund && { id: fund.id, name: fund.name })}`,
  );
  const loner = await createMembershipFreeUser();
  const lonerShell = await asUser(loner, () => getShellSummary());
  assert(
    next("The shell summary of a caller with no fund has no group"),
    lonerShell.group === null,
    `group ${JSON.stringify(lonerShell.group)}`,
  );
  const archivedMember = await seedFellowMember(userId, scope.groupId);
  await fixtureSql`update group_members set archived_at = now() where user_id = ${archivedMember.id}`;
  const archivedShell = await asUser(archivedMember, () => getShellSummary());
  const archivedGroup = await asUser(archivedMember, () => getUserGroup());
  assert(
    next("The shell summary of an archived member has no group, as getUserGroup"),
    archivedShell.group === null && archivedGroup === null,
    `shell ${JSON.stringify(archivedShell.group)}, getUserGroup ${JSON.stringify(archivedGroup)}`,
  );
  await getShellSummary();
  const shellTrips = await trips(() => getShellSummary());
  assert(
    next("The shell summary stays one statement"),
    shellTrips === SHELL_TRIPS,
    `${shellTrips} round trips against ${SHELL_TRIPS}`,
  );

  // The home dashboard names its member buckets off the fund's live roster, read
  // in the same fan-out as the figures: no read waits for another (RF-88).
  const roster = await listMembers(scope.groupId, { archived: false });
  const dashboard = await getDashboardData();
  const namedRight = dashboard.netWorth.every((bucket) =>
    bucket.bucket === "group"
      ? bucket.name === fund?.name
      : bucket.ownerUserId === null ||
        bucket.isSelf ||
        bucket.name === (roster.find((m) => m.userId === bucket.ownerUserId)?.name ?? null),
  );
  assert(
    next("The dashboard names each bucket off the live roster"),
    namedRight && dashboard.netWorth.length > 0,
    `${dashboard.netWorth.length} buckets: ${JSON.stringify(dashboard.netWorth.map((b) => [b.bucket, b.name, b.isSelf]))}`,
  );
  // A personal account gives the groupless caller a bucket to label; without one
  // the dashboard is empty and the fallback never runs.
  const lonerAccountId = randomUUID();
  await fixtureSql`
    insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
    values (${lonerAccountId}, ${loner.id}, 'Harness solitario', 'asset', 'bank', 1000, current_date)`;
  track("accounts", lonerAccountId);
  const lonerDashboard = await asUser(loner, () => getDashboardData());
  assert(
    next("The dashboard of a caller with no fund falls back to isSelf"),
    lonerDashboard.netWorth.length > 0 &&
      lonerDashboard.netWorth.every(
        (bucket) => bucket.bucket !== "group" && bucket.name === null && bucket.isSelf,
      ),
    `${JSON.stringify(lonerDashboard.netWorth.map((b) => [b.bucket, b.name, b.isSelf]))}`,
  );
  const DASH_DELAY = 150;
  process.env.HARNESS_CLAIMS_DELAY_MS = String(DASH_DELAY);
  try {
    await getDashboardData();
    const started = performance.now();
    await getDashboardData();
    const elapsed = performance.now() - started;
    assert(
      next("The dashboard reads its roster in the first fan-out: under two claims delays"),
      elapsed < 2 * DASH_DELAY,
      `${Math.round(elapsed)} ms against a budget of ${2 * DASH_DELAY} ms`,
    );
  } finally {
    delete process.env.HARNESS_CLAIMS_DELAY_MS;
  }
}

// A weekly budget on /planning/budgets spans the same Monday-to-Sunday week /planning
// shows (RF-72): today's in the current month, the month's last day's in a past one.
// Dates are fixed and the clock is passed in, so the proof holds on any run day.
async function weeklyBudgetSuite(scope: HarnessScope, userId: string): Promise<void> {
  const book = async (day: string, amountCents: number): Promise<void> => {
    const { transactionId } = await createTransaction({
      fromAccountId: scope.cashAccountId,
      toAccountId: null,
      amountCents,
      occurredAt: day,
      description: "Harness semana gasto",
      externalRef: null,
      splits: [{ categoryId: scope.categoryId, amountCents }],
      labelIds: [],
    });
    keep("transactions", transactionId);
  };
  const { budgetId } = await createBudget({
    ownerUserId: userId,
    groupId: null,
    categoryId: scope.categoryId,
    accountId: scope.cashAccountId,
    labelId: null,
    period: "weekly",
    limitCents: 90_000_000,
    thresholdPct: 80,
    name: "Harness semana presupuesto",
  });
  keep("budgets", budgetId);

  const spentOn = async (today: string, month: string): Promise<number> => {
    const rows = await listBudgetsWithStatus(budgetAnchor(month, today), { today });
    return rows.find((row) => row.id === budgetId)?.spentCents ?? -1;
  };

  // 2026-10-15 is a Thursday: its week is 12-18 Oct; the month's first week is 28 Sep-4 Oct.
  const midWeek = 700_00;
  const firstWeek = 3_000_00;
  const lastWeek = 90_000_00;
  // Other fixtures may book on the same account in these weeks, so each case reads a delta.
  const base = [
    await spentOn("2026-10-15", "2026-10"),
    await spentOn("2026-10-15", "2026-09"),
    await spentOn("2026-10-31", "2026-10"),
  ];
  await book("2026-10-14", midWeek);
  await book("2026-10-02", firstWeek);
  await book("2026-10-28", lastWeek);

  assert(
    next("A weekly budget in the current month spans today's week, not the month's first"),
    (await spentOn("2026-10-15", "2026-10")) - base[0] === midWeek,
    `spent ${(await spentOn("2026-10-15", "2026-10")) - base[0]}, expected ${midWeek} (12-18 Oct, not 28 Sep-4 Oct = ${firstWeek})`,
  );
  assert(
    next("A weekly budget in a past month spans the week of the month's last day"),
    (await spentOn("2026-10-15", "2026-09")) - base[1] === firstWeek &&
      budgetAnchor("2026-09", "2026-10-15") === "2026-09-30",
    `spent ${(await spentOn("2026-10-15", "2026-09")) - base[1]}, anchor ${budgetAnchor("2026-09", "2026-10-15")}`,
  );
  // 2026-10-31 is a Saturday: the month's last day still sits in the week of 26 Oct-1 Nov.
  assert(
    next("On the month's last day the weekly window is still that day's week"),
    budgetAnchor("2026-10", "2026-10-31") === "2026-10-31" &&
      (await spentOn("2026-10-31", "2026-10")) - base[2] === lastWeek,
    `anchor ${budgetAnchor("2026-10", "2026-10-31")}, spent ${(await spentOn("2026-10-31", "2026-10")) - base[2]}, expected ${lastWeek}`,
  );
}

// Wrapped in an async IIFE (not top-level await) so the runner can transpile
// this to CJS and run it on any Node version, not only Node 22's native strip.
void (async () => {
  try {
    await main();
  } catch (error) {
    assert(next("the run completed"), false, `it aborted — ${rootMessage(error)}`);
  } finally {
    // A cleanup that throws is a leak, not a crash: it gets an assertion of its
    // own so the run says which rows it left behind.
    try {
      await cleanup();
    } catch (error) {
      assert(next("the fixtures were dropped"), false, refusal(error));
    }
  }

  report();
})();

// The currency of an account is fixed once it has history, a backup keeps each row's currency, a
// foreign purchase on an asset account is confirmed like a card's, and a recurring rule's cursor never
// moves back over what it booked. Each is driven through the app's own function and read back.
async function ledgerGuardSuite(userId: string, scope: HarnessScope): Promise<void> {
  const today = todayInBogota();
  const prefix = "Harness guard";

  const open = async (
    name: string,
    settlementCurrency: "COP" | "USD",
    amountMinor = 1_000_000,
  ) => {
    const { accountId } = await createAccount({
      name,
      kind: "asset",
      subtype: "bank",
      ownerUserId: userId,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency,
      amountMinor,
      balanceOn: shiftDate(today, -30),
    });
    keep("accounts", accountId);
    return accountId;
  };
  const edit = (accountId: string, settlementCurrency: "COP" | "USD", name: string) =>
    updateAccount({
      accountId,
      name,
      subtype: "bank",
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency,
      amountMinor: 1_000_000,
      balanceOn: shiftDate(today, -30),
    });
  const currencyOf = (accountId: string) =>
    readColumn<string>("accounts", "id", accountId, "settlement_currency");

  // 1. An account's currency holds once it has a movement or a count.
  const fresh = await open(`${prefix} vacia`, "COP");
  await edit(fresh, "USD", `${prefix} vacia`);
  const emptyChanged = await currencyOf(fresh);
  assert(
    next("An account with no history may change its settlement currency"),
    emptyChanged === "USD",
    `currency after the edit = ${emptyChanged}`,
  );

  const used = await open(`${prefix} usada`, "COP");
  const spent = await createTransaction({
    fromAccountId: used,
    toAccountId: null,
    amountCents: 10_000,
    occurredAt: shiftDate(today, -3),
    description: `${prefix} gasto`,
    externalRef: null,
    splits: [{ categoryId: scope.categoryId, amountCents: 10_000 }],
    labelIds: [],
  });
  keep("transactions", spent.transactionId);
  let movementCode = "none";
  try {
    await edit(used, "USD", `${prefix} usada`);
  } catch (error) {
    movementCode = pgErrorCode(error) ?? "none";
  }
  assert(
    next("An account with a movement refuses a new settlement currency"),
    movementCode === "AC001" && (await currencyOf(used)) === "COP",
    `sqlstate ${movementCode}, currency ${await currencyOf(used)}`,
  );

  const action = await updateAccountAction({
    accountId: used,
    name: `${prefix} usada`,
    kind: "asset",
    subtype: "bank",
    isShared: false,
    institution: "",
    lastFour: "",
    settlementCurrency: "USD",
    amount: "10000",
    balanceOn: shiftDate(today, -30),
  });
  assert(
    next("updateAccountAction answers a locked currency with its own key"),
    action?.serverError === "accounts.errors.currencyLocked" && (await currencyOf(used)) === "COP",
    `serverError = ${action?.serverError ?? "none"}`,
  );
  assert(
    next("The locked-currency message exists in both languages"),
    typeof en.accounts.errors.currencyLocked === "string" &&
      typeof es.accounts.errors.currencyLocked === "string",
    "accounts.errors.currencyLocked",
  );

  await edit(used, "COP", `${prefix} renombrada`);
  assert(
    next("An account with history still takes every other edit"),
    (await readColumn<string>("accounts", "id", used, "name")) === `${prefix} renombrada`,
    "renamed with the currency unchanged",
  );

  const counted = await open(`${prefix} contada`, "COP");
  await reconcileAccount({
    accountId: counted,
    reconciledOn: shiftDate(today, -1),
    realMagnitudeCents: 1_000_000,
    expectedDerivedCents: 1_000_000,
  });
  let countCode = "none";
  try {
    await edit(counted, "USD", `${prefix} contada`);
  } catch (error) {
    countCode = pgErrorCode(error) ?? "none";
  }
  assert(
    next("An account with a count and no movement refuses a new settlement currency"),
    countCode === "AC001" && (await currencyOf(counted)) === "COP",
    `sqlstate ${countCode}, currency ${await currencyOf(counted)}`,
  );

  // 3. A foreign purchase on an asset account is confirmed with what was charged (RF-123).
  const debit = await open(`${prefix} debito`, "COP", 100_000_000);
  const purchase = await createTransaction({
    fromAccountId: debit,
    toAccountId: null,
    amountCents: 10_000,
    currency: "USD",
    counterAmountCents: 40_000_000,
    counterIsEstimate: true,
    occurredAt: shiftDate(today, -2),
    description: `${prefix} compra en dolares`,
    externalRef: null,
    splits: [{ categoryId: scope.categoryId, amountCents: 10_000 }],
    labelIds: [],
  });
  keep("transactions", purchase.transactionId);
  const balanceOf = async (accountId: string) =>
    (await fixtureSql<{ balance: string }[]>`
      select private.account_settlement_balance_on(${accountId}, ${today}::date)::text as balance`)[0].balance;
  const before = await balanceOf(debit);
  const confirmed = await recordBilledAmount({
    transactionId: purchase.transactionId,
    accountId: debit,
    currency: "COP",
    billedCents: 41_500_000,
  });
  const after = await balanceOf(debit);
  const [row] = await fixtureSql<{ counter: string; estimate: boolean }[]>`
    select counter_amount_cents::text as counter, counter_is_estimate as estimate
    from transactions where id = ${purchase.transactionId}`;
  assert(
    next("A foreign purchase on an asset account is confirmed with the amount charged"),
    confirmed && row.counter === "41500000" && row.estimate === false &&
      before === "100000000" && after === "58500000",
    `confirmed ${confirmed}, counter ${row.counter}, estimate ${row.estimate}, balance ${before} then ${after}`,
  );
  const again = await recordBilledAmount({
    transactionId: purchase.transactionId,
    accountId: debit,
    currency: "COP",
    billedCents: 1,
  });
  assert(
    next("A confirmed purchase is not confirmed twice"),
    again === false,
    `second confirmation answered ${again}`,
  );

  // 5. A recurring rule's cursor never moves back over a period it booked.
  const { recurringRuleId } = await createRecurringRule({
    fromAccountId: scope.assetAccountId,
    toAccountId: null,
    amountCents: 1_000,
    categoryId: scope.categoryId,
    description: `${prefix} semanal`,
    frequency: "weekly",
    intervalN: 1,
    dayOfMonth: null,
    nextRunOn: shiftDate(today, -14),
    endsOn: null,
  });
  keep("recurring_rules", recurringRuleId);
  await fixtureSql`select private.run_due_recurring_rules(${userId}::uuid)`;
  const booked = await fixtureSql<{ id: string; occurred_at: string }[]>`
    select id, occurred_at::text from transactions where recurring_rule_id = ${recurringRuleId} order by occurred_at`;
  for (const generated of booked) keep("transactions", generated.id);
  const rule = (nextRunOn: string) => ({
    id: recurringRuleId,
    fromAccountId: scope.assetAccountId,
    toAccountId: null,
    amountCents: 1_000,
    categoryId: scope.categoryId,
    description: `${prefix} semanal`,
    frequency: "weekly" as const,
    intervalN: 1,
    dayOfMonth: null,
    nextRunOn,
    endsOn: null,
  });
  const tryNext = async (nextRunOn: string) => {
    try {
      await updateRecurringRule(rule(nextRunOn));
      return "ok";
    } catch (error) {
      return pgErrorCode(error) ?? "none";
    }
  };
  const rewound = await tryNext(booked[0]?.occurred_at ?? "");
  const atLast = await tryNext(booked[booked.length - 1]?.occurred_at ?? "");
  const [cursor] = await fixtureSql<{ next_run_on: string }[]>`
    select next_run_on::text from recurring_rules where id = ${recurringRuleId}`;
  assert(
    next("A recurring rule refuses a next run at or before the last period it booked"),
    booked.length === 3 && rewound === "RR001" && atLast === "RR001" && cursor.next_run_on === shiftDate(today, 7),
    `${booked.length} booked, rewind ${rewound}, at last ${atLast}, cursor ${cursor.next_run_on}`,
  );
  const forward = await tryNext(shiftDate(today, 14));
  await fixtureSql`select private.run_due_recurring_rules(${userId}::uuid)`;
  const [still] = await fixtureSql<{ n: number }[]>`
    select count(*)::int as n from transactions where recurring_rule_id = ${recurringRuleId}`;
  assert(
    next("A recurring rule may still skip ahead, and the cron books nothing twice"),
    forward === "ok" && still.n === 3,
    `forward ${forward}, ${still.n} movements`,
  );
  const ruleAction = await updateRecurringRuleAction({
    ...rule(booked[0].occurred_at),
    amount: "10",
  });
  assert(
    next("updateRecurringRuleAction answers a rewound cursor with its own key"),
    ruleAction?.serverError === "recurringRules.errors.nextRunOnBooked",
    `serverError = ${ruleAction?.serverError ?? "none"}`,
  );
  assert(
    next("The rewound-cursor message exists in both languages"),
    typeof en.recurringRules.errors.nextRunOnBooked === "string" &&
      typeof es.recurringRules.errors.nextRunOnBooked === "string",
    "recurringRules.errors.nextRunOnBooked",
  );

  // 2. A backup keeps each row's currency, and refuses a row its account does not settle in.
  const usdAccount = await open(`${prefix} dolares`, "USD", 500_000);
  const copCard = await open(`${prefix} peso`, "COP");
  const usdSpend = await createTransaction({
    fromAccountId: usdAccount,
    toAccountId: null,
    amountCents: 2_500,
    occurredAt: shiftDate(today, -4),
    description: `${prefix} gasto usd`,
    externalRef: null,
    splits: [{ categoryId: scope.categoryId, amountCents: 2_500 }],
    labelIds: [],
  });
  keep("transactions", usdSpend.transactionId);
  const foreignOnPeso = await createTransaction({
    fromAccountId: copCard,
    toAccountId: null,
    amountCents: 10_000,
    currency: "USD",
    counterAmountCents: 40_000_000,
    counterIsEstimate: false,
    occurredAt: shiftDate(today, -4),
    description: `${prefix} compra en dolares`,
    externalRef: null,
    splits: [{ categoryId: scope.categoryId, amountCents: 10_000 }],
    labelIds: [],
  });
  keep("transactions", foreignOnPeso.transactionId);

  const exported = await readExport({ entityKeys: ["accounts", "transactions"] });
  const sheetAccounts = (exported.accounts ?? []).filter((r) => String(r.name).startsWith(prefix));
  const sheetMovements = (exported.transactions ?? []).filter(
    (r) => String(r.fromAccount ?? "").startsWith(prefix) || String(r.toAccount ?? "").startsWith(prefix),
  );
  const exportedUsd = sheetAccounts.find((r) => r.name === `${prefix} dolares`);
  assert(
    next("The export writes each account's settlement currency"),
    exportedUsd?.settlementCurrency === "USD" &&
      sheetAccounts.find((r) => r.name === `${prefix} peso`)?.settlementCurrency === "COP",
    `usd account exported as ${exportedUsd?.settlementCurrency}`,
  );

  const importer = await createMembershipFreeUser();
  const categoryName = String(
    sheetMovements.find((r) => r.description === `${prefix} gasto usd`)?.category,
  );
  const fileCategory: RawRow = {
    externalRef: null,
    name: categoryName,
    kind: "expense",
    parent: null,
    color: CATEGORY_COLORS[0],
  };
  const fileAccounts = sheetAccounts as unknown as RawRow[];
  const fileMovements = sheetMovements as unknown as RawRow[];
  const importScope = await asUser(importer, () => readImportScope());
  const records = (entity: string): RawRow[] =>
    entity === "accounts" ? fileAccounts : entity === "categories" ? [fileCategory] : fileMovements;
  const refs = buildEffectiveRefs(importScope, records);
  const run = (entity: "accounts" | "categories" | "transactions", raw: RawRow, index: number) =>
    processRow(entity, raw, index, index + 2, refs, importScope.existingRefs[entity]);

  const category = run("categories", fileCategory, 0);
  const accountRows = fileAccounts.map((raw, index) => run("accounts", raw, index));
  const movementRows = fileMovements.map((raw, index) => run("transactions", raw, index));
  const rowOf = (description: string) =>
    movementRows[fileMovements.findIndex((raw) => raw.description === description)];
  const usdRow = rowOf(`${prefix} gasto usd`);
  const foreignRow = rowOf(`${prefix} compra en dolares`);
  const keys = (row: { errors: { key: string }[] }) => row.errors.map((e) => e.key).join(",");
  assert(
    next("A backup row in the account's own currency passes, whatever that currency is"),
    category.errors.length === 0 && accountRows.every((r) => r.errors.length === 0) && usdRow.errors.length === 0,
    `category [${keys(category)}], accounts [${accountRows.map(keys)}], usd movement [${keys(usdRow)}]`,
  );
  assert(
    next("A foreign purchase on a peso account is refused by the import, not booked as pesos"),
    foreignRow.errors.some((e) => e.key === "transactions.errors.currencyMismatch" && e.column === "currency") &&
      foreignRow.object === null,
    `errors [${keys(foreignRow)}]`,
  );
  const blank = run("transactions", { ...fileMovements.find((r) => r.description === `${prefix} gasto usd`)!, currency: null }, 9);
  assert(
    next("A blank currency cell on a foreign account is refused, not read as pesos"),
    blank.errors.some((e) => e.key === "errors.foreignCurrencyUnsupported"),
    `errors [${keys(blank)}]`,
  );

  const input: CommitInput = {
    members: [],
    categories: [{ ...category, object: category.object as never }],
    accounts: accountRows.map((r) => ({ ...r, object: r.object as never })),
    recurringRules: [],
    transactions: [{ ...usdRow, object: usdRow.object as never }],
    adjustments: [],
  };
  let imported = "ok";
  try {
    await asUser(importer, () =>
      withUserDb((tx) => commitImport(tx, input, { userId: importer.id, groupId: null })),
    );
  } catch (error) {
    imported = rootMessage(error);
  }
  const restored = await fixtureSql<{ name: string; currency: string; opening: string; movement: string | null; mcurrency: string | null }[]>`
    select a.name, a.settlement_currency as currency, a.initial_balance_cents::text as opening,
      (select t.amount_cents::text from transactions t where t.from_account_id = a.id limit 1) as movement,
      (select t.currency from transactions t where t.from_account_id = a.id limit 1) as mcurrency
    from accounts a where a.owner_user_id = ${importer.id} order by a.name`;
  const usdCopy = restored.find((r) => r.name === `${prefix} dolares`);
  assert(
    next("A restored dollar account keeps its currency, its opening and its movement in dollars"),
    imported === "ok" && usdCopy?.currency === "USD" && usdCopy.opening === "500000" &&
      usdCopy.movement === "2500" && usdCopy.mcurrency === "USD" &&
      restored.find((r) => r.name === `${prefix} peso`)?.currency === "COP",
    `import ${imported}; ${JSON.stringify(restored)}`,
  );

  const freshScope = await asUser(importer, () => readImportScope());
  const freshRefs = buildEffectiveRefs(freshScope, (entity) => (entity === "accounts" ? fileAccounts : []));
  const usdRaw = fileAccounts.find((r) => r.name === `${prefix} dolares`)!;
  const recurrent = processRow(
    "accounts",
    { ...usdRaw, settlementCurrency: "COP" },
    0,
    2,
    freshRefs,
    freshScope.existingRefs.accounts,
  );
  assert(
    next("A file row cannot change the currency of an account the scope already holds"),
    recurrent.status === "update" &&
      recurrent.errors.some((e) => e.key === "accounts.errors.currencyLocked" && e.column === "settlementCurrency"),
    `status ${recurrent.status}, errors [${keys(recurrent)}]`,
  );
}

/**
 * RF-137: a person who may read an account but not write it learns that, never that the figures
 * went stale. Told «stale» they would reload and try again for ever; told «denied» they stop.
 * Its own account, opened here, so the figures above keep what they asserted on.
 */
async function reconcileStrangerSuite(userId: string, fellow: HarnessUser): Promise<void> {
  const today = todayInBogota();
  const { accountId } = await createAccount({
    name: "Harness cuadre ajena",
    kind: "asset",
    subtype: "bank",
    ownerUserId: userId,
    groupId: null,
    isShared: false,
    institution: null,
    lastFour: null,
    settlementCurrency: "COP",
    amountMinor: 1_000_000,
    balanceOn: shiftDate(today, -10),
  });
  keep("accounts", accountId);

  const sheet = await asUser(fellow, () => getReconcileSheet(accountId, today));
  const rowsOf = async (): Promise<number> => {
    const [row] = await fixtureSql<{ n: number }[]>`
      select count(*)::int as n from account_reconciliations where account_id = ${accountId}`;
    return row.n;
  };
  const current = await asUser(fellow, () =>
    reconcileAccount({
      accountId,
      reconciledOn: today,
      realMagnitudeCents: 2_000_000,
      expectedDerivedCents: sheet?.account.derivedCents ?? -1,
    }),
  );
  const stale = await asUser(fellow, () =>
    reconcileAccount({
      accountId,
      reconciledOn: today,
      realMagnitudeCents: 2_000_000,
      expectedDerivedCents: (sheet?.account.derivedCents ?? 0) + 1,
    }),
  );
  const rows = await rowsOf();
  assert(
    next("A reader who cannot write the account is denied, with a current figure or a stale one"),
    sheet !== null && sheet.account.canWrite === false &&
      !current.ok && current.reason === "denied" &&
      !stale.ok && stale.reason === "denied" &&
      rows === 0,
    `canWrite ${sheet?.account.canWrite}; current figure ${JSON.stringify(current)}; stale figure ${JSON.stringify(stale)}; rows ${rows}`,
  );
}

/**
 * RF-29: a rule's category must be one the person owns, or their fund's. Another person's category
 * is refused when the rule is saved: the database stores it (the foreign key ignores row
 * security), and only the generator's split trigger objects, later, by pausing the rule. The
 * caller shares no fund with the run's own user, so none of its rows are visible to them.
 */
async function recurringRuleCategoryScopeSuite(
  scope: HarnessScope,
  groupless: HarnessUser,
): Promise<void> {
  const today = todayInBogota();
  const { accountId } = await asUser(groupless, () =>
    createAccount({
      name: "Harness regla ajena",
      kind: "asset",
      subtype: "bank",
      ownerUserId: groupless.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 1_000_000,
      balanceOn: shiftDate(today, -10),
    }),
  );
  keep("accounts", accountId);

  const ownCategoryId = randomUUID();
  await fixtureSql`
    insert into categories (id, owner_user_id, name, kind, color)
    values (${ownCategoryId}, ${groupless.id}, 'Harness regla propia', 'expense', '#4C8C4A')`;
  track("categories", ownCategoryId);

  const rule = (categoryId: string) => ({
    fromAccountId: accountId,
    toAccountId: null,
    amount: "10",
    categoryId,
    description: "Harness regla ajena",
    frequency: "weekly" as const,
    intervalN: 1,
    dayOfMonth: null,
    nextRunOn: shiftDate(today, 7),
    endsOn: null,
  });
  const storedRules = async (): Promise<number> => {
    const [row] = await fixtureSql<{ n: number }[]>`
      select count(*)::int as n from recurring_rules where from_account_id = ${accountId}`;
    return row.n;
  };

  const ownFits = await asUser(groupless, () =>
    categoryFitsRuleAccount({ categoryId: ownCategoryId, fromAccountId: accountId, toAccountId: null }),
  );
  const foreignFits = await asUser(groupless, () =>
    categoryFitsRuleAccount({ categoryId: scope.categoryId, fromAccountId: accountId, toAccountId: null }),
  );
  assert(
    next("A rule's category fits when the caller owns it and does not when it is someone else's"),
    ownFits === true && foreignFits === false,
    `own category fits = ${ownFits}, another person's category fits = ${foreignFits}`,
  );

  const refused = await asUser(groupless, () => createRecurringRuleAction(rule(scope.categoryId)));
  const stored = await storedRules();
  // A rule that got stored would block the run's own cleanup of the category it names.
  await fixtureSql`delete from recurring_rules where from_account_id = ${accountId}`;
  assert(
    next("Saving a rule with another person's category is refused and stores nothing"),
    refused?.serverError === "recurringRules.errors.scopeViolation" && stored === 0,
    `serverError = ${refused?.serverError ?? "none"}, ${stored} rule(s) stored`,
  );

  const created = await asUser(groupless, () =>
    createRecurringRule({ ...rule(ownCategoryId), amountCents: 1000 }),
  );
  const ruleId = created.recurringRuleId;
  const rewritten = await asUser(groupless, () =>
    updateRecurringRuleAction({ id: ruleId, ...rule(scope.categoryId) }),
  );
  const [kept] = await fixtureSql<{ category_id: string }[]>`
    select category_id from recurring_rules where from_account_id = ${accountId}`;
  await fixtureSql`delete from recurring_rules where from_account_id = ${accountId}`;
  assert(
    next("Rewriting a rule onto another person's category is refused and keeps the old category"),
    rewritten?.serverError === "recurringRules.errors.scopeViolation" && kept?.category_id === ownCategoryId,
    `serverError = ${rewritten?.serverError ?? "none"}, stored category is own = ${kept?.category_id === ownCategoryId}`,
  );
}

/**
 * RF-29: a category the caller can see still has to fit the rule: the kind its side implies
 * (a source is an expense, a destination income) and the scope of its account. A fund member
 * sees the leader's personal categories, so a visible category of another owner is the case
 * the visibility check alone lets through. A user holds one live membership (RF-55), so a
 * category of a second fund is never visible to the same member and is not driven here.
 * `null` as the caller is the run's own user, the fund's leader.
 */
async function recurringRuleCategoryFitSuite(
  userId: string,
  scope: HarnessScope,
  groupless: HarnessUser,
  fellow: HarnessUser,
): Promise<void> {
  const today = todayInBogota();
  const as = <T>(user: HarnessUser | null, fn: () => Promise<T>): Promise<T> =>
    user === null ? fn() : asUser(user, fn);

  const personalAccount = async (user: HarnessUser | null, ownerId: string, name: string): Promise<string> => {
    const { accountId } = await as(user, () =>
      createAccount({
        name,
        kind: "asset",
        subtype: "bank",
        ownerUserId: ownerId,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor: 1_000_000,
        balanceOn: shiftDate(today, -10),
      }),
    );
    keep("accounts", accountId);
    return accountId;
  };
  const personalCategory = async (ownerId: string, kind: "expense" | "income", name: string): Promise<string> => {
    const id = randomUUID();
    await fixtureSql`
      insert into categories (id, owner_user_id, name, kind, color)
      values (${id}, ${ownerId}, ${name}, ${kind}, '#4C8C4A')`;
    track("categories", id);
    return id;
  };
  const fits = (
    user: HarnessUser | null,
    categoryId: string,
    side: "source" | "destination",
    accountId: string,
  ): Promise<boolean> =>
    as(user, () =>
      categoryFitsRuleAccount({
        categoryId,
        fromAccountId: side === "source" ? accountId : null,
        toAccountId: side === "destination" ? accountId : null,
      }),
    );

  const accountId = await personalAccount(groupless, groupless.id, "Harness regla ajuste");
  const expenseId = await personalCategory(groupless.id, "expense", "Harness ajuste gasto");
  const incomeId = await personalCategory(groupless.id, "income", "Harness ajuste ingreso");

  const expenseOnSource = await fits(groupless, expenseId, "source", accountId);
  const incomeOnDestination = await fits(groupless, incomeId, "destination", accountId);
  const incomeOnSource = await fits(groupless, incomeId, "source", accountId);
  const expenseOnDestination = await fits(groupless, expenseId, "destination", accountId);
  assert(
    next("An own category fits only the kind its side implies: expense on a source, income on a destination"),
    expenseOnSource === true &&
      incomeOnDestination === true &&
      incomeOnSource === false &&
      expenseOnDestination === false,
    `expense on source = ${expenseOnSource}, income on destination = ${incomeOnDestination}, income on source = ${incomeOnSource}, expense on destination = ${expenseOnDestination}`,
  );

  const refused = await asUser(groupless, () =>
    createRecurringRuleAction({
      fromAccountId: accountId,
      toAccountId: null,
      amount: "10",
      categoryId: incomeId,
      description: "Harness regla ajuste",
      frequency: "weekly" as const,
      intervalN: 1,
      dayOfMonth: null,
      nextRunOn: shiftDate(today, 7),
      endsOn: null,
    }),
  );
  const [{ n: stored }] = await fixtureSql<{ n: number }[]>`
    select count(*)::int as n from recurring_rules where from_account_id = ${accountId}`;
  await fixtureSql`delete from recurring_rules where from_account_id = ${accountId}`;
  assert(
    next("Saving an expense rule with an income category is refused and stores nothing"),
    refused?.serverError === "recurringRules.errors.scopeViolation" && stored === 0,
    `serverError = ${refused?.serverError ?? "none"}, ${stored} rule(s) stored`,
  );

  // The fellow sees the leader's personal category through the fund, yet it is not theirs.
  const fellowAccount = await personalAccount(fellow, fellow.id, "Harness regla miembra");
  const leaderCategory = await personalCategory(userId, "expense", "Harness ajuste líder");
  const fellowCategory = await personalCategory(fellow.id, "expense", "Harness ajuste miembra");
  const fellowOwn = await fits(fellow, fellowCategory, "source", fellowAccount);
  const leadersVisible = await fits(fellow, leaderCategory, "source", fellowAccount);
  assert(
    next("A personal account takes its owner's category, not the leader's personal one a fellow can see"),
    fellowOwn === true && leadersVisible === false,
    `fellow's own category fits = ${fellowOwn}, the leader's visible personal category fits = ${leadersVisible}`,
  );

  const leaderAccount = await personalAccount(null, userId, "Harness regla líder");
  const fundCategoryId = randomUUID();
  await fixtureSql`
    insert into categories (id, group_id, name, kind, color)
    values (${fundCategoryId}, ${scope.groupId}, 'Harness ajuste fondo', 'expense', '#4C8C4A')`;
  track("categories", fundCategoryId);
  const fundCategory = await fits(null, fundCategoryId, "source", leaderAccount);
  assert(
    next("A fund's category does not fit a personal account of its member"),
    fundCategory === false,
    `fund category on a personal account fits = ${fundCategory}`,
  );

  // A category deleted under the open form is a stale pick, not a scope breach: the guard lets it
  // through so the foreign key answers `referenceGone`.
  const goneId = await personalCategory(groupless.id, "expense", "Harness ajuste borrada");
  await fixtureSql`delete from categories where id = ${goneId}`;
  const goneFits = await fits(groupless, goneId, "source", accountId);
  const goneRefused = await asUser(groupless, () =>
    createRecurringRuleAction({
      fromAccountId: accountId,
      toAccountId: null,
      amount: "10",
      categoryId: goneId,
      description: "Harness regla borrada",
      frequency: "weekly" as const,
      intervalN: 1,
      dayOfMonth: null,
      nextRunOn: shiftDate(today, 7),
      endsOn: null,
    }),
  );
  const [{ n: goneStored }] = await fixtureSql<{ n: number }[]>`
    select count(*)::int as n from recurring_rules where from_account_id = ${accountId}`;
  assert(
    next("A deleted category reads as a stale pick (referenceGone), not a scope violation, and stores nothing"),
    goneFits === true && goneRefused?.serverError === "errors.referenceGone" && goneStored === 0,
    `deleted category fits = ${goneFits}, serverError = ${goneRefused?.serverError ?? "none"}, ${goneStored} rule(s) stored`,
  );

  // A category of a fund the caller is not in exists but is unseen: scopeViolation, never referenceGone.
  const foreignFundCategoryId = randomUUID();
  await fixtureSql`
    insert into categories (id, group_id, name, kind, color)
    values (${foreignFundCategoryId}, ${scope.groupId}, 'Harness ajuste fondo ajeno', 'expense', '#4C8C4A')`;
  track("categories", foreignFundCategoryId);
  const foreignFundRule = (categoryId: string) => ({
    fromAccountId: accountId,
    toAccountId: null,
    amount: "10",
    categoryId,
    description: "Harness regla fondo ajeno",
    frequency: "weekly" as const,
    intervalN: 1,
    dayOfMonth: null,
    nextRunOn: shiftDate(today, 7),
    endsOn: null,
  });
  const fundCreateRefused = await asUser(groupless, () =>
    createRecurringRuleAction(foreignFundRule(foreignFundCategoryId)),
  );
  const [{ n: fundCreateStored }] = await fixtureSql<{ n: number }[]>`
    select count(*)::int as n from recurring_rules where from_account_id = ${accountId}`;
  await fixtureSql`delete from recurring_rules where from_account_id = ${accountId}`;
  assert(
    next("Saving a rule with the category of a fund the caller is not in is a scope violation and stores nothing"),
    fundCreateRefused?.serverError === "recurringRules.errors.scopeViolation" && fundCreateStored === 0,
    `serverError = ${fundCreateRefused?.serverError ?? "none"}, ${fundCreateStored} rule(s) stored`,
  );

  const heldRule = await asUser(groupless, () =>
    createRecurringRule({ ...foreignFundRule(expenseId), amountCents: 1000 }),
  );
  const fundUpdateRefused = await asUser(groupless, () =>
    updateRecurringRuleAction({ id: heldRule.recurringRuleId, ...foreignFundRule(foreignFundCategoryId) }),
  );
  const [fundKept] = await fixtureSql<{ category_id: string }[]>`
    select category_id from recurring_rules where from_account_id = ${accountId}`;
  await fixtureSql`delete from recurring_rules where from_account_id = ${accountId}`;
  assert(
    next("Rewriting a rule onto the category of a fund the caller is not in is a scope violation and keeps the old one"),
    fundUpdateRefused?.serverError === "recurringRules.errors.scopeViolation" && fundKept?.category_id === expenseId,
    `serverError = ${fundUpdateRefused?.serverError ?? "none"}, stored category is own = ${fundKept?.category_id === expenseId}`,
  );
}

// E4: the invite validates with the schema its form uses, the two data routes overlap
// their session check with their reads, and two uncalled write endpoints are gone.
async function serverEntriesSuite(scope: HarnessScope): Promise<void> {
  // Earlier suites let `groupless` found a fund, so this one needs a user who still has none.
  const groupless = await createMembershipFreeUser();
  const members = (await import("@/app/actions/members")) as Record<string, unknown>;
  type InviteResult = {
    data?: { memberId: string; inviteEmailFailed: boolean };
    serverError?: string;
    validationErrors?: { fieldErrors?: { email?: string[] } };
  };
  const invite = members.inviteMemberByEmailAction as
    | ((input: { email: string }) => Promise<InviteResult>)
    | undefined;

  const longAddress = `${"a".repeat(81 - "@example.invalid".length)}@example.invalid`;
  // RF-148: the invitation is Auth's admin invite; the code mail must never be asked for here.
  const invites = (): { email: string; redirectTo?: string }[] =>
    ((globalThis as { harnessAdminInvites?: { email: string; redirectTo?: string }[] }).harnessAdminInvites ??= []);
  const codeMails = (): string[] =>
    ((globalThis as { harnessInvitesSent?: string[] }).harnessInvitesSent ??= []);
  const sent = (): string[] => [...invites().map((i) => i.email), ...codeMails()];
  const storedFor = async (email: string) =>
    fixtureSql<{ id: string; name: string; invite_email: string | null }[]>`
      select id, name, invite_email from group_members
      where group_id = ${scope.groupId} and invite_email = ${email}`;

  const accepted = invite ? await invite({ email: longAddress }) : undefined;
  const rows = await storedFor(longAddress);
  for (const row of rows) track("group_members", row.id);
  assert(
    next("Inviting an address of 81 characters creates the member under a name cut to 80 and asks Auth for the invitation, not the code mail"),
    accepted?.data?.inviteEmailFailed === false &&
      rows.length === 1 &&
      rows[0].name === longAddress.slice(0, 80) &&
      rows[0].invite_email === longAddress &&
      invites().some((i) => i.email === longAddress && i.redirectTo?.endsWith("/login")) &&
      !codeMails().includes(longAddress),
    `data = ${JSON.stringify(accepted?.data)}, serverError = ${accepted?.serverError ?? "none"}, ${rows.length} row(s), name length ${rows[0]?.name.length}, invites asked = ${JSON.stringify(invites().filter((i) => i.email === longAddress))}, code mail = ${codeMails().includes(longAddress)}`,
  );

  const mailsBefore = sent().length;
  const forged = invite ? await invite({ email: "x" }) : undefined;
  const forgedRows = await storedFor("x");
  assert(
    next("A forged invite with a malformed address is refused by the form's schema, stores nothing and sends nothing"),
    forged?.validationErrors?.fieldErrors?.email?.[0] === "members.errors.emailInvalid" &&
      forged?.data === undefined &&
      forgedRows.length === 0 &&
      sent().length === mailsBefore,
    `field error = ${forged?.validationErrors?.fieldErrors?.email?.[0] ?? "none"}, ${forgedRows.length} row(s), mails sent = ${sent().length - mailsBefore}`,
  );

  const blank = invite ? await invite({ email: "  " }) : undefined;
  assert(
    next("A blank invite is refused with the email-invalid key"),
    blank?.validationErrors?.fieldErrors?.email?.[0] === "members.errors.emailInvalid" && blank?.data === undefined,
    `field error = ${blank?.validationErrors?.fieldErrors?.email?.[0] ?? "none"}`,
  );

  const strayAddress = `stray-${randomUUID()}@example.com`;
  const mailsBeforeStray = sent().length;
  const stray = invite ? await asUser(groupless, () => invite({ email: strayAddress })) : undefined;
  assert(
    next("A caller with no fund who invites is refused as not found and sends nothing"),
    stray?.serverError === "errors.notFound" && sent().length === mailsBeforeStray,
    `serverError = ${stray?.serverError ?? "none"}, mails sent = ${sent().length - mailsBeforeStray}`,
  );

  const createdByHand = members.createMemberAction;
  assert(
    next("The name-and-email member form keeps its action"),
    typeof createdByHand === "function",
    `createMemberAction is ${typeof createdByHand}`,
  );

  const debtActions = (await import("@/app/actions/debt-terms")) as Record<string, unknown>;
  const ruleActions = (await import("@/app/actions/recurring-rules")) as Record<string, unknown>;
  assert(
    next("The two uncalled write endpoints are gone and their live neighbours remain"),
    !("deleteDebtTermsAction" in debtActions) &&
      !("setRecurringRuleEndDateAction" in ruleActions) &&
      typeof debtActions.saveDebtTermsAction === "function" &&
      typeof ruleActions.pauseRecurringRuleAction === "function",
    `deleteDebtTermsAction = ${"deleteDebtTermsAction" in debtActions}, setRecurringRuleEndDateAction = ${"setRecurringRuleEndDateAction" in ruleActions}`,
  );

  // Every claims read costs DELAY ms. A route that awaits its session check before its
  // reads pays that twice; one that overlaps them pays it once, like the read alone.
  const DELAY = 600;
  const { NextRequest } = await import("next/server");
  const exportRoute = await import("@/app/[locale]/(app)/settings/data/export/route");
  const templateRoute = await import("@/app/[locale]/(app)/settings/data/template/route");
  const call = (route: { GET: (request: never, context: never) => Promise<Response> }, path: string) =>
    route.GET(
      new NextRequest(`http://localhost${path}`) as never,
      { params: Promise.resolve({ locale: "es" }) } as never,
    );

  process.env.HARNESS_CLAIMS_DELAY_MS = String(DELAY);
  try {
    const timed = async (run: () => Promise<unknown>): Promise<number> => {
      const started = performance.now();
      await run();
      return performance.now() - started;
    };
    await call(exportRoute, "/es/settings/data/export"); // warms the connection
    const readAlone = await timed(() => readExport({ entityKeys: ["accounts", "categories"] }));
    let exportResponse: Response | undefined;
    const exportMs = await timed(async () => {
      exportResponse = await call(exportRoute, "/es/settings/data/export?entities=accounts,categories");
    });
    let templateResponse: Response | undefined;
    const templateMs = await timed(async () => {
      templateResponse = await call(templateRoute, "/es/settings/data/template");
    });
    const budget = readAlone + DELAY / 2;
    assert(
      next("The export route overlaps its session check with its reads: one claims delay, not two"),
      exportResponse?.status === 200 && exportMs < budget,
      `route ${Math.round(exportMs)} ms against ${Math.round(readAlone)} ms for the read alone (budget ${Math.round(budget)} ms), status ${exportResponse?.status}`,
    );
    assert(
      next("The template route overlaps its session check with its reads: one claims delay, not two"),
      templateResponse?.status === 200 && templateMs < budget,
      `route ${Math.round(templateMs)} ms against ${Math.round(readAlone)} ms for the read alone (budget ${Math.round(budget)} ms), status ${templateResponse?.status}`,
    );
  } finally {
    delete process.env.HARNESS_CLAIMS_DELAY_MS;
  }
}
// ---------------------------------------------------------------------------
// E5 · settings loaders in one transaction, one listing predicate, one minimum-payment
// rule, one seed walk. Written from the contract, so each module the plan adds is reached
// through a dynamic import: a missing export fails its own assertion, never the whole run.
// ---------------------------------------------------------------------------

// The driver's own debug hook, wrapped once: every statement the pool puts on the wire,
// text included, so "one transaction" is counted as BEGINs rather than inferred from a
// round-trip formula that depends on how many reads a loader happens to need.
const wiredStatements: string[] = [];
let wiredCapture = false;

function wireStatementLog(): void {
  const options = (
    globalThis as unknown as {
      sql: { options: { debug: (...args: unknown[]) => void } };
    }
  ).sql.options;
  const original = options.debug;
  options.debug = (...args: unknown[]) => {
    if (wiredCapture) wiredStatements.push(String(args[1]));
    original(...args);
  };
}

async function statementsOf<T>(run: () => Promise<T>): Promise<{ value: T; texts: string[] }> {
  wiredStatements.length = 0;
  wiredCapture = true;
  try {
    const value = await run();
    return { value, texts: [...wiredStatements] };
  } finally {
    wiredCapture = false;
  }
}

const beginsIn = (texts: string[]): number => texts.filter((t) => /^\s*begin\b/i.test(t)).length;
const settlesIn = (texts: string[]): number => texts.filter((t) => /set_config/i.test(t)).length;
const readsOf = (texts: string[], table: string): number =>
  texts.filter((t) => new RegExp(`\\bfrom\\s+(?:"\\w+"\\.)?"${table}"`, "i").test(t)).length;

// A module the plan adds, or the reason it is not there: the assertion that needs it fails
// by name instead of the whole run failing on a link error.
async function loadE5Module(specifier: string): Promise<Record<string, unknown>> {
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function attempt<T>(run: () => Promise<T>): Promise<{ value: T | null; error: string }> {
  try {
    return { value: await run(), error: "" };
  } catch (error) {
    return { value: null, error: rootMessage(error) };
  }
}

type E5Node = {
  id: string;
  name: string;
  color: string | null;
  childCount: number;
  children: { id: string; name: string; color: string | null }[];
};
type E5Member = {
  id: string;
  name: string;
  role: string;
  userId: string | null;
  inviteEmail: string | null;
  archivedAt: Date | null;
};
type E5MembersScreen = { members: E5Member[]; isLeader: boolean } | null;
type E5CategoriesScreen = {
  groupName: string | null;
  isLeader: boolean;
  categories: E5Node[];
  personal: E5Node[];
  group: E5Node[];
  parents: { id: string; name: string }[];
  usedColors: string[];
  usedColorsByPlacement: { personal: string[]; group: string[] };
};
type E5Label = { id: string; name: string; color: string | null; movementCount: number; budgetCount: number };
type E5LabelsScreen = {
  groupName: string | null;
  isLeader: boolean;
  personal: E5Label[];
  group: E5Label[];
  usedColors: { personal: string[]; group: string[] };
};

type E5Owner = { column: "owner_user_id" | "group_id"; id: string };

// The category tree of one scope and kind, straight from the table: parents by name, each
// with its children by name. The loader's nodes are folded to the same strings to compare.
async function rawCategoryTree(owner: E5Owner, kind: "expense" | "income"): Promise<string[]> {
  const rows = await fixtureSql<{ name: string; kids: string }[]>`
    select p.name, coalesce(string_agg(c.name, ',' order by c.name), '') as kids
    from categories p
    left join categories c on c.parent_id = p.id
    where p.parent_id is null and p.kind = ${kind} and p.${fixtureSql(owner.column)} = ${owner.id}
    group by p.id, p.name
    order by p.name`;
  return rows.map((row) => `${row.name}[${row.kids}]`);
}

const foldNodes = (nodes: E5Node[]): string[] =>
  nodes.map((node) => `${node.name}[${node.children.map((child) => child.name).join(",")}]`);

async function rawParentIds(owner: E5Owner, kind: "expense" | "income"): Promise<string[]> {
  const rows = await fixtureSql<{ id: string }[]>`
    select id from categories
    where parent_id is null and kind = ${kind} and ${fixtureSql(owner.column)} = ${owner.id}
    order by name`;
  return rows.map((row) => row.id);
}

async function rawTopColors(owner: E5Owner): Promise<string[]> {
  const rows = await fixtureSql<{ color: string }[]>`
    select distinct color from categories
    where parent_id is null and color is not null and ${fixtureSql(owner.column)} = ${owner.id}
    order by color`;
  return rows.map((row) => row.color);
}

async function rawLabels(owner: E5Owner): Promise<string[]> {
  const rows = await fixtureSql<{ name: string; color: string | null; mc: number; bc: number }[]>`
    select l.name, l.color,
      (select count(*)::int from transaction_labels tl where tl.label_id = l.id) as mc,
      (select count(*)::int from budgets b where b.label_id = l.id) as bc
    from labels l where l.${fixtureSql(owner.column)} = ${owner.id}
    order by l.name`;
  return rows.map((row) => `${row.name}|${row.color}|${row.mc}|${row.bc}`);
}

async function rawLabelColors(owner: E5Owner): Promise<string[]> {
  const rows = await fixtureSql<{ color: string }[]>`
    select distinct color from labels
    where color is not null and ${fixtureSql(owner.column)} = ${owner.id} order by color`;
  return rows.map((row) => row.color);
}

const foldLabels = (rows: E5Label[]): string[] =>
  rows.map((row) => `${row.name}|${row.color}|${row.movementCount}|${row.budgetCount}`);

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, index) => value === b[index]);
const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  sameList([...a].sort(), [...b].sort());

// A movement as the fixture knows it: what a person would say about it, written from the
// scenario and never read back from a query. The expected set of every filter is computed
// from these.
type E5Movement = {
  ref: string;
  kind: "income" | "expense" | "transfer";
  accounts: string[];
  categories: string[];
  labels: string[];
  creator: string;
  rule: boolean;
  reviewed: boolean;
  awaiting: boolean;
};

async function e5Suite(): Promise<void> {
  wireStatementLog();
  const today = todayInBogota();
  const tag = randomUUID().slice(0, 8);

  const leader = await createMembershipFreeUser();
  const groupName = `Harness fondo ajustes ${tag}`;
  const { groupId } = await asUser(leader, () =>
    createGroup({ name: groupName, leaderName: "Harness lider ajustes", cashMode: "shared", locale: "es" }),
  );
  track("groups", groupId);
  const [seeded] = await fixtureSql<{ member_id: string; account_id: string }[]>`
    select
      (select id from group_members where group_id = ${groupId} and user_id = ${leader.id}) as member_id,
      (select id from accounts where group_id = ${groupId} and subtype = 'cash') as account_id`;
  track("group_members", seeded.member_id);
  track("accounts", seeded.account_id);
  const seededCategories = await fixtureSql<{ id: string }[]>`
    select id from categories where group_id = ${groupId}`;
  for (const row of seededCategories) track("categories", row.id);
  const cashId = seeded.account_id;

  const fellow = await seedFellowMember(leader.id, groupId);
  await seedPendingInvite({
    groupId,
    memberId: randomUUID(),
    actorId: leader.id,
    name: "Harness invitada viva",
    email: `e5-live-${tag}@harness.invalid`,
    archived: false,
  });
  await seedPendingInvite({
    groupId,
    memberId: randomUUID(),
    actorId: leader.id,
    name: "Harness invitada archivada",
    email: `e5-archived-${tag}@harness.invalid`,
    archived: true,
  });

  const { accountId: bankId } = await asUser(leader, () =>
    createAccount({
      name: `Harness banco del fondo ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: null,
      groupId,
      isShared: true,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 5_000_000,
      balanceOn: shiftDate(today, -10),
    }),
  );
  keep("accounts", bankId);
  const { accountId: ownAccountId } = await asUser(leader, () =>
    createAccount({
      name: `Harness cuenta propia ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: leader.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 2_000_000,
      balanceOn: shiftDate(today, -10),
    }),
  );
  keep("accounts", ownAccountId);

  const [expenseOne, expenseTwo] = (
    await fixtureSql<{ id: string }[]>`
      select id from categories
      where group_id = ${groupId} and kind = 'expense' and parent_id is null order by name limit 2`
  ).map((row) => row.id);
  const [incomeOne] = (
    await fixtureSql<{ id: string }[]>`
      select id from categories
      where group_id = ${groupId} and kind = 'income' and parent_id is null order by name limit 1`
  ).map((row) => row.id);

  // The leader's personal set: it must differ from the group's, or "personal" and "group"
  // could be swapped without a figure moving.
  const personalScope = { ownerUserId: leader.id } as const;
  const { categoryId: ownParent } = await asUser(leader, () =>
    createCategory({ scope: personalScope, name: `Harness propia gastos ${tag}`, kind: "expense", parentId: null, color: "#0E7490" }),
  );
  const { categoryId: ownChild } = await asUser(leader, () =>
    createCategory({ scope: personalScope, name: `Harness propia hija ${tag}`, kind: "expense", parentId: ownParent, color: "#7C3AED" }),
  );
  const { categoryId: ownIncome } = await asUser(leader, () =>
    createCategory({ scope: personalScope, name: `Harness propia ingreso ${tag}`, kind: "income", parentId: null, color: "#15803D" }),
  );
  for (const id of [ownParent, ownChild, ownIncome]) track("categories", id);

  const groupLabelUsed = (await asUser(leader, () =>
    createLabel({ scope: { groupId }, name: `Harness grupo usada ${tag}`, color: "#B45309" }),
  )).labelId;
  const groupLabelFree = (await asUser(leader, () =>
    createLabel({ scope: { groupId }, name: `Harness grupo libre ${tag}`, color: "#BE185D" }),
  )).labelId;
  const ownLabelUsed = (await asUser(leader, () =>
    createLabel({ scope: personalScope, name: `Harness propia usada ${tag}`, color: "#1D4ED8" }),
  )).labelId;
  const ownLabelFree = (await asUser(leader, () =>
    createLabel({ scope: personalScope, name: `Harness propia libre ${tag}`, color: "#047857" }),
  )).labelId;
  for (const id of [groupLabelUsed, groupLabelFree, ownLabelUsed, ownLabelFree]) track("labels", id);

  // Movements. Every one is written through the app's own createTransaction, as the person
  // it names; the review flags go in after, as the owner, because nothing in the app writes
  // `awaiting_counterparty` yet and the rule stamp comes from the generator.
  const { recurringRuleId } = await asUser(leader, () =>
    createRecurringRule({
      fromAccountId: cashId,
      toAccountId: null,
      amountCents: 30_000,
      categoryId: expenseOne,
      description: `Harness regla ${tag}`,
      frequency: "monthly",
      intervalN: 1,
      dayOfMonth: 5,
      nextRunOn: shiftDate(today, 20),
      endsOn: null,
    }),
  );
  keep("recurring_rules", recurringRuleId);

  const model: E5Movement[] = [];
  const ids = new Map<string, string>();
  const book = async (
    who: HarnessUser,
    entry: Omit<E5Movement, "creator" | "rule" | "reviewed" | "awaiting"> &
      Partial<Pick<E5Movement, "rule" | "reviewed" | "awaiting">>,
    from: string | null,
    to: string | null,
    amount: number,
  ): Promise<void> => {
    const { transactionId } = await asUser(who, () =>
      createTransaction({
        fromAccountId: from,
        toAccountId: to,
        amountCents: amount,
        occurredAt: today,
        description: entry.ref,
        externalRef: entry.ref,
        splits: entry.categories.map((categoryId) => ({ categoryId, amountCents: amount })),
        labelIds: entry.labels,
      }),
    );
    keep("transactions", transactionId);
    ids.set(entry.ref, transactionId);
    model.push({ rule: false, reviewed: false, awaiting: false, ...entry, creator: who.id });
  };
  const r = (suffix: string) => `e5-${tag}-${suffix}`;

  await book(leader, { ref: r("m1"), kind: "expense", accounts: [cashId], categories: [expenseOne], labels: [groupLabelUsed] }, cashId, null, 11_100);
  await book(fellow, { ref: r("m2"), kind: "expense", accounts: [bankId], categories: [expenseTwo], labels: [] }, bankId, null, 12_200);
  await book(leader, { ref: r("m3"), kind: "income", accounts: [cashId], categories: [incomeOne], labels: [] }, null, cashId, 13_300);
  await book(leader, { ref: r("m4"), kind: "transfer", accounts: [cashId, bankId], categories: [], labels: [] }, cashId, bankId, 14_400);
  await book(leader, { ref: r("m5"), kind: "expense", accounts: [cashId], categories: [expenseOne], labels: [], rule: true }, cashId, null, 15_500);
  await book(leader, { ref: r("m6"), kind: "expense", accounts: [cashId], categories: [expenseTwo], labels: [], awaiting: true }, cashId, null, 16_600);
  await book(leader, { ref: r("m7"), kind: "expense", accounts: [cashId], categories: [expenseTwo], labels: [], awaiting: true, reviewed: true }, cashId, null, 17_700);
  await book(leader, { ref: r("m8"), kind: "expense", accounts: [cashId], categories: [expenseTwo], labels: [], rule: true, reviewed: true }, cashId, null, 18_800);
  await book(leader, { ref: r("m9"), kind: "expense", accounts: [ownAccountId], categories: [ownParent], labels: [ownLabelUsed] }, ownAccountId, null, 19_900);

  await asOwner(leader.id, async (tx) => {
    for (const m of model) {
      if (m.rule) await tx`update transactions set recurring_rule_id = ${recurringRuleId} where id = ${ids.get(m.ref)!}`;
      if (m.awaiting) await tx`update transactions set awaiting_counterparty = true where id = ${ids.get(m.ref)!}`;
      if (m.reviewed) await tx`update transactions set reviewed_at = now() where id = ${ids.get(m.ref)!}`;
    }
  });

  const { budgetId: groupBudget } = await asUser(leader, () =>
    createBudget({ ownerUserId: null, groupId, categoryId: expenseOne, accountId: null, labelId: groupLabelUsed, period: "monthly", limitCents: 90_000, thresholdPct: 80, name: `Harness presupuesto grupo ${tag}` }),
  );
  keep("budgets", groupBudget);
  const { budgetId: ownBudget } = await asUser(leader, () =>
    createBudget({ ownerUserId: leader.id, groupId: null, categoryId: ownParent, accountId: null, labelId: ownLabelUsed, period: "monthly", limitCents: 90_000, thresholdPct: 80, name: `Harness presupuesto propio ${tag}` }),
  );
  keep("budgets", ownBudget);

  const solo = await createMembershipFreeUser();
  const soloScope = { ownerUserId: solo.id } as const;
  const soloIds: string[] = [];
  const { categoryId: soloParent } = await asUser(solo, () =>
    createCategory({ scope: soloScope, name: `Harness solo gastos ${tag}`, kind: "expense", parentId: null, color: "#0369A1" }),
  );
  const { categoryId: soloChild } = await asUser(solo, () =>
    createCategory({ scope: soloScope, name: `Harness solo hija ${tag}`, kind: "expense", parentId: soloParent, color: "#9333EA" }),
  );
  const { categoryId: soloOther } = await asUser(solo, () =>
    createCategory({ scope: soloScope, name: `Harness solo otra ${tag}`, kind: "expense", parentId: null, color: "#C2410C" }),
  );
  soloIds.push(soloParent, soloChild, soloOther);
  for (const id of soloIds) track("categories", id);
  const soloLabel = (await asUser(solo, () =>
    createLabel({ scope: soloScope, name: `Harness solo etiqueta ${tag}`, color: "#0F766E" }),
  )).labelId;
  track("labels", soloLabel);

  console.log(`REPORT  e5 identities: leader ${leader.id}, fellow ${fellow.id}, solo ${solo.id}.`);
  const asLeader = <T>(run: () => Promise<T>) => asUser(leader, run);
  const groupOwner: E5Owner = { column: "group_id", id: groupId };
  const leaderOwner: E5Owner = { column: "owner_user_id", id: leader.id };
  const soloOwner: E5Owner = { column: "owner_user_id", id: solo.id };

  const membersMod = await loadE5Module("@/db/queries/group-members");
  const categoriesMod = await loadE5Module("@/db/queries/categories");
  const labelsMod = await loadE5Module("@/db/queries/labels");
  const membersLoader = membersMod.getMembersScreenData as
    | ((o: { archived: boolean }) => Promise<E5MembersScreen>)
    | undefined;
  const categoriesLoader = categoriesMod.getCategoriesScreenData as
    | ((kind: "expense" | "income") => Promise<E5CategoriesScreen>)
    | undefined;
  const labelsLoader = labelsMod.getLabelsScreenData as (() => Promise<E5LabelsScreen>) | undefined;
  const missing = (name: string) => `${name} is not exported`;

  // ---- Members -------------------------------------------------------------
  const rawNames = async (archived: boolean): Promise<string[]> =>
    (
      await fixtureSql<{ name: string }[]>`
        select name from group_members
        where group_id = ${groupId} and (archived_at is not null) = ${archived} order by name`
    ).map((row) => row.name);
  const liveNames = await rawNames(false);
  const archivedNames = await rawNames(true);

  const live = membersLoader
    ? await attempt(() => asLeader(() => membersLoader({ archived: false })))
    : { value: null, error: missing("getMembersScreenData") };
  const gone = membersLoader
    ? await attempt(() => asLeader(() => membersLoader({ archived: true })))
    : { value: null, error: missing("getMembersScreenData") };
  assert(
    next("getMembersScreenData(live) lists the group's unarchived members by name, the invited and not-yet-claimed included"),
    live.value !== null &&
      sameList(live.value.members.map((m) => m.name), liveNames) &&
      liveNames.includes("Harness invitada viva") &&
      liveNames.includes("Harness miembra") &&
      !liveNames.includes("Harness invitada archivada"),
    live.value ? `names ${live.value.members.map((m) => m.name).join(" | ")} against ${liveNames.join(" | ")}` : live.error,
  );
  assert(
    next("getMembersScreenData(archived) lists the archived members alone"),
    gone.value !== null &&
      archivedNames.length === 1 &&
      sameList(gone.value.members.map((m) => m.name), archivedNames) &&
      gone.value.members.every((m) => m.archivedAt !== null),
    gone.value ? `names ${gone.value.members.map((m) => m.name).join(" | ")} against ${archivedNames.join(" | ")}` : gone.error,
  );
  const soloMembers = membersLoader
    ? await attempt(() => asUser(solo, () => membersLoader({ archived: false })))
    : { value: null, error: missing("getMembersScreenData") };
  assert(
    next("getMembersScreenData is null for a caller with no group"),
    membersLoader !== undefined && soloMembers.error === "" && soloMembers.value === null,
    membersLoader ? `returned ${JSON.stringify(soloMembers.value)} ${soloMembers.error}` : missing("getMembersScreenData"),
  );
  const fellowMembers = membersLoader
    ? await attempt(() => asUser(fellow, () => membersLoader({ archived: false })))
    : { value: null, error: missing("getMembersScreenData") };
  assert(
    next("getMembersScreenData names the leader as leader and the fellow member as not"),
    live.value?.isLeader === true && fellowMembers.value?.isLeader === false,
    `leader ${live.value?.isLeader}, fellow ${fellowMembers.value?.isLeader} ${fellowMembers.error}`,
  );
  if (membersLoader) await asLeader(() => membersLoader({ archived: false }));
  const membersCost = membersLoader
    ? await attempt(() => statementsOf(() => asLeader(() => membersLoader({ archived: false }))))
    : { value: null, error: missing("getMembersScreenData") };
  assert(
    next("getMembersScreenData opens one transaction and settles the session once"),
    membersCost.value !== null && beginsIn(membersCost.value.texts) === 1 && settlesIn(membersCost.value.texts) === 1,
    membersCost.value
      ? `${beginsIn(membersCost.value.texts)} BEGIN(s), ${settlesIn(membersCost.value.texts)} settle(s), ${membersCost.value.texts.length} statements`
      : membersCost.error,
  );

  // ---- Categories ----------------------------------------------------------
  const cats = categoriesLoader
    ? await attempt(() => asLeader(() => categoriesLoader("expense")))
    : { value: null, error: missing("getCategoriesScreenData") };
  const catsIncome = categoriesLoader
    ? await attempt(() => asLeader(() => categoriesLoader("income")))
    : { value: null, error: missing("getCategoriesScreenData") };
  const groupExpense = await rawCategoryTree(groupOwner, "expense");
  const personalExpense = await rawCategoryTree(leaderOwner, "expense");
  const groupIncome = await rawCategoryTree(groupOwner, "income");
  assert(
    next("getCategoriesScreenData for a grouped caller: the group's tree, the caller's own tree, the leader flag and the fund name"),
    cats.value !== null &&
      groupExpense.length > 1 && personalExpense.length > 0 &&
      sameList(foldNodes(cats.value.categories), groupExpense) &&
      sameList(foldNodes(cats.value.group), groupExpense) &&
      sameList(foldNodes(cats.value.personal), personalExpense) &&
      cats.value.isLeader === true && cats.value.groupName === groupName,
    cats.value
      ? `group [${foldNodes(cats.value.group).join(" ")}], personal [${foldNodes(cats.value.personal).join(" ")}], leader ${cats.value.isLeader}, name ${cats.value.groupName}`
      : cats.error,
  );
  const catsParents = await rawParentIds(groupOwner, "expense");
  const catsColors = await rawTopColors(groupOwner);
  assert(
    next("getCategoriesScreenData: the parent picker holds the scope's top-level ids and the used colours both kinds of top-level"),
    cats.value !== null &&
      sameList(cats.value.parents.map((p) => p.id), catsParents) &&
      sameSet(cats.value.usedColors, catsColors),
    cats.value ? `parents ${cats.value.parents.length}/${catsParents.length}, colours ${cats.value.usedColors.length}/${catsColors.length}` : cats.error,
  );
  const leaderColors = await rawTopColors(leaderOwner);
  assert(
    next("getCategoriesScreenData names the used colours of the caller's own set and of the fund's, apart"),
    cats.value?.usedColorsByPlacement !== undefined &&
      leaderColors.includes("#0E7490") &&
      !sameSet(leaderColors, catsColors) &&
      sameSet(cats.value.usedColorsByPlacement.personal, leaderColors) &&
      sameSet(cats.value.usedColorsByPlacement.group, catsColors),
    cats.value?.usedColorsByPlacement
      ? `personal ${cats.value.usedColorsByPlacement.personal.join(",")}, group ${cats.value.usedColorsByPlacement.group.join(",")}`
      : cats.error || "usedColorsByPlacement is missing",
  );
  assert(
    next("getCategoriesScreenData follows the kind it is given"),
    catsIncome.value !== null &&
      groupIncome.length > 0 &&
      sameList(foldNodes(catsIncome.value.categories), groupIncome) &&
      !sameList(groupIncome, groupExpense) &&
      sameList(foldNodes(catsIncome.value.personal), await rawCategoryTree(leaderOwner, "income")),
    catsIncome.value ? `income group [${foldNodes(catsIncome.value.categories).join(" ")}]` : catsIncome.error,
  );
  const soloCats = categoriesLoader
    ? await attempt(() => asUser(solo, () => categoriesLoader("expense")))
    : { value: null, error: missing("getCategoriesScreenData") };
  const soloTree = await rawCategoryTree(soloOwner, "expense");
  assert(
    next("getCategoriesScreenData for an ungrouped caller: the personal set once, no group, no fund name, not a leader"),
    soloCats.value !== null &&
      soloTree.length === 2 &&
      sameList(foldNodes(soloCats.value.categories), soloTree) &&
      sameList(foldNodes(soloCats.value.personal), soloTree) &&
      soloCats.value.group.length === 0 &&
      soloCats.value.groupName === null && soloCats.value.isLeader === false &&
      sameList(soloCats.value.parents.map((p) => p.id), await rawParentIds(soloOwner, "expense")) &&
      sameSet(soloCats.value.usedColors, await rawTopColors(soloOwner)),
    soloCats.value ? `categories [${foldNodes(soloCats.value.categories).join(" ")}], group ${soloCats.value.group.length}, name ${soloCats.value.groupName}` : soloCats.error,
  );
  assert(
    next("getCategoriesScreenData for an ungrouped caller: no fund colours, the personal colours equal usedColors"),
    soloCats.value?.usedColorsByPlacement !== undefined &&
      soloCats.value.usedColorsByPlacement.group.length === 0 &&
      soloCats.value.usedColorsByPlacement.personal.length > 0 &&
      sameSet(soloCats.value.usedColorsByPlacement.personal, soloCats.value.usedColors),
    soloCats.value?.usedColorsByPlacement
      ? `personal ${soloCats.value.usedColorsByPlacement.personal.join(",")}, group ${soloCats.value.usedColorsByPlacement.group.join(",")}`
      : soloCats.error || "usedColorsByPlacement is missing",
  );
  if (categoriesLoader) {
    await asLeader(() => categoriesLoader("expense"));
    await asUser(solo, () => categoriesLoader("expense"));
  }
  const catsCostGrouped = categoriesLoader
    ? await attempt(() => statementsOf(() => asLeader(() => categoriesLoader("expense"))))
    : { value: null, error: missing("getCategoriesScreenData") };
  const catsCostSolo = categoriesLoader
    ? await attempt(() => statementsOf(() => asUser(solo, () => categoriesLoader("expense"))))
    : { value: null, error: missing("getCategoriesScreenData") };
  assert(
    next("getCategoriesScreenData costs one transaction, and an ungrouped caller's personal set is read once, not twice"),
    catsCostGrouped.value !== null && catsCostSolo.value !== null &&
      beginsIn(catsCostGrouped.value.texts) === 1 && beginsIn(catsCostSolo.value.texts) === 1 &&
      settlesIn(catsCostGrouped.value.texts) === 1 && settlesIn(catsCostSolo.value.texts) === 1 &&
      readsOf(catsCostSolo.value.texts, "categories") >= 1 &&
      readsOf(catsCostSolo.value.texts, "categories") <= 3 &&
      readsOf(catsCostGrouped.value.texts, "categories") <= 4,
    catsCostGrouped.value && catsCostSolo.value
      ? `grouped ${beginsIn(catsCostGrouped.value.texts)} BEGIN, ${readsOf(catsCostGrouped.value.texts, "categories")} category reads; ungrouped ${beginsIn(catsCostSolo.value.texts)} BEGIN, ${readsOf(catsCostSolo.value.texts, "categories")} category reads`
      : `${catsCostGrouped.error} ${catsCostSolo.error}`,
  );

  // ---- Labels --------------------------------------------------------------
  const labs = labelsLoader
    ? await attempt(() => asLeader(() => labelsLoader()))
    : { value: null, error: missing("getLabelsScreenData") };
  const rawGroupLabels = await rawLabels(groupOwner);
  const rawOwnLabels = await rawLabels(leaderOwner);
  assert(
    next("getLabelsScreenData: both scopes with their movement and budget counts"),
    labs.value !== null &&
      rawGroupLabels.some((row) => row.endsWith("|1|1")) &&
      rawOwnLabels.some((row) => row.endsWith("|1|1")) &&
      sameList(foldLabels(labs.value.group), rawGroupLabels) &&
      sameList(foldLabels(labs.value.personal), rawOwnLabels),
    labs.value ? `group [${foldLabels(labs.value.group).join(" ; ")}], personal [${foldLabels(labs.value.personal).join(" ; ")}]` : labs.error,
  );
  assert(
    next("getLabelsScreenData: used colours per scope, leader flag and fund name"),
    labs.value !== null &&
      sameSet(labs.value.usedColors.group, await rawLabelColors(groupOwner)) &&
      sameSet(labs.value.usedColors.personal, await rawLabelColors(leaderOwner)) &&
      labs.value.isLeader === true && labs.value.groupName === groupName,
    labs.value ? `group colours ${labs.value.usedColors.group.join(",")}, personal ${labs.value.usedColors.personal.join(",")}` : labs.error,
  );
  const soloLabs = labelsLoader
    ? await attempt(() => asUser(solo, () => labelsLoader()))
    : { value: null, error: missing("getLabelsScreenData") };
  assert(
    next("getLabelsScreenData for an ungrouped caller: own labels only, no group, no fund name, not a leader"),
    soloLabs.value !== null &&
      soloLabs.value.group.length === 0 && soloLabs.value.usedColors.group.length === 0 &&
      sameList(foldLabels(soloLabs.value.personal), await rawLabels(soloOwner)) &&
      soloLabs.value.personal.length === 1 &&
      soloLabs.value.groupName === null && soloLabs.value.isLeader === false,
    soloLabs.value ? `personal ${soloLabs.value.personal.length}, group ${soloLabs.value.group.length}, name ${soloLabs.value.groupName}` : soloLabs.error,
  );
  if (labelsLoader) await asLeader(() => labelsLoader());
  const labsCost = labelsLoader
    ? await attempt(() => statementsOf(() => asLeader(() => labelsLoader())))
    : { value: null, error: missing("getLabelsScreenData") };
  assert(
    next("getLabelsScreenData opens one transaction and settles the session once"),
    labsCost.value !== null && beginsIn(labsCost.value.texts) === 1 && settlesIn(labsCost.value.texts) === 1,
    labsCost.value ? `${beginsIn(labsCost.value.texts)} BEGIN(s), ${settlesIn(labsCost.value.texts)} settle(s)` : labsCost.error,
  );

  // ---- The list and the export select the same movements ---------------------
  const mine = (descriptions: string[]) => descriptions.filter((d) => d.startsWith(`e5-${tag}-`)).sort();
  const filters: { name: string; filter: Record<string, string | boolean>; owns: (m: E5Movement) => boolean }[] = [
    { name: "account", filter: { accountId: cashId }, owns: (m) => m.accounts.includes(cashId) },
    { name: "category", filter: { categoryId: expenseTwo }, owns: (m) => m.categories.includes(expenseTwo) },
    { name: "label", filter: { labelId: groupLabelUsed }, owns: (m) => m.labels.includes(groupLabelUsed) },
    { name: "kind", filter: { kind: "expense" }, owns: (m) => m.kind === "expense" },
    { name: "member", filter: { memberUserId: fellow.id }, owns: (m) => m.creator === fellow.id },
    { name: "rule", filter: { recurringRuleId }, owns: (m) => m.rule },
    // RF-133: waiting for a person is a generated movement not yet confirmed, or one awaiting its other side.
    { name: "unreviewed", filter: { unreviewed: true }, owns: (m) => !m.reviewed && (m.rule || m.awaiting) },
    { name: "account, category and unreviewed together", filter: { accountId: cashId, categoryId: expenseTwo, unreviewed: true }, owns: (m) => m.accounts.includes(cashId) && m.categories.includes(expenseTwo) && !m.reviewed && (m.rule || m.awaiting) },
  ];

  // The awaiting rows exist only because the fixture wrote them as the owner: read them
  // back, or "unreviewed" could pass over a seed that never landed.
  const awaitingStored = await fixtureSql<{ description: string }[]>`
    select description from transactions
    where awaiting_counterparty = true and description like ${`e5-${tag}-%`} order by description`;
  assert(
    next("The awaiting-counterparty rows the parity checks lean on are stored, with and without a review stamp"),
    sameList(awaitingStored.map((row) => row.description), [r("m6"), r("m7")]),
    `stored awaiting rows: ${awaitingStored.map((row) => row.description).join(", ")}`,
  );

  for (const { name, filter, owns } of filters) {
    const expected = model.filter(owns).map((m) => m.ref).sort();
    const listed = mine((await asLeader(() => listTransactions(filter))).map((row) => row.description ?? ""));
    const exported = mine(
      ((await asLeader(() => readExport({ entityKeys: ["transactions"], transactionFilters: filter }))).transactions ?? []).map(
        (row) => String(row.description ?? ""),
      ),
    );
    assert(
      next(`List and export select the same movements under the ${name} filter, and the ones the scenario says`),
      expected.length > 0 && sameList(listed, expected) && sameList(exported, expected),
      `expected ${expected.map((e) => e.slice(-2)).join(",")}; list ${listed.map((e) => e.slice(-2)).join(",")}; export ${exported.map((e) => e.slice(-2)).join(",")}`,
    );
  }

  const conditionsFor = (transactionsMod: Record<string, unknown>) =>
    transactionsMod.transactionListConditions as ((f: Record<string, unknown>) => SQL[]) | undefined;
  const conditions = conditionsFor(await loadE5Module("@/db/queries/transactions"));
  const viaConditions = conditions
    ? await attempt(() =>
        asLeader(() =>
          withUserDb((tx) =>
            tx
              .select({ description: transactions.description })
              .from(transactions)
              .where(and(...conditions({ unreviewed: true, kind: "expense" }))),
          ),
        ),
      )
    : { value: null, error: missing("transactionListConditions") };
  const expectedUnreviewedExpense = model.filter((m) => m.kind === "expense" && !m.reviewed && (m.rule || m.awaiting)).map((m) => m.ref).sort();
  assert(
    next("transactionListConditions is the predicate the list and the export both run"),
    conditions !== undefined && conditions({}).length === 0 && conditions({ kind: "income" }).length >= 1 &&
      viaConditions.value !== null &&
      sameList(mine(viaConditions.value.map((row) => row.description ?? "")), expectedUnreviewedExpense),
    viaConditions.value ? `selects ${mine(viaConditions.value.map((row) => row.description ?? "")).length} of ${expectedUnreviewedExpense.length}` : viaConditions.error,
  );

  // The group's movements, rule and budget hang off the group, not off a person, so the
  // identity purge's group delete would meet their splits and refuse. Dropped here, in the
  // order the purge cannot reach.
  await asOwner(leader.id, async (tx) => {
    await tx`delete from transactions where description like ${`e5-${tag}-%`}`;
    await tx`delete from budgets where id in ${tx([groupBudget, ownBudget])}`;
    await tx`delete from recurring_rules where id = ${recurringRuleId}`;
  });

  await e5MinimumPayment(leader);
  await e5SeedWalk();
}

// The minimum payment, written once. The same percentage and the same fixed amount must
// come out of the statement read and the overview read, against a figure computed apart.
async function e5MinimumPayment(leader: HarnessUser): Promise<void> {
  const today = todayInBogota();
  const tag = randomUUID().slice(0, 8);

  const minimumMod = await loadE5Module("@/db/queries/debt-minimum");
  const minimumPaymentSql = minimumMod.minimumPaymentSql as
    | ((o: { fixed: SQL; pct: SQL; balance: SQL; fallback: SQL }) => SQL)
    | undefined;
  const evaluate = async (o: { fixed: string; pct: string; balance: string; fallback: string }) => {
    if (!minimumPaymentSql) return { value: null as string | null, error: "minimumPaymentSql is not exported" };
    return attempt(async () => {
      const rows = await asUser(leader, () =>
        withUserDb((tx) =>
          tx.execute<{ v: string | null }>(
            sql`select ${minimumPaymentSql({ fixed: sql.raw(o.fixed), pct: sql.raw(o.pct), balance: sql.raw(o.balance), fallback: sql.raw(o.fallback) })} as v`,
          ),
        ),
      );
      return rows[0]?.v === null || rows[0]?.v === undefined ? null : String(rows[0].v);
    });
  };
  const fixedWins = await evaluate({ fixed: "5000::bigint", pct: "0.10::numeric", balance: "(-1000000)::bigint", fallback: "0" });
  const pctOnly = await evaluate({ fixed: "null::bigint", pct: "0.05::numeric", balance: "(-1000010)::bigint", fallback: "0" });
  const pctOnOwed = await evaluate({ fixed: "null::bigint", pct: "0.05::numeric", balance: "1000010::bigint", fallback: "0" });
  const noneZero = await evaluate({ fixed: "null::bigint", pct: "null::numeric", balance: "(-1000000)::bigint", fallback: "0" });
  const noneNull = await evaluate({ fixed: "null::bigint", pct: "null::numeric", balance: "(-1000000)::bigint", fallback: "null::bigint" });
  assert(
    next("minimumPaymentSql: a fixed amount wins over a percentage"),
    fixedWins.value === "5000",
    `fixed 5000 with 10 percent of 1000000 gave ${fixedWins.value ?? fixedWins.error}`,
  );
  assert(
    next("minimumPaymentSql: a percentage is of the absolute balance, rounded to the cent"),
    pctOnly.value === "50001" && pctOnOwed.value === "50001",
    `5 percent of -1000010 gave ${pctOnly.value ?? pctOnly.error}, of 1000010 gave ${pctOnOwed.value ?? pctOnOwed.error}`,
  );
  assert(
    next("minimumPaymentSql: no terms give the caller's own fallback, zero or null"),
    noneZero.value === "0" && noneNull.value === null && noneNull.error === "",
    `fallback 0 gave ${noneZero.value ?? noneZero.error}, fallback null gave ${noneNull.value ?? noneNull.error}`,
  );

  const open = async (name: string, amountMinor: number) => {
    const { accountId } = await asUser(leader, () =>
      createAccount({
        name: `Harness minimo ${name} ${tag}`,
        kind: "liability",
        subtype: "card",
        ownerUserId: leader.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor,
        balanceOn: shiftDate(today, -40),
      }),
    );
    keep("accounts", accountId);
    return accountId;
  };
  const terms = async (accountId: string, fixed: number | null, pct: string | null) => {
    await asUser(leader, () =>
      upsertDebtTerms({
        accountId,
        debtKind: "revolving",
        annualRate: "0.2800",
        minimumPaymentCents: fixed,
        minimumPaymentPct: pct,
        creditLimitCents: 500_000_000,
        statementCutOffDay: 15,
        paymentDueDay: 5,
        avalCents: null,
      }),
    );
    keep("debt_terms", accountId);
  };
  const pctCard = await open("porcentaje", 1_234_567);
  const fixedCard = await open("fijo", 2_000_000);
  const bareCard = await open("sin terminos", 700_000);
  await terms(pctCard, null, "0.0333");
  await terms(fixedCard, 77_000, null);
  await terms(bareCard, null, null);

  // The figure computed apart: the balance the account_balances view reports for the card in
  // its settlement currency, and the percentage applied in JavaScript from the stored text.
  const owed = async (accountId: string): Promise<number> => {
    const [row] = await fixtureSql<{ balance_cents: string }[]>`
      select b.balance_cents from account_balances b join accounts a on a.id = b.id and b.currency = a.settlement_currency
      where b.id = ${accountId}`;
    return Math.abs(Number(row.balance_cents));
  };
  const pctOwed = await owed(pctCard);
  const expectedPct = Math.round(pctOwed * 0.0333);

  const overview = await asUser(leader, () => getDebtOverview());
  const overviewOf = (id: string) => overview.find((row) => row.accountId === id)?.minimumPaymentCents;
  const statementOf = async (id: string) => (await asUser(leader, () => getCurrentStatement(id)))?.minimumPaymentCents;

  assert(
    next("Percentage minimum: the overview and the statement both read round(abs(owed) x pct)"),
    pctOwed > 0 && expectedPct > 0 && overviewOf(pctCard) === expectedPct && (await statementOf(pctCard)) === expectedPct,
    `owed ${pctOwed}; expected ${expectedPct}; overview ${overviewOf(pctCard)}; statement ${await statementOf(pctCard)}`,
  );
  assert(
    next("Fixed minimum: the overview and the statement both read the fixed amount"),
    overviewOf(fixedCard) === 77_000 && (await statementOf(fixedCard)) === 77_000,
    `overview ${overviewOf(fixedCard)}; statement ${await statementOf(fixedCard)}`,
  );
  assert(
    next("No terms for a minimum: the statement reads zero and the overview reads null, never one fallback for both"),
    overviewOf(bareCard) === null && (await statementOf(bareCard)) === 0,
    `overview ${overviewOf(bareCard)}; statement ${await statementOf(bareCard)}`,
  );
}

// The seed walk, written once: a personal space and a group colour their trees alike, node
// by node, children included, and a child never wears the colour of its parent.
async function e5SeedWalk(): Promise<void> {
  const seedMod = await loadE5Module("@/db/queries/seed-categories");
  const seedCategoryTree = seedMod.seedCategoryTree as
    | ((tx: unknown, scope: { ownerUserId: string } | { groupId: string }, locale: "es" | "en") => Promise<unknown>)
    | undefined;

  const soloUser = await createMembershipFreeUser();
  const direct = seedCategoryTree
    ? await attempt(() =>
        asUser(soloUser, () => withUserDb((tx) => seedCategoryTree(tx, { ownerUserId: soloUser.id }, "es"))),
      )
    : { value: null, error: "seedCategoryTree is not exported" };
  const soloRows = await fixtureSql<{ id: string; name: string; kind: string; color: string | null; parent_id: string | null }[]>`
    select id, name, kind, color, parent_id from categories where owner_user_id = ${soloUser.id}`;
  for (const row of soloRows) track("categories", row.id);

  const founder = await createMembershipFreeUser();
  const { groupId } = await asUser(founder, () =>
    createGroup({ name: `Harness fondo semilla ${randomUUID().slice(0, 8)}`, leaderName: "Harness semilla", cashMode: "shared", locale: "es" }),
  );
  track("groups", groupId);
  const [fresh] = await fixtureSql<{ member_id: string; account_id: string }[]>`
    select
      (select id from group_members where group_id = ${groupId} and user_id = ${founder.id}) as member_id,
      (select id from accounts where group_id = ${groupId} and subtype = 'cash') as account_id`;
  track("group_members", fresh.member_id);
  track("accounts", fresh.account_id);
  const groupRows = await fixtureSql<{ id: string; name: string; kind: string; color: string | null; parent_id: string | null }[]>`
    select id, name, kind, color, parent_id from categories where group_id = ${groupId}`;
  for (const row of groupRows) track("categories", row.id);

  const nodes = SEED_CATEGORIES.flatMap((category) => [
    { key: `${category.kind}:${category.name.es}`, name: category.name.es, kind: category.kind, parentName: null as string | null },
    ...(category.children ?? []).map((child) => ({
      key: `${category.kind}:${category.name.es}/${child.name.es}`,
      name: child.name.es,
      kind: category.kind,
      parentName: category.name.es,
    })),
  ]);
  const colourByKey = (rows: typeof soloRows): Map<string, string | null> => {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return new Map(
      rows.map((row) => {
        const parent = row.parent_id ? byId.get(row.parent_id) : undefined;
        return [parent ? `${row.kind}:${parent.name}/${row.name}` : `${row.kind}:${row.name}`, row.color];
      }),
    );
  };
  const personalColours = colourByKey(soloRows);
  const groupColours = colourByKey(groupRows);

  assert(
    next("seedCategoryTree writes the seed tree for a personal scope: every node, in the locale, with its kind and its parent"),
    direct.error === "" &&
      soloRows.length === nodes.length &&
      nodes.every((node) => personalColours.has(node.key)) &&
      soloRows.every((row) => (row.parent_id === null) === (nodes.find((n) => n.name === row.name)?.parentName === null)),
    direct.error || `${soloRows.length} rows against ${nodes.length} seed nodes`,
  );
  assert(
    next("A new personal space and a new fund colour their trees node by node alike"),
    direct.error === "" &&
      groupRows.length === nodes.length &&
      nodes.every((node) => personalColours.get(node.key) !== undefined && personalColours.get(node.key) === groupColours.get(node.key)),
    direct.error || nodes.filter((n) => personalColours.get(n.key) !== groupColours.get(n.key)).map((n) => n.key).join(", ") || "all alike",
  );
  const parentColourOf = (node: (typeof nodes)[number], colours: Map<string, string | null>) =>
    node.parentName === null ? undefined : colours.get(`${node.kind}:${node.parentName}`);
  assert(
    next("In both seeded trees no child copies its parent's colour and no colour repeats"),
    direct.error === "" &&
      nodes.every((n) => n.parentName === null || (personalColours.get(n.key) !== parentColourOf(n, personalColours) && groupColours.get(n.key) !== parentColourOf(n, groupColours))) &&
      new Set(soloRows.map((row) => row.color)).size === soloRows.length &&
      new Set(groupRows.map((row) => row.color)).size === groupRows.length,
    direct.error || `${new Set(soloRows.map((row) => row.color)).size}/${soloRows.length} personal, ${new Set(groupRows.map((row) => row.color)).size}/${groupRows.length} group distinct colours`,
  );
}

// RF-150, RF-151, RF-152, RF-149: both invite actions refuse a live member of the leader's fund
// (the leader's own address included) and an address whose domain takes no mail before a row is
// written or Auth is asked; an archived invitation's address invites again; a restore that meets
// a newer invitation is refused by name. The real actions run against the real tables.
async function inviteRefusalSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const members = (await import("@/app/actions/members")) as unknown as {
    createMemberAction: (input: { name: string; email?: string }) => Promise<InviteResult>;
    inviteMemberByEmailAction: (input: { email: string }) => Promise<InviteResult>;
    archiveMemberAction: (input: { memberId: string }) => Promise<{ serverError?: string }>;
    restoreMemberAction: (input: { memberId: string }) => Promise<{ serverError?: string }>;
  };
  type InviteResult = {
    data?: { memberId: string; inviteEmailFailed: boolean };
    serverError?: string;
  };
  const kinds: { name: string; run: (email: string) => Promise<InviteResult> }[] = [
    { name: "createMemberAction", run: (email) => members.createMemberAction({ name: `Harness invita ${tag}`, email }) },
    { name: "inviteMemberByEmailAction", run: (email) => members.inviteMemberByEmailAction({ email }) },
  ];

  const leader = await createMembershipFreeUser();
  const { groupId } = await asUser(leader, () =>
    createGroup({ name: `Harness fondo rechazos ${tag}`, leaderName: "Harness lider rechaza", cashMode: "shared", locale: "es" }),
  );
  track("groups", groupId);
  const fellow = await seedFellowMember(leader.id, groupId);
  const otherGroupIds: string[] = [];
  const foreignLeader = async (): Promise<HarnessUser> => {
    const user = await createMembershipFreeUser();
    const { groupId: id } = await asUser(user, () =>
      createGroup({ name: `Harness otro fondo ${tag}`, leaderName: "Harness lider ajeno", cashMode: "shared", locale: "es" }),
    );
    track("groups", id);
    otherGroupIds.push(id);
    return user;
  };
  const groupless = await createMembershipFreeUser();
  let wandererGroupId = groupId;

  const trackAll = async (): Promise<void> => {
    const rows = await fixtureSql<{ id: string }[]>`
      select id from group_members where group_id in ${fixtureSql([groupId, ...otherGroupIds, wandererGroupId])}`;
    for (const row of rows) track("group_members", row.id);
    const categories = await fixtureSql<{ id: string }[]>`
      select id from categories where group_id in ${fixtureSql([groupId, ...otherGroupIds, wandererGroupId])}`;
    for (const row of categories) track("categories", row.id);
    const accounts = await fixtureSql<{ id: string }[]>`
      select id from accounts where group_id in ${fixtureSql([groupId, ...otherGroupIds, wandererGroupId])}`;
    for (const row of accounts) track("accounts", row.id);
  };
  const countRows = async (): Promise<number> => {
    const [{ n }] = await fixtureSql<{ n: number }[]>`select count(*)::int as n from group_members where group_id = ${groupId}`;
    return n;
  };
  const rowsFor = (email: string) =>
    fixtureSql<{ id: string; archived_at: string | null; user_id: string | null }[]>`
      select id, archived_at::text, user_id from group_members
      where group_id = ${groupId} and lower(invite_email) = ${email.toLowerCase()} order by created_at, id`;
  const onAllowList = async (email: string): Promise<boolean> =>
    (await fixtureSql`select 1 from allowed_emails where email = ${email.toLowerCase()}`).length > 0;
  const asked = (): { email: string }[] =>
    ((globalThis as { harnessAdminInvites?: { email: string }[] }).harnessAdminInvites ??= []);

  // Both actions, one expectation: nothing written, nobody asked, the named refusal.
  const refused = async (
    label: string,
    caller: { id: string; email: string },
    email: string,
    key: string,
  ): Promise<void> => {
    for (const kind of kinds) {
      const rowsBefore = await countRows();
      const askedBefore = asked().length;
      const result = await asUser(caller, () => kind.run(email));
      const rowsAfter = await countRows();
      assert(
        next(`${label} via ${kind.name}: refused as ${key}, no row, no invitation asked`),
        result?.serverError === key && result.data === undefined && rowsAfter === rowsBefore && asked().length === askedBefore,
        `serverError = ${result?.serverError ?? "none"}, rows ${rowsBefore} -> ${rowsAfter}, invitations asked = ${asked().length - askedBefore}`,
      );
    }
  };

  await refused("A joined member's address in another case", leader, fellow.email.toUpperCase(), "members.errors.alreadyMember");
  await refused("The leader's own address", leader, leader.email, "members.errors.alreadyMember");

  const fresh = (kind: string) => `${kind}-${tag}-${randomUUID().slice(0, 6)}@mail.example.invalid`;

  // A plain member learns nothing about who belongs: the refusal is the leader's, not the roster's.
  await refused("A plain member inviting the leader's address", fellow, leader.email, "errors.notLeader");

  const noFundAddress = `x-${randomUUID()}@example.com`;
  const noFund = await asUser(groupless, () => kinds[1].run(noFundAddress));
  assert(
    next("A caller with no fund inviting an address whose domain takes no mail is told not found, not undeliverable"),
    noFund?.serverError === "errors.notFound",
    `serverError = ${noFund?.serverError ?? "none"}`,
  );

  for (const kind of kinds) {
    const pending = fresh("pending");
    const first = await asUser(leader, () => kind.run(pending));
    const again = await asUser(leader, () => kind.run(pending.toUpperCase()));
    assert(
      next(`An address already invited and pending is refused as emailTaken, not as a member, via ${kind.name}`),
      first?.data !== undefined && again?.serverError === "members.errors.emailTaken" && (await rowsFor(pending)).length === 1,
      `first = ${first?.serverError ?? "ok"}, second = ${again?.serverError ?? "ok"}`,
    );

    const elsewhere = (await foreignLeader()).email;
    const askedBefore = asked().length;
    const invitedLeader = await asUser(leader, () => kind.run(elsewhere));
    const elsewhereRows = await rowsFor(elsewhere);
    assert(
      next(`A live member of another fund can be invited to this one via ${kind.name}`),
      invitedLeader?.serverError === undefined &&
        invitedLeader?.data !== undefined &&
        elsewhereRows.length === 1 &&
        elsewhereRows[0].user_id === null &&
        asked().length === askedBefore + 1,
      `serverError = ${invitedLeader?.serverError ?? "none"}, ${elsewhereRows.length} row(s), invitations asked = ${asked().length - askedBefore}`,
    );

    const dead = `x-${randomUUID()}@example.com`;
    const rowsBefore = await countRows();
    const askedBeforeDead = asked().length;
    const undeliverable = await asUser(leader, () => kind.run(dead));
    assert(
      next(`An address whose domain takes no mail is refused as undeliverable: no row, no invitation, not on the allow list, via ${kind.name}`),
      undeliverable?.serverError === "errors.domainUndeliverable" &&
        undeliverable.data === undefined &&
        (await countRows()) === rowsBefore &&
        asked().length === askedBeforeDead &&
        !(await onAllowList(dead)),
      `serverError = ${undeliverable?.serverError ?? "none"}, rows ${rowsBefore} -> ${await countRows()}, invitations asked = ${asked().length - askedBeforeDead}, on list = ${await onAllowList(dead)}`,
    );

    const exempt = fresh("exempt");
    const exemptResult = await asUser(leader, () => kind.run(exempt));
    assert(
      next(`A reserved .invalid address passes the deliverability guard on the local stack via ${kind.name}`),
      exemptResult?.data !== undefined && (await rowsFor(exempt)).length === 1 && (await onAllowList(exempt)),
      `serverError = ${exemptResult?.serverError ?? "none"}, ${(await rowsFor(exempt)).length} row(s)`,
    );
  }

  // RF-151 and RF-149: an archived invitation lets its address invite again, and restoring the old
  // one while the new one lives is refused by name and leaves it archived.
  const reused = fresh("reused");
  const original = await asUser(leader, () => kinds[0].run(reused));
  const archive = original?.data ? await asUser(leader, () => members.archiveMemberAction({ memberId: original.data!.memberId })) : undefined;
  const [archivedBefore] = await rowsFor(reused);
  const reinvited = await asUser(leader, () => kinds[1].run(reused.toUpperCase()));
  const afterReinvite = await rowsFor(reused);
  const archivedRow = afterReinvite.find((row) => row.id === archivedBefore?.id);
  assert(
    next("An archived invitation's address invites again: a new live row, the archived row unchanged"),
    archive?.serverError === undefined &&
      reinvited?.data !== undefined &&
      afterReinvite.length === 2 &&
      afterReinvite.filter((row) => row.archived_at === null).length === 1 &&
      archivedRow?.archived_at === archivedBefore?.archived_at &&
      archivedRow?.archived_at !== null,
    `archive = ${archive?.serverError ?? "ok"}, re-invite = ${reinvited?.serverError ?? "ok"}, ${afterReinvite.length} row(s)`,
  );

  const restoreCollision = await asUser(leader, () => members.restoreMemberAction({ memberId: archivedBefore.id }));
  const [stillArchived] = await fixtureSql<{ archived_at: string | null }[]>`
    select archived_at::text from group_members where id = ${archivedBefore.id}`;
  assert(
    next("Restoring an archived invitation while a newer one holds its address is refused as emailTaken and stays archived"),
    restoreCollision?.serverError === "members.errors.emailTaken" && stillArchived?.archived_at !== null,
    `serverError = ${restoreCollision?.serverError ?? "none"}, archived_at = ${stillArchived?.archived_at}`,
  );

  // A restore that fails for another reason keeps today's answer: a joined member whose user now
  // belongs to another fund trips the one-live-membership index, not the invitation one.
  const wanderer = await createMembershipFreeUser();
  ({ groupId: wandererGroupId } = await asUser(wanderer, () =>
    createGroup({ name: `Harness fondo errante ${tag}`, leaderName: "Harness errante", cashMode: "shared", locale: "es" }),
  ));
  track("groups", wandererGroupId);
  const oldSeat = randomUUID();
  await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: leader.id, role: "authenticated", aud: "authenticated" })}, true)`;
    await tx`
      insert into group_members (id, group_id, user_id, name, role, archived_at)
      values (${oldSeat}, ${groupId}, ${wanderer.id}, 'Harness errante archivado', 'member', now())`;
  });
  track("group_members", oldSeat);
  const otherRestore = await asUser(leader, () => members.restoreMemberAction({ memberId: oldSeat }));
  const [seatAfter] = await fixtureSql<{ archived_at: string | null }[]>`
    select archived_at::text from group_members where id = ${oldSeat}`;
  assert(
    next("A restore refused for another reason is not reported as emailTaken and the member stays archived"),
    otherRestore?.serverError !== undefined &&
      otherRestore.serverError !== "members.errors.emailTaken" &&
      seatAfter?.archived_at !== null,
    `serverError = ${otherRestore?.serverError ?? "none"}, archived_at = ${seatAfter?.archived_at}`,
  );

  await trackAll();
}

// RF-153, RF-148, RF-149, RF-150, RF-152: the leader gives an address to a placeholder member. The
// edit stores it, audits it, invites, and the person who signs in with it becomes that member; every
// refusal of the create path refuses the edit with the row untouched and Auth unasked, and a row that
// is not an unclaimed live placeholder is never given an address, whatever the caller forges.
async function inviteOnEditSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  type EditResult = { data?: { inviteEmailFailed: boolean }; serverError?: string };
  const members = (await import("@/app/actions/members")) as unknown as {
    updateMemberAction: (input: { memberId: string; name: string; email?: string }) => Promise<EditResult>;
  };

  const leader = await createMembershipFreeUser();
  const { groupId } = await asUser(leader, () =>
    createGroup({ name: `Harness fondo edita ${tag}`, leaderName: "Harness lider edita", cashMode: "shared", locale: "es" }),
  );
  track("groups", groupId);
  const fellow = await seedFellowMember(leader.id, groupId);
  const groupless = await createMembershipFreeUser();
  const [{ id: fellowRowId }] = await fixtureSql<{ id: string }[]>`
    select id from group_members where group_id = ${groupId} and user_id = ${fellow.id}`;

  const fresh = (kind: string) => `${kind}-${tag}-${randomUUID().slice(0, 6)}@mail.example.invalid`;
  const asked = (): { email: string; redirectTo?: string }[] =>
    ((globalThis as { harnessAdminInvites?: { email: string; redirectTo?: string }[] }).harnessAdminInvites ??= []);
  const onAllowList = async (email: string): Promise<boolean> =>
    (await fixtureSql`select 1 from allowed_emails where email = ${email.toLowerCase()}`).length > 0;
  const rowOf = async (id: string) =>
    (await fixtureSql<MemberSnapshot[]>`
      select id, user_id, invite_email, name, archived_at::text as archived_at from group_members where id = ${id}`)[0];

  // Rows are written as the owner under the leader's claims, as `seedPendingInvite` does.
  const seed = async (name: string, state: "placeholder" | "archived" | "pending", email?: string): Promise<string> => {
    const id = randomUUID();
    await fixtureSql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: leader.id, role: "authenticated", aud: "authenticated" })}, true)`;
      await tx`
        insert into group_members (id, group_id, name, role, invite_email, archived_at)
        values (${id}, ${groupId}, ${name}, 'member', ${state === "pending" ? email! : null},
          ${state === "archived" ? tx`now()` : null})`;
    });
    track("group_members", id);
    return id;
  };

  // One edit, one expectation: the named refusal, the row as it was (name included), the allow list as
  // it was, Auth unasked.
  const refusedEdit = async (
    label: string,
    caller: { id: string; email: string },
    memberId: string,
    email: string,
    key: string,
  ): Promise<void> => {
    const before = await rowOf(memberId);
    const askedBefore = asked().length;
    const listedBefore = await onAllowList(email);
    const result = await asUser(caller, () => members.updateMemberAction({ memberId, name: `Harness renombrada ${randomUUID().slice(0, 4)}`, email }));
    const after = await rowOf(memberId);
    const listed = await onAllowList(email);
    assert(
      next(`${label}: refused as ${key}, the row unchanged, no invitation asked`),
      result?.serverError === key &&
        result.data === undefined &&
        JSON.stringify(before) === JSON.stringify(after) &&
        asked().length === askedBefore &&
        listed === listedBefore,
      `serverError = ${result?.serverError ?? "none"}, row ${JSON.stringify(before)} -> ${JSON.stringify(after)}, invitations asked = ${asked().length - askedBefore}, on list ${listedBefore} -> ${listed}`,
    );
  };

  // The happy path, and the claim that follows it. The invitee is a real identity so the claim runs as them.
  const invitee = await createMembershipFreeUser();
  const abuela = await seed("Abuela", "placeholder");
  const askedBeforeInvite = asked().length;
  const invited = await asUser(leader, () => members.updateMemberAction({ memberId: abuela, name: "Abuela Rosa", email: invitee.email.toUpperCase() }));
  const stored = await rowOf(abuela);
  const askedNow = asked().slice(askedBeforeInvite);
  assert(
    next("A leader giving a placeholder an address stores it, renames, lists it lowercased and asks Auth for one invitation"),
    invited?.serverError === undefined &&
      invited?.data?.inviteEmailFailed === false &&
      stored.invite_email?.toLowerCase() === invitee.email.toLowerCase() &&
      stored.name === "Abuela Rosa" &&
      stored.user_id === null &&
      (await onAllowList(invitee.email)) &&
      askedNow.length === 1 &&
      askedNow[0].email.toLowerCase() === invitee.email.toLowerCase() &&
      askedNow[0].redirectTo?.endsWith("/login") === true,
    `serverError = ${invited?.serverError ?? "none"}, data = ${JSON.stringify(invited?.data)}, row = ${JSON.stringify(stored)}, invitations = ${JSON.stringify(askedNow)}`,
  );

  const audits = await fixtureSql<{ after_data: { invite_email?: string; name?: string } | null }[]>`
    select after_data from audit_log where record_id = ${abuela} and action = 'UPDATE'`;
  assert(
    next("The edit left one audit_log UPDATE row for the member carrying the stored address (RF-45)"),
    audits.length === 1 && audits[0].after_data?.invite_email?.toLowerCase() === invitee.email.toLowerCase(),
    `${audits.length} UPDATE row(s), invite_email = ${audits[0]?.after_data?.invite_email}`,
  );

  const claimed = await asUser(invitee, () => claimInviteForUser({ email: invitee.email }));
  const claimedRow = await rowOf(abuela);
  const rowsForUser = await fixtureSql<{ id: string }[]>`select id from group_members where user_id = ${invitee.id}`;
  assert(
    next("The person who signs in with that address becomes that member: the same row, their user, no invitation left, the name the group gave"),
    claimed === "claimed" &&
      claimedRow.user_id === invitee.id &&
      claimedRow.invite_email === null &&
      claimedRow.name === "Abuela Rosa" &&
      rowsForUser.length === 1 &&
      rowsForUser[0].id === abuela,
    `claim = ${claimed}, row = ${JSON.stringify(claimedRow)}, rows for the user = ${rowsForUser.map((r) => r.id).join(",")}`,
  );

  // No address: a rename, and nothing else.
  const plain = await seed("Tio", "placeholder");
  const askedBeforePlain = asked().length;
  const renamed = await asUser(leader, () => members.updateMemberAction({ memberId: plain, name: "Tio Beto" }));
  const blank = await asUser(leader, () => members.updateMemberAction({ memberId: plain, name: "Tio Beto 2", email: "   " }));
  const plainRow = await rowOf(plain);
  assert(
    next("A rename with no address, or a blank one, renames, leaves invite_email null and asks Auth for nothing"),
    renamed?.serverError === undefined &&
      blank?.serverError === undefined &&
      renamed?.data?.inviteEmailFailed !== true &&
      plainRow.name === "Tio Beto 2" &&
      plainRow.invite_email === null &&
      asked().length === askedBeforePlain,
    `renamed = ${renamed?.serverError ?? "ok"}, blank = ${blank?.serverError ?? "ok"}, row = ${JSON.stringify(plainRow)}, invitations = ${asked().length - askedBeforePlain}`,
  );

  const target = await seed("Primo", "placeholder");
  await refusedEdit("A joined member's address in another case", leader, target, fellow.email.toUpperCase(), "members.errors.alreadyMember");
  await refusedEdit("The leader's own address", leader, target, leader.email, "members.errors.alreadyMember");
  await refusedEdit("An address whose domain takes no mail", leader, target, `x-${randomUUID()}@example.com`, "errors.domainUndeliverable");

  const held = fresh("held");
  await seed("Otra pendiente", "pending", held);
  await refusedEdit("The address of another live pending row", leader, target, held.toUpperCase(), "members.errors.emailTaken");

  // Forged ids: the form never offers these rows, so the server must refuse them itself.
  const pendingA = fresh("a");
  const pendingRow = await seed("Pendiente A", "pending", pendingA);
  await refusedEdit("A row already pending with another address", leader, pendingRow, fresh("b"), "members.errors.emailTaken");
  const pendingAfter = await rowOf(pendingRow);
  assert(
    next("The pending row still holds its own address after the refused edit"),
    pendingAfter.invite_email === pendingA,
    `invite_email = ${pendingAfter.invite_email}`,
  );
  await refusedEdit("A member with a user", leader, fellowRowId, fresh("c"), "members.errors.alreadyMember");
  const archivedRow = await seed("Archivada", "archived");
  await refusedEdit("An archived placeholder", leader, archivedRow, fresh("d"), "errors.notFound");

  // The plain member: another's placeholder, then their own row.
  await refusedEdit("A plain member giving a placeholder an address", fellow, target, fresh("f"), "errors.notLeader");
  await refusedEdit("A plain member giving their own row an address", fellow, fellowRowId, fresh("g"), "errors.notLeader");

  const noFund = await asUser(groupless, () =>
    members.updateMemberAction({ memberId: target, name: "Nadie", email: `x-${randomUUID()}@example.com` }),
  );
  assert(
    next("A caller with no fund giving an address whose domain takes no mail is told not found, not undeliverable"),
    noFund?.serverError === "errors.notFound",
    `serverError = ${noFund?.serverError ?? "none"}`,
  );

  const rows = await fixtureSql<{ id: string }[]>`select id from group_members where group_id = ${groupId}`;
  for (const row of rows) track("group_members", row.id);
}

// The invite step's server half (RF-06, RF-07): the member an address becomes,
// and the refusals the table itself gives, driven through the query the invite
// action runs and the name rule it applies.
async function e6Suite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);

  const leader = await createMembershipFreeUser();
  const { groupId } = await asUser(leader, () =>
    createGroup({ name: `Harness fondo invitaciones ${tag}`, leaderName: "Harness lider invita", cashMode: "shared", locale: "es" }),
  );
  track("groups", groupId);
  const [seeded] = await fixtureSql<{ member_id: string; account_id: string }[]>`
    select
      (select id from group_members where group_id = ${groupId} and user_id = ${leader.id}) as member_id,
      (select id from accounts where group_id = ${groupId} and subtype = 'cash') as account_id`;
  track("group_members", seeded.member_id);
  track("accounts", seeded.account_id);
  const seededCategories = await fixtureSql<{ id: string }[]>`
    select id from categories where group_id = ${groupId}`;
  for (const row of seededCategories) track("categories", row.id);
  const fellow = await seedFellowMember(leader.id, groupId);

  const inviteRows = (email: string) =>
    fixtureSql<{ id: string; name: string; invite_email: string | null; user_id: string | null }[]>`
      select id, name, invite_email, user_id from group_members
      where group_id = ${groupId} and lower(invite_email) = ${email.toLowerCase()}`;

  // An address over the name's cap of 80: valid, 85 characters.
  const longAddress = `e6-${tag}-${"x".repeat(55)}@mail.example.invalid`;
  const invited = await asUser(leader, async () => {
    try {
      const { memberId } = await createMember({
        groupId,
        name: provisionalMemberName(longAddress),
        inviteEmail: longAddress,
      });
      track("group_members", memberId);
      return { memberId, error: "" };
    } catch (error) {
      return { memberId: "", error: refusal(error) };
    }
  });
  const longRows = await inviteRows(longAddress);
  assert(
    next("An address over 80 characters invites: the whole address is stored, the member's name is its first 80, and it is unclaimed"),
    longAddress.length > 80 &&
      invited.error === "" &&
      longRows.length === 1 &&
      longRows[0].invite_email === longAddress &&
      longRows[0].name === longAddress.slice(0, 80) &&
      longRows[0].user_id === null,
    invited.error || `${longRows.length} rows, name ${longRows[0]?.name.length} characters, address ${longRows[0]?.invite_email?.length}`,
  );

  const again = await asUser(leader, async () => {
    try {
      await createMember({ groupId, name: "Otra vez", inviteEmail: longAddress.toUpperCase() });
      return { code: null as string | null, error: "" };
    } catch (error) {
      return { code: pgErrorCode(error) ?? null, error: refusal(error) };
    }
  });
  assert(
    next("The same address in another case is refused by the table (23505) and leaves one member"),
    again.code === "23505" && (await inviteRows(longAddress)).length === 1,
    again.error || "the second invite landed",
  );

  const stranger = `e6-plain-${tag}@example.invalid`;
  const refused = await asUser(fellow, async () => {
    try {
      await createMember({ groupId, name: provisionalMemberName(stranger), inviteEmail: stranger });
      return { code: null as string | null, error: "" };
    } catch (error) {
      return { code: pgErrorCode(error) ?? null, error: refusal(error) };
    }
  });
  assert(
    next("A member who is not the leader cannot invite: 42501 and no row"),
    refused.code === "42501" && (await inviteRows(stranger)).length === 0,
    refused.error || "the invite landed",
  );
}

// M26: the import's read side names each row's scope and the caller's own id and fund.
async function importScopeOwnerSuite(
  userId: string,
  scope: HarnessScope,
): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  // Earlier suites put the shared groupless user in a fund; this one needs a person in none.
  const groupless = await createMembershipFreeUser();
  const name = `Harness T3 Mercado ${tag}`;
  const personalId = randomUUID();
  const fundId = randomUUID();
  await fixtureSql`
    insert into categories (id, owner_user_id, name, kind, color)
    values (${personalId}, ${userId}, ${name}, 'expense', '#4C8C4A')`;
  track("categories", personalId);
  await fixtureSql`
    insert into categories (id, group_id, name, kind, color)
    values (${fundId}, ${scope.groupId}, ${name}, 'expense', '#4C8C4A')`;
  track("categories", fundId);

  const fundAccountId = randomUUID();
  await fixtureSql`
    insert into accounts (id, group_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
    values (${fundAccountId}, ${scope.groupId}, ${`Harness T3 fondo ${tag}`}, 'asset', 'bank', 0, current_date)`;
  track("accounts", fundAccountId);

  const trips = async (run: () => Promise<unknown>): Promise<number> => {
    const started = roundTrips();
    await run();
    return roundTrips() - started;
  };
  const read = await readImportScope();
  const same = read.categories.filter((row) => row.name === name);
  const personal = same.find((row) => row.id === personalId);
  const fund = same.find((row) => row.id === fundId);

  assert(
    next("A personal category names its owner"),
    personal?.ownerUserId === userId && personal.groupId === null,
    `owner ${personal?.ownerUserId}, group ${personal?.groupId}`,
  );
  assert(
    next("A fund category names its fund"),
    fund?.ownerUserId === null && fund.groupId === scope.groupId,
    `owner ${fund?.ownerUserId}, group ${fund?.groupId}`,
  );
  const sharedAccount = read.accounts.find((row) => row.id === fundAccountId);
  const ownAccount = read.accounts.find((row) => row.id === scope.assetAccountId && row.ownerUserId === userId && row.groupId === null);
  assert(
    next("An account carries its owner"),
    sharedAccount !== undefined &&
      sharedAccount.groupId === scope.groupId &&
      sharedAccount.ownerUserId === null &&
      ownAccount !== undefined,
    `fund account ${JSON.stringify(sharedAccount)}, personal account ${ownAccount?.id}`,
  );
  const outsider = await asUser(groupless, () => readImportScope());
  assert(
    next("The caller is the session user and their fund"),
    read.caller.userId === userId &&
      read.caller.groupId === scope.groupId &&
      outsider.caller.userId === groupless.id &&
      outsider.caller.groupId === null,
    `${JSON.stringify(read.caller)} / ${JSON.stringify(outsider.caller)}`,
  );
  await readImportScope();
  const used = await trips(() => readImportScope());
  // Each read is one transaction of four statements (begin, settle, query, commit): 7 reads.
  assert(next("The reads fan out"), used <= 7 * 4, `${used} statements for 7 reads`);
}

// M23: expense and income leave a reconciliation's adjustment out, and `adjustments` selects them alone (RF-138, RF-23, RF-118).
async function adjustmentFilterSuite(userId: string, scope: HarnessScope): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const open = async (name: string): Promise<string> => {
    const { accountId } = await createAccount({
      name: `${name} ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: userId,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 1_000_000,
      balanceOn: shiftDate(today, -10),
    });
    keep("accounts", accountId);
    return accountId;
  };
  const incomeCategoryId = randomUUID();
  await fixtureSql`
    insert into categories (id, owner_user_id, name, kind, color)
    values (${incomeCategoryId}, ${userId}, ${`Harness T3 ingreso ${tag}`}, 'income', '#4C8C4A')`;
  track("categories", incomeCategoryId);
  const account = await open("Harness T3 filtro");
  const other = await open("Harness T3 filtro destino");

  const book = async (
    description: string,
    from: string | null,
    to: string | null,
    amountCents: number,
    categoryId: string | null,
  ): Promise<string> => {
    const made = await createTransaction({
      fromAccountId: from,
      toAccountId: to,
      amountCents,
      occurredAt: today,
      description: `${description} ${tag}`,
      externalRef: null,
      splits: categoryId ? [{ categoryId, amountCents }] : [],
      labelIds: [],
    });
    keep("transactions", made.transactionId);
    return made.transactionId;
  };
  const expenseId = await book("Harness T3 gasto", account, null, 100_000, scope.categoryId);
  const incomeId = await book("Harness T3 ingreso", null, account, 50_000, incomeCategoryId);
  const transferId = await book("Harness T3 traslado", account, other, 20_000, null);

  // Derived is now 1 000 000 - 100 000 + 50 000 - 20 000 = 930 000. Count high, then low.
  const gainedBy = await reconcileAccount({ accountId: account, reconciledOn: today, realMagnitudeCents: 1_000_000, expectedDerivedCents: 930_000 });
  const lostBy = await reconcileAccount({ accountId: account, reconciledOn: today, realMagnitudeCents: 900_000, expectedDerivedCents: 1_000_000 });
  const history = await listAccountReconciliations(account);
  const inId = history.find((row) => row.gapCents === 70_000)?.transactionId;
  const outId = history.find((row) => row.gapCents === -100_000)?.transactionId;
  assert(
    next("The fixture books one adjustment into the account and one out of it"),
    gainedBy.ok && lostBy.ok && inId !== undefined && inId !== null && outId !== undefined && outId !== null,
    `${JSON.stringify(gainedBy)} / ${JSON.stringify(lostBy)} / ${history.map((row) => row.gapCents).join(",")}`,
  );
  const adjustmentIds = [inId ?? "", outId ?? ""].sort();

  const idsOf = async (filters: Parameters<typeof listTransactions>[0]) =>
    (await listTransactions({ accountId: account, ...filters })).map((row) => row.id).sort();
  const sameIds = (got: string[], want: string[]) => JSON.stringify([...got].sort()) === JSON.stringify([...want].sort());

  const expenseIds = await idsOf({ kind: "expense" });
  assert(
    next("Expense leaves out an outgoing adjustment"),
    sameIds(expenseIds, [expenseId]),
    `expense filter listed ${expenseIds.length} rows: ${expenseIds.join(",")}; expected only ${expenseId}`,
  );
  const incomeIds = await idsOf({ kind: "income" });
  assert(
    next("Income leaves out an incoming adjustment"),
    sameIds(incomeIds, [incomeId]),
    `income filter listed ${incomeIds.length} rows: ${incomeIds.join(",")}; expected only ${incomeId}`,
  );
  const adjustmentRows = await listTransactions({ accountId: account, adjustments: true });
  assert(
    next("The adjustment filter selects both adjustments, each marked by its reconciliation"),
    sameIds(adjustmentRows.map((row) => row.id), adjustmentIds) &&
      adjustmentRows.every((row) => row.reconciliationId !== null),
    `listed ${adjustmentRows.map((row) => `${row.id}/${row.reconciliationId}`).join(",")}; expected ${adjustmentIds.join(",")}`,
  );
  const allIds = await idsOf({});
  assert(
    next("The adjustment filter is off unless asked: no filter lists all five rows"),
    sameIds(allIds, [expenseId, incomeId, transferId, ...adjustmentIds]),
    `unfiltered list held ${allIds.length} rows`,
  );
  const offIds = await idsOf({ adjustments: false });
  assert(
    next("adjustments: false is the same as absent"),
    sameIds(offIds, allIds),
    `adjustments:false listed ${offIds.length} rows against ${allIds.length}`,
  );
  const transferIds = await idsOf({ kind: "transfer" });
  assert(
    next("Transfer is unchanged by the adjustment predicate"),
    sameIds(transferIds, [transferId]),
    `transfer filter listed ${transferIds.length} rows`,
  );
  const none = await idsOf({ kind: "expense", adjustments: true });
  assert(
    next("Expense and adjustments together select nothing"),
    none.length === 0,
    `${none.length} rows`,
  );

  const totalsOf = async (filters: Parameters<typeof getTransactionTotals>[0]) => {
    const totals = await getTransactionTotals({ accountId: account, ...filters });
    return { count: totals.count, net: totals.nets.reduce((sum, row) => sum + row.netCents, 0) };
  };
  const [tExpense, tIncome, tAdjust, tAll] = await Promise.all([
    totalsOf({ kind: "expense" }),
    totalsOf({ kind: "income" }),
    totalsOf({ adjustments: true }),
    totalsOf({}),
  ]);
  assert(
    next("The totals count what the list lists"),
    tExpense.count === 1 && tExpense.net === -100_000 &&
      tIncome.count === 1 && tIncome.net === 50_000 &&
      tAdjust.count === 2 && tAdjust.net === 0 &&
      tAll.count === 5 && tAll.net === -50_000,
    `expense ${JSON.stringify(tExpense)}, income ${JSON.stringify(tIncome)}, adjustments ${JSON.stringify(tAdjust)}, all ${JSON.stringify(tAll)}`,
  );

  const exportOf = async (filters: NonNullable<Parameters<typeof readExport>[0]["transactionFilters"]>) =>
    ((await readExport({ entityKeys: ["transactions"], transactionFilters: { accountId: account, ...filters } })).transactions ?? []);
  const [xExpense, xIncome, xAdjust, xAll] = await Promise.all([
    exportOf({ kind: "expense" }),
    exportOf({ kind: "income" }),
    exportOf({ adjustments: true }),
    exportOf({}),
  ]);
  assert(
    next("The export narrows the same way"),
    xExpense.length === 1 && xExpense[0].description === `Harness T3 gasto ${tag}` && !xExpense[0].adjustment &&
      xIncome.length === 1 && xIncome[0].description === `Harness T3 ingreso ${tag}` &&
      xAdjust.length === 2 && xAdjust.every((row) => row.adjustment === true) &&
      xAll.length === 5 && xAll.filter((row) => row.adjustment === true).length === 2,
    `export expense ${xExpense.length}, income ${xIncome.length}, adjustments ${xAdjust.length} (${xAdjust.map((row) => row.adjustment).join(",")}), all ${xAll.length}`,
  );
}

// M22: a signed counted figure reaches the ledger with the account's sign (RF-137). The countings
// start from a derived 0, so the expected books are the whole story: nothing else moves them.
async function negativeCountSuite(userId: string): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const open = async (name: string, kind: "asset" | "liability"): Promise<string> => {
    const { accountId } = await createAccount({
      name: `${name} ${tag}`,
      kind,
      subtype: kind === "asset" ? "bank" : "card",
      ownerUserId: userId,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 0,
      balanceOn: shiftDate(today, -10),
    });
    keep("accounts", accountId);
    return accountId;
  };
  const asset = await open("Harness M22 activo", "asset");
  const card = await open("Harness M22 tarjeta", "liability");

  type Marked = { from_account_id: string | null; to_account_id: string | null; amount_cents: string };
  const markedOf = (reconciliationId: string) =>
    fixtureSql<Marked[]>`
      select from_account_id, to_account_id, amount_cents::text
      from transactions where reconciliation_id = ${reconciliationId}`;
  const balanceOf = async (accountId: string) =>
    (await fixtureSql<{ balance: string }[]>`
      select private.account_settlement_balance_on(${accountId}, ${today}::date)::text as balance`)[0].balance;

  const assetCount = await reconcileAccount({ accountId: asset, reconciledOn: today, realMagnitudeCents: -500_000, expectedDerivedCents: 0 });
  const cardCount = await reconcileAccount({ accountId: card, reconciledOn: today, realMagnitudeCents: -500_000, expectedDerivedCents: 0 });
  const assetId = assetCount.ok ? assetCount.id : "";
  const cardId = cardCount.ok ? cardCount.id : "";

  const assetStored = assetId ? await readColumn<string>("account_reconciliations", "id", assetId, "counted_balance_cents") : undefined;
  assert(
    next("An asset's negative count is stored negative"),
    assetStored === "-500000",
    `counted_balance_cents = ${assetStored}, ${JSON.stringify(assetCount)}`,
  );
  const assetMarked = assetId ? await markedOf(assetId) : [];
  assert(
    next("A negative count books the gap out of the asset"),
    assetCount.ok && assetCount.gapCents === -500_000 && assetMarked.length === 1 &&
      assetMarked[0].from_account_id === asset && assetMarked[0].to_account_id === null &&
      assetMarked[0].amount_cents === "500000",
    `${JSON.stringify(assetCount)} / ${JSON.stringify(assetMarked)}`,
  );

  const cardStored = cardId ? await readColumn<string>("account_reconciliations", "id", cardId, "counted_balance_cents") : undefined;
  assert(
    next("An overpaid card's negative count is stored positive"),
    cardStored === "500000",
    `counted_balance_cents = ${cardStored}, ${JSON.stringify(cardCount)}`,
  );
  const cardMarked = cardId ? await markedOf(cardId) : [];
  assert(
    next("An overpaid card's gap is booked into the card"),
    cardCount.ok && cardCount.gapCents === 500_000 && cardMarked.length === 1 &&
      cardMarked[0].to_account_id === card && cardMarked[0].from_account_id === null &&
      cardMarked[0].amount_cents === "500000",
    `${JSON.stringify(cardCount)} / ${JSON.stringify(cardMarked)}`,
  );

  const assetHistory = await listAccountReconciliations(asset);
  const cardHistory = await listAccountReconciliations(card);
  assert(
    next("The asset's history reads counted -500000, gap -500000, derived 0"),
    assetHistory.length === 1 && assetHistory[0].countedCents === -500_000 &&
      assetHistory[0].gapCents === -500_000 && assetHistory[0].derivedCents === 0,
    JSON.stringify(assetHistory),
  );
  assert(
    next("The card's history reads counted +500000, gap +500000, derived 0"),
    cardHistory.length === 1 && cardHistory[0].countedCents === 500_000 &&
      cardHistory[0].gapCents === 500_000 && cardHistory[0].derivedCents === 0,
    JSON.stringify(cardHistory),
  );

  const [assetBalance, cardBalance] = await Promise.all([balanceOf(asset), balanceOf(card)]);
  assert(
    next("Each balance afterwards equals what was counted"),
    assetBalance === "-500000" && cardBalance === "500000",
    `asset ${assetBalance}, card ${cardBalance}`,
  );

  const again = await reconcileAccount({ accountId: asset, reconciledOn: today, realMagnitudeCents: -500_000, expectedDerivedCents: -500_000 });
  const againMarked = again.ok ? await markedOf(again.id) : [];
  assert(
    next("A negative count that matches the ledger books nothing"),
    again.ok && again.gapCents === 0 && againMarked.length === 0,
    `${JSON.stringify(again)} / ${JSON.stringify(againMarked)}`,
  );
}

// M28: the importer picks a movement's or a rule's category by the scope of its account (RF-140).
// A hand-built scope, no database: the pipeline is pure over what `readImportScope` returns.
async function importCategoryScopeSuite(): Promise<void> {
  console.log("");
  const U = randomUUID();
  const G = randomUUID();
  const id = () => randomUUID();
  const cat = (name: string, kind: "expense" | "income", owner: "user" | "group", externalRef: string | null = null) => ({
    id: id(),
    name,
    externalRef,
    ownerUserId: owner === "user" ? U : null,
    groupId: owner === "group" ? G : null,
    kind,
  });
  const acct = (name: string, owner: "user" | "group", externalRef: string | null = null) => ({
    id: id(),
    name,
    externalRef,
    ownerUserId: owner === "user" ? U : null,
    groupId: owner === "group" ? G : null,
    settlementCurrency: "COP",
  });

  const mercadoOwn = cat("M28 Mercado", "expense", "user");
  const mercadoFund = cat("M28 Mercado", "expense", "group");
  const sueldoOwn = cat("M28 Sueldo", "income", "user");
  const sueldoFund = cat("M28 Sueldo", "income", "group");
  const onlyFund = cat("M28 Solo fondo", "expense", "group");
  const onlyOwn = cat("M28 Solo mio", "expense", "user");
  const twiceA = cat("M28 Doble", "expense", "user");
  const twiceB = cat("M28 Doble", "expense", "user");
  const keyedFund = cat("M28 Con llave", "expense", "group", "m28-cat-ref");
  const own = acct("M28 Cuenta mia", "user");
  const fund = acct("M28 Cuenta fondo", "group", "m28-acct-ref");

  const emptyRefs = (): Record<"accounts" | "members" | "categories" | "recurringRules" | "transactions", Set<string>> => ({
    accounts: new Set(["m28-acct-ref"]),
    members: new Set(),
    categories: new Set(["m28-cat-ref"]),
    recurringRules: new Set(),
    transactions: new Set(),
  });
  const scopeFor = (groupId: string | null) => ({
    caller: { userId: U, groupId },
    accounts: [own, fund],
    categories: [mercadoOwn, mercadoFund, sueldoOwn, sueldoFund, onlyFund, onlyOwn, twiceA, twiceB, keyedFund],
    existingRefs: emptyRefs(),
  });

  type Files = Partial<Record<"accounts" | "categories", RawRow[]>>;
  const move = (over: RawRow): RawRow => ({
    externalRef: null,
    fromAccount: null,
    toAccount: null,
    amount: 1_000_000,
    category: null,
    occurredAt: "2026-03-31",
    description: null,
    adjustment: null,
    currency: null,
    ...over,
  });
  const rule = (over: RawRow): RawRow => ({
    externalRef: null,
    fromAccount: null,
    toAccount: null,
    amount: 1_000_000,
    category: null,
    description: null,
    frequency: "monthly",
    intervalN: 1,
    dayOfMonth: 1,
    nextRunOn: "2026-12-01",
    endsOn: null,
    ...over,
  });
  const run = (
    entity: "transactions" | "recurringRules" | "categories",
    raw: RawRow,
    groupId: string | null = G,
    files: Files = {},
    index = 0,
  ) => {
    const s = scopeFor(groupId);
    const refs = buildEffectiveRefs(s, (e) => (files as Record<string, RawRow[]>)[e] ?? []);
    return processRow(entity, raw, index, index + 2, refs, s.existingRefs[entity]);
  };
  const splitOf = (row: { object: unknown }) =>
    (row.object as { splits?: { categoryId: string }[] } | null)?.splits?.[0]?.categoryId;
  const ruleCat = (row: { object: unknown }) => (row.object as { categoryId?: string } | null)?.categoryId;
  const errs = (row: { errors: { key: string; column: string | null; value: string | null }[] }) =>
    JSON.stringify(row.errors);
  const OUT = "data.import.errors.categoryOutOfScope";
  const refused = (row: { errors: { key: string; column: string | null; value: string | null }[]; object: unknown }, key: string, value: string) =>
    row.object === null && row.errors.length === 1 && row.errors[0].key === key &&
    row.errors[0].column === "category" && row.errors[0].value === value;

  let r = run("transactions", move({ fromAccount: fund.name, category: "M28 Mercado" }));
  assert(next("An expense on a fund account takes the fund's category of that name"),
    r.errors.length === 0 && splitOf(r) === mercadoFund.id, `${errs(r)} split ${splitOf(r)}`);
  r = run("transactions", move({ fromAccount: own.name, category: "M28 Mercado" }));
  assert(next("An expense on a personal account takes the person's category of that name"),
    r.errors.length === 0 && splitOf(r) === mercadoOwn.id, `${errs(r)} split ${splitOf(r)}`);
  r = run("transactions", move({ toAccount: fund.name, category: "M28 Sueldo" }));
  assert(next("An income takes the scope of its destination account"),
    r.errors.length === 0 && splitOf(r) === sueldoFund.id, `${errs(r)} split ${splitOf(r)}`);
  r = run("transactions", move({ toAccount: own.name, category: "M28 Sueldo" }));
  assert(next("An income on a personal account takes the person's category"),
    r.errors.length === 0 && splitOf(r) === sueldoOwn.id, `${errs(r)} split ${splitOf(r)}`);

  r = run("transactions", move({ fromAccount: own.name, category: onlyFund.name }));
  assert(next("A personal account naming a category only the fund holds is refused on the category"),
    refused(r, OUT, onlyFund.name), errs(r));
  r = run("transactions", move({ fromAccount: fund.name, category: onlyOwn.name }));
  assert(next("A fund account naming a category only the person holds is refused on the category"),
    refused(r, OUT, onlyOwn.name), errs(r));
  r = run("transactions", move({ fromAccount: fund.name, category: "M28 No existe" }));
  assert(next("A name nobody holds stays unknown"),
    refused(r, "data.import.errors.unknownReference", "M28 No existe"), errs(r));
  r = run("transactions", move({ fromAccount: own.name, category: twiceA.name }));
  assert(next("Two categories of that name inside the account's scope stay ambiguous"),
    refused(r, "data.import.errors.ambiguousReference", twiceA.name), errs(r));
  r = run("transactions", move({ fromAccount: own.name, category: sueldoOwn.name }));
  assert(next("The kind check runs after the scope: an income category on an expense is a kind mismatch"),
    refused(r, "data.import.errors.categoryKindMismatch", sueldoOwn.name), errs(r));

  r = run("recurringRules", rule({ fromAccount: fund.name, category: "M28 Mercado" }));
  assert(next("A rule on a fund account takes the fund's category"),
    r.errors.length === 0 && ruleCat(r) === mercadoFund.id, `${errs(r)} cat ${ruleCat(r)}`);
  r = run("recurringRules", rule({ fromAccount: own.name, category: "M28 Mercado" }));
  assert(next("A rule on a personal account takes the person's category"),
    r.errors.length === 0 && ruleCat(r) === mercadoOwn.id, `${errs(r)} cat ${ruleCat(r)}`);
  r = run("recurringRules", rule({ fromAccount: own.name, category: onlyFund.name }));
  assert(next("A rule naming a category of the other scope is refused"), refused(r, OUT, onlyFund.name), errs(r));
  r = run("recurringRules", rule({ toAccount: fund.name, category: "M28 Sueldo" }));
  assert(next("An income rule takes its destination's scope"),
    r.errors.length === 0 && ruleCat(r) === sueldoFund.id, `${errs(r)} cat ${ruleCat(r)}`);

  // A category the file adds lands where the commit puts it: the caller's fund, else the caller.
  const fileCat: RawRow = { externalRef: null, name: "M28 Nueva", kind: "expense", parent: null, color: CATEGORY_COLORS[0] };
  const placeholder = run("categories", fileCat, G, { categories: [fileCat] }).placeholderId;
  r = run("transactions", move({ fromAccount: fund.name, category: "M28 Nueva" }), G, { categories: [fileCat] });
  assert(next("A file-new category counts as the fund's for a caller in a fund"),
    placeholder !== null && r.errors.length === 0 && splitOf(r) === placeholder, `${errs(r)} split ${splitOf(r)} vs ${placeholder}`);
  r = run("transactions", move({ fromAccount: own.name, category: "M28 Nueva" }), G, { categories: [fileCat] });
  assert(next("A file-new category is out of scope for a personal account of a caller in a fund"),
    refused(r, OUT, "M28 Nueva"), errs(r));
  r = run("transactions", move({ fromAccount: own.name, category: "M28 Nueva" }), null, { categories: [fileCat] });
  assert(next("A file-new category counts as the caller's own for a caller with no fund"),
    r.errors.length === 0 && splitOf(r) !== undefined, errs(r));

  // A category the file renames keeps the scope it has.
  const renamed: RawRow = { externalRef: "m28-cat-ref", name: "M28 Renombrada", kind: "expense", parent: null, color: CATEGORY_COLORS[0] };
  r = run("transactions", move({ fromAccount: fund.name, category: "M28 Renombrada" }), G, { categories: [renamed] });
  assert(next("A file row that updates a fund category keeps it in the fund"),
    r.errors.length === 0 && splitOf(r) === keyedFund.id, `${errs(r)} split ${splitOf(r)}`);
  r = run("transactions", move({ fromAccount: own.name, category: "M28 Renombrada" }), G, { categories: [renamed] });
  assert(next("A renamed fund category stays out of scope for a personal account"), refused(r, OUT, "M28 Renombrada"), errs(r));

  // A file-new account lands by its placement.
  const newAcct = (placement: string): RawRow => ({
    externalRef: null, name: "M28 Nueva cuenta", kind: "asset", subtype: "bank", placement,
    institution: null, amount: 0, balanceOn: "2026-01-01", settlementCurrency: null,
  });
  r = run("transactions", move({ fromAccount: "M28 Nueva cuenta", category: onlyFund.name }), G, { accounts: [newAcct("group")] });
  assert(next("A file-new fund account takes the fund's categories"), r.errors.length === 0 && splitOf(r) === onlyFund.id, errs(r));
  r = run("transactions", move({ fromAccount: "M28 Nueva cuenta", category: onlyFund.name }), G, { accounts: [newAcct("personal")] });
  assert(next("A file-new personal account is out of scope for the fund's category"), refused(r, OUT, onlyFund.name), errs(r));
  r = run("transactions", move({ fromAccount: "M28 Nueva cuenta", category: onlyOwn.name }), G, { accounts: [newAcct("personal")] });
  assert(next("A file-new personal account takes the person's categories"), r.errors.length === 0 && splitOf(r) === onlyOwn.id, errs(r));
  r = run("transactions", move({ fromAccount: "M28 Nueva cuenta", category: onlyOwn.name }), null, { accounts: [newAcct("group")] });
  assert(next("A file-new fund account for a caller with no fund has no scope: the name alone decides"),
    r.errors.length === 0 && splitOf(r) === onlyOwn.id, errs(r));

  // A file row that updates an existing account keeps its scope, whatever placement it carries.
  const updated: RawRow = { ...newAcct("personal"), externalRef: "m28-acct-ref", name: "M28 Fondo renombrada" };
  r = run("transactions", move({ fromAccount: "M28 Fondo renombrada", category: onlyFund.name }), G, { accounts: [updated] });
  assert(next("A file row that updates a fund account keeps it in the fund"),
    r.errors.length === 0 && splitOf(r) === onlyFund.id, errs(r));

  assert(next("Both languages carry the out-of-scope copy"),
    (es.data.import.errors as Record<string, string>).categoryOutOfScope ===
      "Esta categoría es de otro alcance que la cuenta. Elige una del fondo para una cuenta del fondo, o una tuya para una cuenta tuya." &&
      (en.data.import.errors as Record<string, string>).categoryOutOfScope ===
        "This category belongs to another scope than the account. Pick a fund category for a fund account, or one of yours for your own account.",
    "categoryOutOfScope missing or reworded");
}

// M25: the two category readers that used to drop the scope say it (RF-140). A personal category and
// the fund's carry one name, so only the scope tells the two rows apart.
async function categoryScopeSuite(): Promise<void> {
  console.log("");
  const today = todayInBogota();
  const tag = randomUUID().slice(0, 8);
  const name = `Harness T3 Mercado ${tag}`;

  const leader = await createMembershipFreeUser();
  const { groupId } = await asUser(leader, () =>
    createGroup({ name: `Harness fondo alcance ${tag}`, leaderName: "Harness lider alcance", cashMode: "shared", locale: "es" }),
  );
  track("groups", groupId);
  const [seeded] = await fixtureSql<{ member_id: string; account_id: string }[]>`
    select
      (select id from group_members where group_id = ${groupId} and user_id = ${leader.id}) as member_id,
      (select id from accounts where group_id = ${groupId} and subtype = 'cash') as account_id`;
  track("group_members", seeded.member_id);
  track("accounts", seeded.account_id);
  for (const row of await fixtureSql<{ id: string }[]>`select id from categories where group_id = ${groupId}`) {
    track("categories", row.id);
  }

  const open = async (placement: "personal" | "group"): Promise<string> => {
    const { accountId } = await asUser(leader, () =>
      createAccount({
        name: `Harness alcance ${placement} ${tag}`,
        kind: "asset",
        subtype: "bank",
        ownerUserId: placement === "personal" ? leader.id : null,
        groupId: placement === "group" ? groupId : null,
        isShared: placement === "group",
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor: 5_000_000,
        balanceOn: shiftDate(today, -10),
      }),
    );
    keep("accounts", accountId);
    return accountId;
  };
  const [ownAccount, groupAccount] = [await open("personal"), await open("group")];

  const makeCategory = async (scope: { ownerUserId: string } | { groupId: string }, parentId: string | null, label: string) => {
    const { categoryId } = await asUser(leader, () =>
      createCategory({ scope, name: label, kind: "expense", parentId, color: "#0E7490" }),
    );
    track("categories", categoryId);
    return categoryId;
  };
  const ownCategory = await makeCategory({ ownerUserId: leader.id }, null, name);
  const groupCategory = await makeCategory({ groupId }, null, name);
  const groupChild = await makeCategory({ groupId }, groupCategory, `Harness T3 hija ${tag}`);

  const spent: string[] = [];
  const spend = async (from: string, categoryId: string, amountCents: number) => {
    const { transactionId } = await asUser(leader, () =>
      createTransaction({
        fromAccountId: from,
        toAccountId: null,
        amountCents,
        occurredAt: today,
        description: `Harness T3 alcance ${tag}`,
        externalRef: null,
        splits: [{ categoryId, amountCents }],
        labelIds: [],
      }),
    );
    track("transactions", transactionId);
    spent.push(transactionId);
  };
  await spend(ownAccount, ownCategory, 120_000);
  await spend(groupAccount, groupCategory, 340_000);

  const range = currentMonthRange();
  let tripsUsed = -1;
  let unitTrips = -1;
  const rows = (
    await asUser(leader, async () => {
      const unitStarted = roundTrips();
      await getMonthlyFlow(range);
      unitTrips = roundTrips() - unitStarted;
      const started = roundTrips();
      const read = await getExpensesByCategory(range);
      tripsUsed = roundTrips() - started;
      return read;
    })
  ).filter((row) => row.name === name);
  const ownRow = rows.find((row) => row.categoryId === ownCategory);
  const groupRow = rows.find((row) => row.categoryId === groupCategory);

  assert(
    next("A personal category's row says personal"),
    ownRow?.scope === "personal" && ownRow.totalCents === 120_000,
    JSON.stringify(ownRow),
  );
  assert(
    next("A fund category's row says group"),
    groupRow?.scope === "group" && groupRow.totalCents === 340_000,
    JSON.stringify(groupRow),
  );
  assert(
    next("Same name, two scopes, two rows, each with its own total"),
    rows.length === 2 && ownRow !== undefined && groupRow !== undefined && ownRow.categoryId !== groupRow.categoryId,
    JSON.stringify(rows),
  );
  assert(
    next("The expenses by category still cost one round trip"),
    unitTrips > 0 && tripsUsed === unitTrips,
    `${tripsUsed} round trips against ${unitTrips} for one single-statement read`,
  );

  const options = await asUser(leader, () => getWebhookCredentialOptions());
  const named = options.categories.filter((category) => category.name === name);
  assert(
    next("The webhook options carry the scope of both same-named categories"),
    named.length === 2 &&
      named.find((category) => category.id === ownCategory)?.scope === "personal" &&
      named.find((category) => category.id === groupCategory)?.scope === "group",
    JSON.stringify(named),
  );
  const optionAccounts = new Map(options.accounts.map((account) => [account.id, account.scope]));
  assert(
    next("Every webhook account option says its scope: the fund's shared account group, the leader's own personal"),
    optionAccounts.get(groupAccount) === "group" &&
      optionAccounts.get(ownAccount) === "personal" &&
      options.accounts.every((account) => account.scope === "personal" || account.scope === "group"),
    JSON.stringify(options.accounts),
  );
  assert(
    next("A fund child category inherits the group scope"),
    options.categories.find((category) => category.id === groupChild)?.scope === "group",
    JSON.stringify(options.categories.find((category) => category.id === groupChild)),
  );

  // A fund-account movement has no owning user, so the identity purge would leave it pinned to the fund's category.
  await fixtureSql`delete from transactions where id in ${fixtureSql(spent)}`;
}

// Survivors of mutation testing: the budget's place and currency (RF-71, RF-140, RF-121) and a
// rename that touches one row. Appended last so the numbering of the checks above does not move.
async function survivorsSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const { budgetAction, updateMember: renameMember } = {
    budgetAction: ((await import("@/app/actions/budgets")) as unknown as {
      createBudgetAction: (input: {
        categoryId: string;
        accountId?: string | null;
        period: string;
        limit: string;
        thresholdPct: number;
      }) => Promise<{ data?: { budgetId: string }; serverError?: string }>;
    }).createBudgetAction,
    updateMember: (await import("@/db/queries/group-members")).updateMember,
  };

  const leader = await createMembershipFreeUser();
  const { groupId } = await asUser(leader, () =>
    createGroup({ name: `Harness fondo sobrevivientes ${tag}`, leaderName: "Harness lider sobrevivientes", cashMode: "shared", locale: "es" }),
  );
  track("groups", groupId);
  const [seeded] = await fixtureSql<{ member_id: string; account_id: string }[]>`
    select
      (select id from group_members where group_id = ${groupId} and user_id = ${leader.id}) as member_id,
      (select id from accounts where group_id = ${groupId} and subtype = 'cash') as account_id`;
  track("group_members", seeded.member_id);
  track("accounts", seeded.account_id);
  for (const row of await fixtureSql<{ id: string }[]>`select id from categories where group_id = ${groupId}`) {
    track("categories", row.id);
  }
  // A personal currency that is neither the fund's nor the account's: any fallback to it shows.
  await fixtureSql`update app_users set settlement_currency = 'EUR' where id = ${leader.id}`;

  const { accountId: usdAccount } = await asUser(leader, () =>
    createAccount({
      name: `Harness dolares ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: null,
      groupId,
      isShared: true,
      institution: null,
      lastFour: null,
      settlementCurrency: "USD",
      amountMinor: 100_000,
      balanceOn: shiftDate(today, -10),
    }),
  );
  keep("accounts", usdAccount);
  const groupCategory = (
    await asUser(leader, () =>
      createCategory({ scope: { groupId }, name: `Harness sobrev fondo ${tag}`, kind: "expense", parentId: null, color: "#0E7490" }),
    )
  ).categoryId;
  track("categories", groupCategory);
  const ownCategory = (
    await asUser(leader, () =>
      createCategory({ scope: { ownerUserId: leader.id }, name: `Harness sobrev propia ${tag}`, kind: "expense", parentId: null, color: "#0E7490" }),
    )
  ).categoryId;
  track("categories", ownCategory);

  const onUsd = await asUser(leader, () => resolveBudgetPlace({ categoryId: groupCategory, accountId: usdAccount }));
  assert(
    next("A budget placed on a dollar account inside a peso fund takes the account's currency, in the fund's place"),
    onUsd?.currency === "USD" && onUsd.groupId === groupId && onUsd.ownerUserId === null,
    JSON.stringify(onUsd),
  );
  const onFund = await asUser(leader, () => resolveBudgetPlace({ categoryId: groupCategory }));
  assert(
    next("A fund budget with no account takes the fund's currency, not the caller's personal one"),
    onFund?.currency === "COP" && onFund.groupId === groupId,
    JSON.stringify(onFund),
  );
  const onOwn = await asUser(leader, () => resolveBudgetPlace({ categoryId: ownCategory }));
  assert(
    next("A personal budget with no account takes the caller's own settlement currency"),
    onOwn?.currency === "EUR" && onOwn.ownerUserId === leader.id && onOwn.groupId === null,
    JSON.stringify(onOwn),
  );

  const created = await asUser(leader, () =>
    budgetAction({ categoryId: groupCategory, accountId: usdAccount, period: "monthly", limit: "12.34", thresholdPct: 80 }),
  );
  const [stored] = created?.data
    ? await fixtureSql<{ limit_cents: string; account_id: string | null; group_id: string | null }[]>`
        select limit_cents::text, account_id, group_id from budgets where id = ${created.data.budgetId}`
    : [];
  if (created?.data) keep("budgets", created.data.budgetId);
  assert(
    next("createBudgetAction on a dollar account in a peso fund stores the limit in dollar cents against that account"),
    created?.serverError === undefined && stored?.limit_cents === "1234" && stored.account_id === usdAccount && stored.group_id === groupId,
    `serverError = ${created?.serverError ?? "none"}, row = ${JSON.stringify(stored)}`,
  );

  // The account the action is handed is the account the place is resolved from: one the caller cannot
  // read refuses as not found, before anything is inserted.
  const stranger = await createMembershipFreeUser();
  const { accountId: strangerAccount } = await asUser(stranger, () =>
    createAccount({
      name: `Harness ajena ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: stranger.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "USD",
      amountMinor: 100_000,
      balanceOn: shiftDate(today, -10),
    }),
  );
  keep("accounts", strangerAccount);
  const budgetsBefore = (await fixtureSql<{ n: number }[]>`select count(*)::int as n from budgets where category_id = ${groupCategory}`)[0].n;
  const refusals = [
    await asUser(leader, () => budgetAction({ categoryId: groupCategory, accountId: strangerAccount, period: "monthly", limit: "5", thresholdPct: 80 })),
    await asUser(leader, () => budgetAction({ categoryId: groupCategory, accountId: randomUUID(), period: "monthly", limit: "5", thresholdPct: 80 })),
  ];
  const budgetsAfter = (await fixtureSql<{ n: number }[]>`select count(*)::int as n from budgets where category_id = ${groupCategory}`)[0].n;
  assert(
    next("createBudgetAction on an account the caller cannot read, or that does not exist, refuses as not found and files nothing"),
    refusals.every((r) => r?.serverError === "errors.notFound" && r.data === undefined) && budgetsAfter === budgetsBefore,
    `refusals = ${refusals.map((r) => r?.serverError ?? "ok").join(", ")}, budgets ${budgetsBefore} -> ${budgetsAfter}`,
  );

  // A rename changes the row it names and no sibling.
  const seedPlaceholder = async (name: string): Promise<string> => {
    const id = randomUUID();
    await fixtureSql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: leader.id, role: "authenticated", aud: "authenticated" })}, true)`;
      await tx`insert into group_members (id, group_id, name, role) values (${id}, ${groupId}, ${name}, 'member')`;
    });
    track("group_members", id);
    return id;
  };
  const target = await seedPlaceholder("Harness primo objetivo");
  const sibling = await seedPlaceholder("Harness primo hermano");
  const nameOf = async (id: string) =>
    (await fixtureSql<{ name: string }[]>`select name from group_members where id = ${id}`)[0]?.name;
  const leaderBefore = await nameOf(seeded.member_id);
  const done = await asUser(leader, () => renameMember({ groupId, memberId: target, name: "Harness primo renombrado" }));
  const [targetName, siblingName, leaderAfter] = [await nameOf(target), await nameOf(sibling), await nameOf(seeded.member_id)];
  assert(
    next("Renaming a member without an address changes that row alone: a sibling and the leader keep their names"),
    done === true &&
      targetName === "Harness primo renombrado" &&
      siblingName === "Harness primo hermano" &&
      leaderAfter === leaderBefore,
    `target = ${targetName}, sibling = ${siblingName}, leader ${leaderBefore} -> ${leaderAfter}`,
  );
}

type MovementResult = {
  data?: { ok?: boolean; transactionId?: string; reason?: string };
  serverError?: string;
  validationErrors?: unknown;
};

// M42: a create sent twice books once, an edit loaded before another person's save is refused.
async function idempotencySuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const actions = (await import("@/app/actions/transactions")) as unknown as {
    createTransactionAction: (input: Record<string, unknown>) => Promise<MovementResult>;
    updateTransactionAction: (input: Record<string, unknown>) => Promise<MovementResult>;
  };

  const user = await createMembershipFreeUser();
  const ownerScope = { ownerUserId: user.id };
  const { accountId } = await asUser(user, () =>
    createAccount({
      name: `Harness idem ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: user.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 100_000_000,
      balanceOn: shiftDate(today, -10),
    }),
  );
  track("accounts", accountId);
  const mkCategory = async (name: string): Promise<string> => {
    const { categoryId } = await asUser(user, () =>
      createCategory({ scope: ownerScope, name: `${name} ${tag}`, kind: "expense", parentId: null, color: "#0E7490" }),
    );
    track("categories", categoryId);
    return categoryId;
  };
  const catA = await mkCategory("Harness idem A");
  const catB = await mkCategory("Harness idem B");
  const { labelId } = await asUser(user, () =>
    createLabel({ scope: ownerScope, name: `Harness idem ${tag}`, color: "#7A4CB4" }),
  );
  track("labels", labelId);

  const expense = (over: Record<string, unknown> = {}) => ({
    fromAccountId: accountId,
    toAccountId: null,
    amount: "100",
    occurredAt: today,
    description: `idem ${tag}`,
    splits: [{ categoryId: catA, amount: "100" }],
    labelIds: [labelId],
    ...over,
  });
  const create = (over: Record<string, unknown> = {}) =>
    asUser(user, () => actions.createTransactionAction(expense(over)));
  const update = (id: string, over: Record<string, unknown> = {}) =>
    asUser(user, () => actions.updateTransactionAction({ transactionId: id, ...expense(), ...over }));
  const trackRows = (ids: string[]) => ids.forEach((id) => track("transactions", id));
  type MovementRow = { id: string; external_ref: string | null; amount_cents: string; kind: string };
  const byRef = (refs: string[]) =>
    fixtureSql<MovementRow[]>`
      select id, external_ref, amount_cents::text, kind from transactions
      where owner_user_id = ${user.id} and external_ref in ${fixtureSql(refs)}`;
  const byDescription = (text: string) =>
    fixtureSql<MovementRow[]>`
      select id, external_ref, amount_cents::text, kind from transactions
      where owner_user_id = ${user.id} and description = ${text}`;
  const byId = (rowId: string) =>
    fixtureSql<MovementRow[]>`
      select id, external_ref, amount_cents::text, kind from transactions where id = ${rowId}`;
  const isStale = (r: MovementResult) =>
    r.serverError === "errors.stale" || (r.data?.ok === false && r.data.reason === "stale");

  // Q: the same request sent twice
  const ref = randomUUID();
  const first = await create({ requestRef: ref });
  const second = await create({ requestRef: ref });
  const booked = await byRef([`form:${ref}`]);
  trackRows(booked.map((r) => r.id));
  const splitsBooked = booked[0]
    ? (await fixtureSql<{ n: number }[]>`select count(*)::int as n from transaction_splits where transaction_id = ${booked[0].id}`)[0].n
    : -1;
  assert(
    next("A create sent twice with the same requestRef books one movement under form:<ref> and both answers name its id"),
    booked.length === 1 &&
      booked[0].amount_cents === "10000" &&
      booked[0].kind === "expense" &&
      splitsBooked === 1 &&
      first.data?.ok === true &&
      second.data?.ok === true &&
      first.data.transactionId === booked[0].id &&
      second.data.transactionId === booked[0].id,
    `${booked.length} row(s), splits ${splitsBooked}, first = ${JSON.stringify(first)}, second = ${JSON.stringify(second)}`,
  );

  // Q: two different requests with the same figures
  const refA = randomUUID();
  const refB = randomUUID();
  const ra = await create({ requestRef: refA });
  const rb = await create({ requestRef: refB });
  const pair = await byRef([`form:${refA}`, `form:${refB}`]);
  trackRows(pair.map((r) => r.id));
  assert(
    next("Two different requestRefs with identical figures book two movements, each answered with its own id"),
    pair.length === 2 &&
      ra.data?.transactionId !== rb.data?.transactionId &&
      pair.some((r) => r.id === ra.data?.transactionId) &&
      pair.some((r) => r.id === rb.data?.transactionId),
    `${pair.length} row(s), ids ${ra.data?.transactionId} / ${rb.data?.transactionId}`,
  );

  // Q: no requestRef, nothing deduplicates
  const bare = `bare ${tag}`;
  const b1 = await create({ description: bare });
  const b2 = await create({ description: bare });
  const bareRows = await byDescription(bare);
  trackRows(bareRows.map((r) => r.id));
  assert(
    next("Two creates with no requestRef book two movements, neither under a form: key"),
    bareRows.length === 2 && bareRows.every((r) => !r.external_ref?.startsWith("form:")) && b1.data?.transactionId !== b2.data?.transactionId,
    `${bareRows.length} row(s), refs ${JSON.stringify(bareRows.map((r) => r.external_ref))}`,
  );

  // The movement two people have open
  const opened = await create({ requestRef: randomUUID(), description: `open ${tag}` });
  const id = opened.data?.transactionId ?? randomUUID();
  track("transactions", id);
  const stamp = async () =>
    (await fixtureSql<{ t: string }[]>`select updated_at::text as t from transactions where id = ${id}`)[0]?.t ?? "";
  const hasMicros = (t: string) => /\.\d{6}/.test(t) && !t.replace(/[+-]\d+$/, "").endsWith("000");
  // The test needs the microseconds to exist: a stamp that lands on a whole millisecond is touched again.
  for (let i = 0; i < 10 && !hasMicros(await stamp()); i++) {
    await fixtureSql`update transactions set description = description where id = ${id}`;
  }
  const loaded = await stamp();
  assert(next("The movement's updated_at::text carries microseconds the test can compare"), hasMicros(loaded), loaded);

  // Q: a fresh edit carrying the row's own stamp
  const fresh = await update(id, { amount: "500", expectedUpdatedAt: loaded, splits: [{ categoryId: catA, amount: "500" }] });
  const afterFresh = (await byId(id))[0];
  const stampAfter = await stamp();
  assert(
    next("An edit carrying the row's own updated_at::text, microseconds and all, is accepted and moves the stamp"),
    fresh.serverError === undefined && !isStale(fresh) && afterFresh?.amount_cents === "50000" && stampAfter !== loaded,
    `result = ${JSON.stringify(fresh)}, amount = ${afterFresh?.amount_cents}, stamp ${loaded} -> ${stampAfter}`,
  );

  // Q: the second person's edit, loaded before the first one saved
  const stale = await update(id, {
    amount: "7",
    expectedUpdatedAt: loaded,
    splits: [{ categoryId: catB, amount: "7" }],
    labelIds: [],
  });
  const afterStale = (await byId(id))[0];
  assert(
    next("An edit carrying a stamp older than the row is refused as stale and leaves the amount as the first save set it"),
    isStale(stale) && afterStale?.amount_cents === "50000",
    `result = ${JSON.stringify(stale)}, amount = ${afterStale?.amount_cents}`,
  );

  // Q: the refusal writes nothing else
  const kept = await fixtureSql<{ category_id: string; amount_cents: string }[]>`
    select category_id, amount_cents::text from transaction_splits where transaction_id = ${id}`;
  const keptLabels = await fixtureSql<{ label_id: string }[]>`
    select label_id from transaction_labels where transaction_id = ${id}`;
  assert(
    next("A stale edit leaves the splits and labels the first save wrote"),
    kept.length === 1 && kept[0].category_id === catA && kept[0].amount_cents === "50000" &&
      keptLabels.length === 1 && keptLabels[0].label_id === labelId,
    `splits = ${JSON.stringify(kept)}, labels = ${JSON.stringify(keptLabels)}`,
  );

  // Q: an edit that names no stamp still lands
  const blind = await update(id, { amount: "600", splits: [{ categoryId: catA, amount: "600" }] });
  const afterBlind = (await byId(id))[0];
  assert(
    next("An edit that carries no expectedUpdatedAt is not refused"),
    blind.serverError === undefined && !isStale(blind) && afterBlind?.amount_cents === "60000",
    `result = ${JSON.stringify(blind)}, amount = ${afterBlind?.amount_cents}`,
  );

  // Q: the create and its cause are one transaction
  const cause = await create({ requestRef: randomUUID(), description: `cause ${tag}` });
  const causeId = cause.data?.transactionId ?? randomUUID();
  track("transactions", causeId);
  const victim = `effect ${tag}`;
  const fn = `harness_m42_drop_cause_${tag.replace(/-/g, "")}`;
  // Stands in for the other person deleting the cause after the form read it and before the write ends.
  await fixtureSql.unsafe(`
    create function finances.${fn}() returns trigger language plpgsql security definer set search_path = finances, public as $f$
    begin
      if new.description = '${victim}' then delete from finances.transactions where id = '${causeId}'; end if;
      return new;
    end $f$`);
  await fixtureSql.unsafe(`create trigger ${fn} after insert on finances.transactions for each row execute function finances.${fn}()`);
  let refused: MovementResult;
  try {
    refused = await create({ requestRef: randomUUID(), description: victim, causedByTransactionId: causeId });
  } finally {
    await fixtureSql.unsafe(`drop trigger if exists ${fn} on finances.transactions`);
    await fixtureSql.unsafe(`drop function if exists finances.${fn}()`);
  }
  const leftovers = await byDescription(victim);
  trackRows(leftovers.map((r) => r.id));
  const causeLeft = await byId(causeId);
  assert(
    next("A create whose cause vanished before the write ended rolls back whole: an error, and no movement left behind"),
    causeLeft.length === 0 && leftovers.length === 0 && (refused.serverError !== undefined || refused.data?.ok === false),
    `cause rows = ${causeLeft.length}, movement rows = ${leftovers.length}, result = ${JSON.stringify(refused)}`,
  );
}
