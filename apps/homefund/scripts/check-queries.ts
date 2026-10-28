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
import { getMonthReview, getMonthReviewPending, markReviewed } from "@/db/queries/month-review";
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
import { getDebtOverview, sumDebtCreditTotals } from "@/db/queries/debt-overview";
import type { DebtOverviewRow, DebtPocket } from "@/db/queries/debt-overview";
import { getCurrentStatement } from "@/db/queries/debt-statements";
import { getDebtTerms, upsertDebtTerms } from "@/db/queries/debt-terms";
import { getDebtsScreenData } from "@/db/queries/debts-screen";
import { listDueReminders } from "@/db/queries/due-reminders";
import type { DebtsScreenData } from "@/db/queries/debts-screen";
import { readExport } from "@/db/queries/export";
import {
  archiveMember,
  createMember,
  listMembers,
  transferLeadership,
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
  updatePlannedPayment,
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
import {
  createRecurringRuleAction,
  pauseRecurringRuleAction,
  resumeRecurringRuleAction,
  updateRecurringRuleAction,
} from "@/app/actions/recurring-rules";
import {
  listPendingAssetSettlements,
  listPendingSettlements,
  recordBilledAmount,
} from "@/db/queries/debt-statements";
import { updateRecurringRule } from "@/db/queries/recurring-rules";
import {
  buildEffectiveRefs,
  processRow,
  type RawRow,
} from "@/lib/spreadsheet/import-pipeline";
import { commitImport } from "@/db/queries/import-commit";
import * as importCommitModule from "@/db/queries/import-commit";
import { commitImportAction } from "@/app/actions/import";
import { ActionError } from "@/lib/errors";
import { buildWorkbook, parseWorkbook } from "@/lib/spreadsheet/workbook";
import type { ReverseSheetLabels } from "@/lib/spreadsheet/workbook";
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
  sheetDescriptors,
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

  // RF-154: signing in joins nobody. What the landing used to run to claim an invitation
  // (`private.claim_group_invite`) is asked here as the person who signs in, and the table is read back
  // as the owner: who runs it IS the input, and what was stored is what counts. Three callers: an
  // invitee, a member who holds an invitation of her own, and an address whose row is archived.
  const invitee = await createMembershipFreeUser();
  const leaderEmail = process.env.HARNESS_USER_EMAIL ?? "";

  await checkWrite(
    "Signing in joins nobody: an invitee, an archived invitation and a member holding one are all left as they were",
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
      await seedPendingInvite({
        groupId: scope.groupId,
        memberId: archivedId,
        actorId: userId,
        name: "Harness invitada archivada",
        email: `harness-${randomUUID()}@example.invalid`,
        archived: true,
      });
      await seedPendingInvite({
        groupId: scope.groupId,
        memberId: leaderInviteId,
        actorId: userId,
        name: "Harness lider invitada",
        email: leaderEmail,
        archived: false,
      });

      const before = await readGroupMembers(scope.groupId);
      const signIn = () =>
        withUserDb((tx) => tx.execute<{ id: string | null }>(sql`select private.claim_group_invite() as id`));
      const [inviteeJoined] = await asUser(invitee, signIn);
      const [leaderJoined] = await signIn();
      const after = await readGroupMembers(scope.groupId);
      const [invitedRow] = await fixtureSql<
        { user_id: string | null; invite_email: string | null; invite_state: string }[]
      >`select user_id, invite_email, invite_state from group_members where id = ${invitedId}`;
      const [{ live }] = await fixtureSql<{ live: string }[]>`
        select count(*)::text as live from group_members where user_id = ${invitee.id}`;

      return {
        inviteeJoined: inviteeJoined?.id ?? null,
        leaderJoined: leaderJoined?.id ?? null,
        invitedRow,
        live: Number(live),
        untouched: JSON.stringify(before) === JSON.stringify(after),
        rows: before.length,
      };
    },
    (result) => ({
      ok:
        result.inviteeJoined === null &&
        result.leaderJoined === null &&
        result.invitedRow.user_id === null &&
        result.invitedRow.invite_email === invitee.email &&
        result.invitedRow.invite_state === "pending" &&
        result.live === 0 &&
        result.untouched,
      detail: `invitee joined = ${result.inviteeJoined}, member holding an invitation joined = ${
        result.leaderJoined
      }; her row: ${JSON.stringify(result.invitedRow)}, memberships of the invitee = ${
        result.live
      }, ${result.rows} group rows unchanged = ${result.untouched}`,
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
  await checkRead("listDueReminders", () => listDueReminders(3));
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

      // Signed: the available credit is the limit plus the balance, so a card in
      // credit lifts it (RF-80) rather than reading its credit as owed.
      return { screen, balanceCents: balances[0]?.balanceCents ?? 0 };
    },
    ({ screen, balanceCents }) => {
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
          screen.totals.availableCreditCents === CREDIT_LIMIT_CENTS + balanceCents,
        detail: `${screen.withTerms.length} debts with terms, limit summed ${screen.totals.creditLimitCents} of ${CREDIT_LIMIT_CENTS}, available ${screen.totals.availableCreditCents} against ${CREDIT_LIMIT_CENTS + balanceCents}; the debt with no limit owes ${unlimited?.owedCents ?? "no row"} and reports a limit of ${unlimited?.creditLimitCents ?? "null"}`,
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
    async () => ({
      screen: await getDebtsScreenData(),
      signedBalances: await getAccountBalances(),
    }),
    ({ screen, signedBalances }) => {
      const { owedCents, monthlyInterestCents, monthlyRatePct } = screen.totals;
      const struck = Math.round(owedCents * monthlyRatePct);
      // The rows' own owed is a magnitude, a credit included; the total clamps a
      // credit to 0, so the comparison sums the clamped settlement figure.
      const signed = new Map(
        signedBalances.map((balance) => [
          `${balance.accountId}:${balance.currency}`,
          balance.balanceCents,
        ]),
      );
      const withTermsOwed = screen.withTerms.reduce(
        (sum, row) =>
          sum +
          Math.max(0, -(signed.get(`${row.accountId}:${row.currency}`) ?? 0)),
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
  await o7m3ReaderPendingSuite(userId, fellow);
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
  await recurringVersionSuite();
  await debtPaymentSuite();
  await resendChangedSuite();
  await withdrawalResendSuite();
  await accountPlannedVersionSuite();
  await learnedRuleSuite();
  await recurringPauseSuite();
  await resendAndMissingSuite();
  await billedBeforeReconciliationSuite();
  await pendingSettlementsOnAssetSuite();
  await invitationActsSuite();
  await loneLeaderAcceptsSuite();
  await loginLessCompanySuite();
  await recurringEndsOnSuite();
  await leaderWhoseMemberLeftSuite();
  await pendingAssetSettlementsScopeSuite();
  await dashboardRosterNamesSuite();
  await importCommitSetSuite();
  await parentCategorySuite();
  await importCommitScopesSuite();
  await debtCreditSideSuite();
  await o5m2SurvivorsSuite();
  await dollarBackupSuite();
  await o6m2DebtsAndSettledSuite();
  await o6m3BackupRestoreSuite();
  await o7m11bSurvivorsSuite();
  await o6m7OpeningRefusalsSuite();
  await detailPocketToBillSuite();
  await o7m3MonthReviewSuite();
}

// A member recorded without a login is someone in the fund: a leader whose fund holds one is not alone, so an
// accept answers otherFund, archives nothing and leaves the fund's member where they are.
async function loginLessCompanySuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const api = await invitationApi();
  const groupIds: string[] = [];
  const openFund = async (label: string) => {
    const leader = await createMembershipFreeUser();
    const { groupId } = await asUser(leader, () =>
      createGroup({ name: `Harness fondo ${label} ${tag}`, leaderName: `Harness lider ${label}`, cashMode: "shared", locale: "es" }),
    );
    track("groups", groupId);
    groupIds.push(groupId);
    return { leader, groupId };
  };

  try {
    const home = await openFund("con sin cuenta");
    const [placeholder] = await fixtureSql<{ id: string }[]>`
      insert into group_members (group_id, name, role) values (${home.groupId}, ${`Harness sin cuenta ${tag}`}, 'member') returning id`;
    const target = await openFund("destino sin cuenta");
    const inviteId = randomUUID();
    await seedPendingInvite({ groupId: target.groupId, memberId: inviteId, actorId: target.leader.id, name: "Harness lider con sin cuenta", email: home.leader.email, archived: false });

    const answer = await tap(() => asUser(home.leader, () => api.acceptInvitation({ memberId: inviteId })));
    const rows = await fixtureSql<{ id: string; role: string; archived_at: string | null; group_id: string }[]>`
      select id, role, archived_at::text as archived_at, group_id from group_members where group_id = ${home.groupId}`;
    const invitation = (await fixtureSql<{ user_id: string | null }[]>`select user_id from group_members where id = ${inviteId}`)[0];
    assert(
      next("A leader whose fund holds a member without a login is not alone: otherFund, nothing archived, the member keeps their fund, the invitation stays pending"),
      answer === "otherFund" &&
        rows.length === 2 &&
        rows.every((row) => row.archived_at === null) &&
        rows.some((row) => row.id === placeholder.id && row.group_id === home.groupId) &&
        invitation?.user_id === null,
      `answer = ${answer}, fund rows = ${JSON.stringify(rows)}`,
    );
  } finally {
    for (const id of groupIds) {
      for (const row of await fixtureSql<{ id: string }[]>`select id from group_members where group_id = ${id}`) track("group_members", row.id);
    }
  }
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

  const [{ stamp: usedStamp }] = await fixtureSql<{ stamp: string }[]>`
    select updated_at::text as stamp from accounts where id = ${used}`;
  const action = await updateAccountAction({
    accountId: used,
    expectedUpdatedAt: usedStamp,
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
  const [{ stamp: ruleStamp }] = await fixtureSql<{ stamp: string }[]>`
    select updated_at::text as stamp from recurring_rules where id = ${recurringRuleId}`;
  const ruleAction = await updateRecurringRuleAction({
    ...rule(booked[0].occurred_at),
    expectedUpdatedAt: ruleStamp,
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
  const foreignRaw = fileMovements.find((r) => r.description === `${prefix} compra en dolares`)!;
  const withoutCounter = run("transactions", { ...foreignRaw, counterAmount: null, counterIsEstimate: null }, 8);
  const foreignObject = foreignRow.object as { currency?: string; counterAmountCents?: number } | null;
  assert(
    next("A foreign purchase on a peso account is refused by the import without its amount in the account's currency, and accepted with it"),
    withoutCounter.errors.some((e) => e.key === "transactions.errors.currencyMismatch" && e.column === "currency") &&
      withoutCounter.object === null &&
      foreignRow.errors.length === 0 &&
      foreignObject?.currency === "USD" &&
      foreignObject?.counterAmountCents === 40_000_000,
    `without the amount [${keys(withoutCounter)}], with it [${keys(foreignRow)}] ${JSON.stringify(foreignObject)}`,
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
  const [{ stamp: ruleStamp }] = await fixtureSql<{ stamp: string }[]>`
    select updated_at::text as stamp from recurring_rules where id = ${ruleId}`;
  const rewritten = await asUser(groupless, () =>
    updateRecurringRuleAction({ id: ruleId, expectedUpdatedAt: ruleStamp, ...rule(scope.categoryId) }),
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
  const [{ stamp: heldStamp }] = await fixtureSql<{ stamp: string }[]>`
    select updated_at::text as stamp from recurring_rules where id = ${heldRule.recurringRuleId}`;
  const fundUpdateRefused = await asUser(groupless, () =>
    updateRecurringRuleAction({
      id: heldRule.recurringRuleId,
      expectedUpdatedAt: heldStamp,
      ...foreignFundRule(foreignFundCategoryId),
    }),
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
    next("minimumPaymentSql: a percentage is of what is owed, rounded to the cent; a balance in credit asks 0"),
    pctOnly.value === "50001" && pctOnOwed.value === "0",
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

  // RF-153, RF-154: the address makes the placeholder pending, not claimed. It keeps its place in the
  // roster and its name; signing in joins nobody; accepting is what makes that same row the person's.
  const api = await invitationApi();
  const stateOf = async (id: string) =>
    (
      await fixtureSql<{ user_id: string | null; invite_email: string | null; invite_state: string; name: string; archived_at: string | null }[]>`
        select user_id, invite_email, invite_state, name, archived_at::text as archived_at from group_members where id = ${id}`
    )[0];
  const pendingBefore = await stateOf(abuela);
  const roster = await asUser(leader, () => listMembers(groupId, { archived: false }));
  const [signedIn] = await asUser(invitee, () =>
    withUserDb((tx) => tx.execute<{ id: string | null }>(sql`select private.claim_group_invite() as id`)),
  );
  const afterSignIn = await stateOf(abuela);
  const accepted = await tap(() => asUser(invitee, () => api.acceptInvitation({ memberId: abuela })));
  const claimedRow = await stateOf(abuela);
  const rowsForUser = await fixtureSql<{ id: string }[]>`select id from group_members where user_id = ${invitee.id}`;
  assert(
    next("A placeholder given an address stays in the roster as pending; signing in joins nobody; accepting makes that same row the person's, under the name the group gave"),
    pendingBefore.invite_state === "pending" &&
      roster.some((member) => member.id === abuela && member.name === "Abuela Rosa" && member.userId === null) &&
      (signedIn?.id ?? null) === null &&
      afterSignIn.user_id === null &&
      afterSignIn.invite_state === "pending" &&
      accepted === "accepted" &&
      claimedRow.user_id === invitee.id &&
      claimedRow.invite_state === "accepted" &&
      claimedRow.invite_email === null &&
      claimedRow.name === "Abuela Rosa" &&
      claimedRow.archived_at === null &&
      rowsForUser.length === 1 &&
      rowsForUser[0].id === abuela,
    `state ${pendingBefore.invite_state}, in roster = ${roster.some((member) => member.id === abuela)}, sign-in joined = ${signedIn?.id ?? null}, after sign-in ${JSON.stringify(afterSignIn)}, accept = ${accepted}, row = ${JSON.stringify(claimedRow)}, rows for the user = ${rowsForUser.map((r) => r.id).join(",")}`,
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
    initialBalanceOn: "2026-01-01",
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

  // Q: an edit that names no stamp is stale (RF-156) and writes nothing
  const stampBeforeBlind = await stamp();
  const blind = await update(id, { amount: "600", splits: [{ categoryId: catA, amount: "600" }] });
  const afterBlind = (await byId(id))[0];
  assert(
    next("An edit that carries no expectedUpdatedAt is refused as stale and writes nothing"),
    isStale(blind) && afterBlind?.amount_cents === "50000" && (await stamp()) === stampBeforeBlind,
    `result = ${JSON.stringify(blind)}, amount = ${afterBlind?.amount_cents}, stamp ${stampBeforeBlind} -> ${await stamp()}`,
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
  // The stand-in delete rides the create's own transaction, so a whole rollback brings the cause back.
  const causeLeft = await byId(causeId);
  assert(
    next("A create whose cause vanished before the write ended rolls back whole: an error, and no movement left behind"),
    leftovers.length === 0 && (refused.serverError !== undefined || refused.data?.ok === false),
    `cause rows = ${causeLeft.length}, movement rows = ${leftovers.length}, result = ${JSON.stringify(refused)}`,
  );
}

// M43: a rule's edit form opened before the 00:15 run is refused after it, so the cursor never rewinds (RF-31).
async function recurringVersionSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const user = await createMembershipFreeUser();
  const { accountId } = await asUser(user, () =>
    createAccount({
      name: `Harness m43 ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: user.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 100_000_000,
      balanceOn: shiftDate(today, -30),
    }),
  );
  track("accounts", accountId);
  const { categoryId } = await asUser(user, () =>
    createCategory({ scope: { ownerUserId: user.id }, name: `Harness m43 ${tag}`, kind: "expense", parentId: null, color: "#0E7490" }),
  );
  track("categories", categoryId);

  type RuleState = { updated_at: string; next_run_on: string; amount_cents: string };
  const makeRule = async (dueIn: number): Promise<string> => {
    const { recurringRuleId } = await asUser(user, () =>
      createRecurringRule({
        fromAccountId: accountId,
        toAccountId: null,
        amountCents: 1_000,
        categoryId,
        description: `m43 ${tag}`,
        frequency: "weekly",
        intervalN: 1,
        dayOfMonth: null,
        nextRunOn: shiftDate(today, dueIn),
        endsOn: null,
      }),
    );
    keep("recurring_rules", recurringRuleId);
    return recurringRuleId;
  };
  const read = async (ruleId: string): Promise<RuleState> =>
    (
      await fixtureSql<RuleState[]>`
        select updated_at::text as updated_at, next_run_on::text as next_run_on, amount_cents::text as amount_cents
        from recurring_rules where id = ${ruleId}`
    )[0];
  const run = () => fixtureSql`select private.run_due_recurring_rules(${user.id}::uuid)`;
  const booked = async (ruleId: string): Promise<number> => {
    const rows = await fixtureSql<{ id: string }[]>`select id from transactions where recurring_rule_id = ${ruleId}`;
    for (const r of rows) keep("transactions", r.id);
    return rows.length;
  };
  // The form seeds every field from the rule it loaded, the next run included.
  const save = (ruleId: string, loaded: RuleState, over: Record<string, unknown> = {}) =>
    asUser(user, () =>
      updateRecurringRuleAction({
        id: ruleId,
        fromAccountId: accountId,
        toAccountId: null,
        amount: "20",
        categoryId,
        description: `m43 ${tag}`,
        frequency: "weekly",
        intervalN: 1,
        dayOfMonth: null,
        nextRunOn: loaded.next_run_on,
        endsOn: null,
        expectedUpdatedAt: loaded.updated_at,
        ...over,
      } as Parameters<typeof updateRecurringRuleAction>[0]),
    ) as Promise<{ serverError?: string; data?: { ok?: boolean; reason?: string } } | undefined>;
  const isStale = (r: Awaited<ReturnType<typeof save>>) =>
    r?.serverError === "errors.stale" || (r?.data?.ok === false && r.data.reason === "stale");

  // Q: the form is open, the run lands, the person saves
  const runRule = await makeRule(-7);
  const loaded = await read(runRule);
  await run();
  const afterRun = await read(runRule);
  const bookedByRun = await booked(runRule);
  const refused = await save(runRule, loaded);
  const afterRefused = await read(runRule);
  assert(
    next("A save carrying the updated_at loaded before the run is refused stale and leaves the run's next_run_on and amount"),
    afterRun.updated_at !== loaded.updated_at &&
      isStale(refused) &&
      afterRefused.next_run_on === afterRun.next_run_on &&
      afterRefused.next_run_on !== loaded.next_run_on &&
      afterRefused.amount_cents === "1000",
    `loaded ${loaded.updated_at}, run ${afterRun.updated_at}, result = ${JSON.stringify(refused)}, next_run_on ${loaded.next_run_on} -> ${afterRefused.next_run_on}, amount ${afterRefused.amount_cents}`,
  );

  // Q: the same stale form, but its date sits ahead of the run's, so no booked-period guard can catch it
  const skipForm = await save(runRule, loaded, { nextRunOn: shiftDate(today, 21) });
  const afterSkip = await read(runRule);
  assert(
    next("A stale save is refused by its version even when the date it carries is ahead of the run's"),
    isStale(skipForm) && afterSkip.next_run_on === afterRun.next_run_on && afterSkip.amount_cents === "1000",
    `result = ${JSON.stringify(skipForm)}, next_run_on ${afterRun.next_run_on} -> ${afterSkip.next_run_on}`,
  );

  // Q: the refusal opens no second booking
  await run();
  const bookedAgain = await booked(runRule);
  assert(
    next("After the refused save the next run books nothing for the same period"),
    bookedByRun >= 1 && bookedAgain === bookedByRun,
    `${bookedByRun} booked by the first run, ${bookedAgain} after the second`,
  );

  // Q: no run in between
  const quietRule = await makeRule(7);
  const quietLoaded = await read(quietRule);
  const saved = await save(quietRule, quietLoaded);
  const afterSaved = await read(quietRule);
  assert(
    next("A save carrying the rule's own updated_at::text is accepted, changes the amount and moves the stamp"),
    saved?.serverError === undefined &&
      !isStale(saved) &&
      afterSaved.amount_cents === "2000" &&
      afterSaved.updated_at !== quietLoaded.updated_at,
    `result = ${JSON.stringify(saved)}, amount = ${afterSaved.amount_cents}, stamp ${quietLoaded.updated_at} -> ${afterSaved.updated_at}`,
  );
}

// M44: two payments of one card never share an installment line, and a resent payment books once.
async function debtPaymentSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const LINE = 100_000;
  const user = await createMembershipFreeUser();
  const open = async (kind: "asset" | "liability", name: string) => {
    const { accountId } = await asUser(user, () =>
      createAccount({
        name: `Harness m44 ${name} ${tag}`,
        kind,
        subtype: kind === "asset" ? "bank" : "card",
        ownerUserId: user.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor: kind === "asset" ? 1_000_000_000 : 1_000_000,
        balanceOn: shiftDate(today, -30),
      }),
    );
    track("accounts", accountId);
    return accountId;
  };
  const bank = await open("asset", "bank");

  // A card owing two lines of one payment each, the older line due first.
  const newCard = async (name: string): Promise<{ cardId: string; l1: string; l2: string; planId: string }> => {
    const cardId = await open("liability", name);
    const { planId } = await asUser(user, () =>
      createInstallmentPlan({
        accountId: cardId,
        description: `m44 ${name} ${tag}`,
        principalCents: LINE * 2,
        nInstallments: 2,
        frequency: "monthly",
        interestRate: null,
        downPaymentCents: null,
        avalCents: null,
        startDate: shiftDate(today, -30),
        merchant: null,
        lines: [
          { seq: 1, dueDate: shiftDate(today, -30), amountCents: LINE },
          { seq: 2, dueDate: shiftDate(today, -1), amountCents: LINE },
        ],
      }),
    );
    keep("installment_plans", planId);
    const lines = await fixtureSql<{ id: string }[]>`
      select id from installment_lines where plan_id = ${planId} order by seq`;
    return { cardId, planId, l1: lines[0].id, l2: lines[1].id };
  };
  type Answer = {
    serverError?: string;
    data?: { transactionId: string; paidLineIds: string[]; remainderCents: number };
  };
  const pay = (cardId: string, over: Record<string, unknown> = {}) =>
    asUser(user, () =>
      recordDebtPaymentAction({
        fromAccountId: bank,
        toAccountId: cardId,
        amount: "1000",
        occurredAt: today,
        ...over,
      } as Parameters<typeof recordDebtPaymentAction>[0]),
    ) as Promise<Answer | undefined>;
  const links = (planId: string) =>
    fixtureSql<{ id: string; paid: string | null }[]>`
      select id, paid_transaction_id as paid from installment_lines where plan_id = ${planId} order by seq`;
  const movements = async (cardId: string) => {
    const rows = await fixtureSql<{ id: string; external_ref: string | null; amount_cents: string }[]>`
      select id, external_ref, amount_cents::text from transactions where to_account_id = ${cardId}`;
    for (const r of rows) track("transactions", r.id);
    return rows;
  };

  // Q: two payments at once, repeated so a lucky ordering cannot hide the overlap
  let worst = "";
  let allRight = true;
  let answersTrue = true;
  let answerDetail = "";
  for (let round = 0; round < 5; round++) {
    const card = await newCard(`race${round}`);
    const [a, b] = await Promise.all([pay(card.cardId), pay(card.cardId)]);
    const rows = await movements(card.cardId);
    const stored = await links(card.planId);
    const linked = stored.map((l) => l.paid);
    const ids = rows.map((r) => r.id);
    const right =
      rows.length === 2 &&
      linked.every((p) => p !== null && ids.includes(p)) &&
      new Set(linked).size === 2;
    if (!right) {
      allRight = false;
      worst ||= `round ${round}: ${rows.length} movement(s), links ${JSON.stringify(linked)}, ids ${JSON.stringify(ids)}`;
    }
    for (const answer of [a, b]) {
      const mine = stored.filter((l) => l.paid === answer?.data?.transactionId).map((l) => l.id).sort();
      const said = [...(answer?.data?.paidLineIds ?? [])].sort();
      if (answer?.data === undefined || JSON.stringify(mine) !== JSON.stringify(said)) {
        answersTrue = false;
        answerDetail ||= `round ${round}: said ${JSON.stringify(said)}, stored ${JSON.stringify(mine)}, answer ${JSON.stringify(answer)}`;
      }
    }
  }
  assert(
    next("Two payments of one card at once book two movements, and lines L1 and L2 each link to a different one"),
    allRight,
    worst || "5 rounds clean",
  );

  // Q: the answer matches the stored links
  assert(
    next("Each concurrent payment's paidLineIds names exactly the lines stored against its own movement"),
    answersTrue,
    answerDetail || "5 rounds clean",
  );

  // Q: the lock is taken on the card, as the first thing the payment does
  const held = await newCard("lock");
  const lockKey = held.cardId;
  let settled = false;
  let settledWhileHeld = false;
  let blocked: Promise<Answer | undefined> | undefined;
  await fixtureSql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${lockKey}::text, 0))`;
    blocked = pay(held.cardId);
    blocked.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 1500));
    // Read before the commit releases the lock; after it the payment settles by design.
    settledWhileHeld = settled;
  });
  const afterRelease = await blocked;
  const heldLinks = await links(held.planId);
  await movements(held.cardId);
  assert(
    next("A payment of a card waits on the advisory lock keyed by the card id, then books once it is released"),
    !settledWhileHeld &&
      afterRelease?.data?.paidLineIds.length === 1 &&
      heldLinks[0].paid === afterRelease.data.transactionId,
    `settled while held = ${settledWhileHeld}, answer = ${JSON.stringify(afterRelease)}`,
  );

  // Q: one request sent twice
  const resend = await newCard("resend");
  const ref = randomUUID();
  const first = await pay(resend.cardId, { requestRef: ref });
  const second = await pay(resend.cardId, { requestRef: ref });
  const sent = await movements(resend.cardId);
  const sentLinks = await links(resend.planId);
  assert(
    next("A payment sent twice with the same requestRef books one movement under form:<ref>, and both answers name it"),
    sent.length === 1 &&
      sent[0].external_ref === `form:${ref}` &&
      first?.data?.transactionId === sent[0].id &&
      second?.data?.transactionId === sent[0].id &&
      sentLinks[0].paid === sent[0].id &&
      sentLinks[1].paid === null,
    `${sent.length} movement(s), refs ${JSON.stringify(sent.map((r) => r.external_ref))}, links ${JSON.stringify(sentLinks.map((l) => l.paid))}, first = ${JSON.stringify(first)}, second = ${JSON.stringify(second)}`,
  );

  // Q: two requests, two payments
  const apart = await newCard("apart");
  const x = await pay(apart.cardId, { requestRef: randomUUID() });
  const y = await pay(apart.cardId, { requestRef: randomUUID() });
  const both = await movements(apart.cardId);
  const apartLinks = await links(apart.planId);
  assert(
    next("Two payments with different requestRefs book two movements, each closing its own line"),
    both.length === 2 &&
      x?.data?.transactionId !== y?.data?.transactionId &&
      apartLinks[0].paid === x?.data?.transactionId &&
      apartLinks[1].paid === y?.data?.transactionId,
    `${both.length} movement(s), links ${JSON.stringify(apartLinks.map((l) => l.paid))}, x = ${JSON.stringify(x)}, y = ${JSON.stringify(y)}`,
  );

  // Q: the sequential allocation stays oldest first and its answer is true
  const seq = await newCard("seq");
  const both2 = await pay(seq.cardId, { amount: "2000" });
  const seqLinks = await links(seq.planId);
  await movements(seq.cardId);
  assert(
    next("One payment covering two lines links both to its movement and reports both"),
    both2?.data !== undefined &&
      seqLinks.every((l) => l.paid === both2.data?.transactionId) &&
      [...both2.data.paidLineIds].sort().join() === [seq.l1, seq.l2].sort().join(),
    `answer = ${JSON.stringify(both2)}, links ${JSON.stringify(seqLinks.map((l) => l.paid))}`,
  );

  // M53: a card in credit owes nothing; it never adds to what the screen says is owed.
  const holder = await createMembershipFreeUser();
  const OWED = 50_000;
  const OVERPAID = 50_000;
  const USD_CREDIT = 3_000;
  const openFor = async (
    kind: "asset" | "liability",
    name: string,
    currency: "COP" | "USD",
    amountMinor: number,
  ) => {
    const { accountId } = await asUser(holder, () =>
      createAccount({
        name: `Harness m53 ${name} ${tag}`,
        kind,
        subtype: kind === "asset" ? "bank" : "card",
        ownerUserId: holder.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: currency,
        amountMinor,
        balanceOn: shiftDate(today, -30),
      }),
    );
    track("accounts", accountId);
    return accountId;
  };
  const transfer = async (fromAccountId: string, toAccountId: string, amountCents: number) => {
    const { transactionId } = await asUser(holder, () =>
      createTransaction({
        fromAccountId,
        toAccountId,
        amountCents,
        occurredAt: today,
        description: `m53 ${tag}`,
        externalRef: null,
        splits: [],
        labelIds: [],
      }),
    );
    track("transactions", transactionId);
  };
  // A refund in dollars on a card that bills in pesos lands in the card's dollar pocket,
  // as an estimate until the statement says what it settled for.
  const refundInDollars = async (toAccountId: string, amountCents: number) => {
    const { categoryId } = await asUser(holder, () =>
      createCategory({
        scope: { ownerUserId: holder.id },
        name: `Harness m53 refund ${tag}`,
        kind: "income",
        parentId: null,
        color: "#B4542F",
      }),
    );
    keep("categories", categoryId);
    const { transactionId } = await asUser(holder, () =>
      createTransaction({
        fromAccountId: null,
        toAccountId,
        amountCents,
        currency: "USD",
        counterAmountCents: amountCents * 4_000,
        counterIsEstimate: true,
        occurredAt: today,
        description: `m53 refund ${tag}`,
        externalRef: null,
        splits: [{ categoryId, amountCents }],
        labelIds: [],
      }),
    );
    track("transactions", transactionId);
  };
  const screenOf = () => asUser(holder, () => getDebtsScreenData());
  const owedOf = (screen: DebtsScreenData, accountId: string) =>
    screen.withoutTerms.find((debt) => debt.accountId === accountId);
  const setOf = (screen: DebtsScreenData, currency: string) =>
    screen.totals.byCurrency.find((set) => set.currency === currency);

  const copBank = await openFor("asset", "bank", "COP", 1_000_000_000);
  const owing = await openFor("liability", "owing", "COP", OWED);
  const credit = await openFor("liability", "credit", "COP", 0);
  const mixed = await openFor("liability", "mixed", "COP", 0);

  const beforeCredit = await screenOf();
  await transfer(copBank, credit, OVERPAID);
  await refundInDollars(mixed, USD_CREDIT);
  const afterCredit = await screenOf();

  assert(
    next("A card overpaid by 50000 owes 0, and the peso total is what it was before the overpayment"),
    owedOf(afterCredit, credit)?.owedCents === 0 &&
      setOf(afterCredit, "COP")?.owedCents === setOf(beforeCredit, "COP")?.owedCents &&
      setOf(afterCredit, "COP")?.owedCents === OWED &&
      afterCredit.totals.owedCents === OWED,
    `credit card owes ${owedOf(afterCredit, credit)?.owedCents}, peso set ${setOf(beforeCredit, "COP")?.owedCents} before and ${setOf(afterCredit, "COP")?.owedCents} after, flat ${afterCredit.totals.owedCents}, expected ${OWED}`,
  );

  assert(
    next("A card owing 50000 owes 50000 beside a card in credit"),
    owedOf(afterCredit, owing)?.owedCents === OWED,
    `owing card owes ${owedOf(afterCredit, owing)?.owedCents}, expected ${OWED}`,
  );

  const usdPocket = owedOf(afterCredit, mixed)?.otherOwed.find((pocket) => pocket.currency === "USD");
  assert(
    next("A dollar pocket in credit on a peso card owes 0 and adds nothing to the dollar total"),
    usdPocket?.owedCents === 0 && (setOf(afterCredit, "USD")?.owedCents ?? 0) === 0,
    `dollar pocket owes ${usdPocket?.owedCents ?? "no pocket"}, dollar set owes ${setOf(afterCredit, "USD")?.owedCents ?? "no set"}`,
  );

  // The same relation from the other side: a debt in dollars is still counted in full.
  const usdCard = await openFor("liability", "usd card", "USD", 4_000);
  const withUsdDebt = await screenOf();
  assert(
    next("A dollar card owing 4000 adds 4000 to the dollar total while the pocket in credit adds 0"),
    owedOf(withUsdDebt, usdCard)?.owedCents === 4_000 && setOf(withUsdDebt, "USD")?.owedCents === 4_000,
    `dollar card owes ${owedOf(withUsdDebt, usdCard)?.owedCents}, dollar set owes ${setOf(withUsdDebt, "USD")?.owedCents}, expected 4000`,
  );
}

// M74: a form ref resent with other figures is refused, never answered ok (RF-158).
async function resendChangedSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const actions = (await import("@/app/actions/transactions")) as unknown as {
    createTransactionAction: (input: Record<string, unknown>) => Promise<MovementResult>;
  };
  const user = await createMembershipFreeUser();
  const mkAccount = async (name: string): Promise<string> => {
    const { accountId } = await asUser(user, () =>
      createAccount({
        name: `${name} ${tag}`,
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
    return accountId;
  };
  const accountA = await mkAccount("Harness m74 A");
  const accountB = await mkAccount("Harness m74 B");
  const { categoryId } = await asUser(user, () =>
    createCategory({ scope: { ownerUserId: user.id }, name: `Harness m74 ${tag}`, kind: "expense", parentId: null, color: "#0E7490" }),
  );
  track("categories", categoryId);

  const send = (ref: string, over: Record<string, unknown> = {}) =>
    asUser(user, () =>
      actions.createTransactionAction({
        requestRef: ref,
        fromAccountId: accountA,
        toAccountId: null,
        amount: "100",
        occurredAt: today,
        description: `m74 ${tag}`,
        splits: [{ categoryId, amount: String(over.amount ?? "100") }],
        labelIds: [],
        ...over,
      }),
    );
  type Row = { id: string; amount_cents: string; from_account_id: string | null; occurred_at: string };
  const rowsOf = async (ref: string) => {
    const rows = await fixtureSql<Row[]>`
      select id, amount_cents::text, from_account_id, occurred_at::text from transactions
      where owner_user_id = ${user.id} and external_ref = ${`form:${ref}`}`;
    rows.forEach((r) => track("transactions", r.id));
    return rows;
  };
  const refused = (r: MovementResult) =>
    r.serverError === "errors.resendChanged" || (r.data?.ok === false && r.data.reason === "resendChanged");

  // Q: the same figures
  const same = randomUUID();
  const s1 = await send(same);
  const s2 = await send(same);
  const sameRows = await rowsOf(same);
  assert(
    next("A resend of a form ref with the same amount, account and date answers ok with the existing id and books one row"),
    sameRows.length === 1 && s1.data?.ok === true && s2.data?.ok === true &&
      s2.data.transactionId === sameRows[0].id && s1.data.transactionId === sameRows[0].id,
    `${sameRows.length} row(s), first = ${JSON.stringify(s1)}, second = ${JSON.stringify(s2)}`,
  );

  // Q: another amount
  const amt = randomUUID();
  await send(amt);
  const a2 = await send(amt, { amount: "250" });
  const amtRows = await rowsOf(amt);
  assert(
    next("A resend of a form ref with another amount is refused resendChanged, books nothing and keeps the first amount"),
    refused(a2) && amtRows.length === 1 && amtRows[0].amount_cents === "10000" && a2.data?.ok !== true,
    `result = ${JSON.stringify(a2)}, rows = ${JSON.stringify(amtRows)}`,
  );

  // Q: another account
  const acc = randomUUID();
  await send(acc);
  const c2 = await send(acc, { fromAccountId: accountB });
  const accRows = await rowsOf(acc);
  assert(
    next("A resend of a form ref with the same amount but another account is refused resendChanged and keeps the first account"),
    refused(c2) && accRows.length === 1 && accRows[0].from_account_id === accountA,
    `result = ${JSON.stringify(c2)}, rows = ${JSON.stringify(accRows)}`,
  );

  // Q: another date
  const day = randomUUID();
  await send(day);
  const d2 = await send(day, { occurredAt: shiftDate(today, -1) });
  const dayRows = await rowsOf(day);
  assert(
    next("A resend of a form ref with the same amount but another date is refused resendChanged and keeps the first date"),
    refused(d2) && dayRows.length === 1 && dayRows[0].occurred_at.startsWith(today),
    `result = ${JSON.stringify(d2)}, rows = ${JSON.stringify(dayRows)}`,
  );
}

// M45: a withdrawal sent twice books once, and the cash it created is created once (RF-68, RF-158).
async function withdrawalResendSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const { withdrawCashAction } = (await import("@/app/actions/cash")) as unknown as {
    withdrawCashAction: (input: Record<string, unknown>) => Promise<{
      serverError?: string;
      validationErrors?: unknown;
      data?: { transactionId: string; targetCashAccountId: string; createdCashAccount: boolean };
    } | undefined>;
  };
  const user = await createMembershipFreeUser();
  const { accountId: bank } = await asUser(user, () =>
    createAccount({
      name: `Harness m45 bank ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: user.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 1_000_000_000,
      balanceOn: shiftDate(today, -10),
    }),
  );
  track("accounts", bank);
  const withdraw = (over: Record<string, unknown> = {}) =>
    asUser(user, () => withdrawCashAction({ sourceAccountId: bank, amount: "100", ...over }));
  const transfers = async () => {
    const rows = await fixtureSql<{ id: string; external_ref: string | null; amount_cents: string; to_account_id: string }[]>`
      select id, external_ref, amount_cents::text, to_account_id from transactions where from_account_id = ${bank}`;
    for (const r of rows) track("transactions", r.id);
    return rows;
  };
  const cashAccounts = async () => {
    const rows = await fixtureSql<{ id: string }[]>`
      select id from accounts where owner_user_id = ${user.id} and subtype = 'cash'`;
    for (const r of rows) track("accounts", r.id);
    return rows;
  };

  // Q: the very first withdrawal, which creates the cash, sent twice
  const firstRef = randomUUID();
  const c1 = await withdraw({ requestRef: firstRef });
  const c2 = await withdraw({ requestRef: firstRef });
  const cashAfter = await cashAccounts();
  const movedAfter = await transfers();
  assert(
    next("A first withdrawal sent twice with one requestRef creates one cash account and books one transfer, both answers naming it"),
    cashAfter.length === 1 &&
      movedAfter.length === 1 &&
      movedAfter[0].external_ref === `form:${firstRef}` &&
      movedAfter[0].to_account_id === cashAfter[0].id &&
      c1?.data?.transactionId === movedAfter[0].id &&
      c2?.data?.transactionId === movedAfter[0].id &&
      c2?.data?.targetCashAccountId === cashAfter[0].id,
    `${cashAfter.length} cash account(s), ${movedAfter.length} transfer(s), first = ${JSON.stringify(c1)}, second = ${JSON.stringify(c2)}`,
  );

  // Q: the cash exists now; the same request sent twice
  const ref = randomUUID();
  const r1 = await withdraw({ requestRef: ref });
  const r2 = await withdraw({ requestRef: ref });
  const sent = (await transfers()).filter((r) => r.external_ref === `form:${ref}`);
  assert(
    next("A withdrawal sent twice with the same requestRef books one transfer under form:<ref> and both answers name it"),
    sent.length === 1 &&
      sent[0].amount_cents === "10000" &&
      r1?.data?.transactionId === sent[0].id &&
      r2?.data?.transactionId === sent[0].id &&
      (await cashAccounts()).length === 1,
    `${sent.length} transfer(s), first = ${JSON.stringify(r1)}, second = ${JSON.stringify(r2)}`,
  );

  // Q: two requests with the same figures
  const refA = randomUUID();
  const refB = randomUUID();
  const a = await withdraw({ requestRef: refA });
  const b = await withdraw({ requestRef: refB });
  const apart = (await transfers()).filter((r) => r.external_ref === `form:${refA}` || r.external_ref === `form:${refB}`);
  assert(
    next("Two withdrawals with different requestRefs and the same amount book two transfers, each answered with its own id"),
    apart.length === 2 &&
      a?.data?.transactionId !== b?.data?.transactionId &&
      apart.some((r) => r.id === a?.data?.transactionId) &&
      apart.some((r) => r.id === b?.data?.transactionId),
    `${apart.length} transfer(s), a = ${JSON.stringify(a)}, b = ${JSON.stringify(b)}`,
  );

  // Q: no requestRef, nothing deduplicates
  const priorIds = new Set((await transfers()).map((r) => r.id));
  const before = priorIds.size;
  await withdraw();
  await withdraw();
  const bare = await transfers();
  assert(
    next("Two withdrawals with no requestRef book two transfers, neither under a form: key"),
    bare.length === before + 2 && bare.filter((r) => !priorIds.has(r.id)).every((r) => !r.external_ref?.startsWith("form:")),
    `${before} -> ${bare.length} transfer(s), refs ${JSON.stringify(bare.map((r) => r.external_ref))}`,
  );

  // Q: the same request resent with another amount
  const changedRef = randomUUID();
  const k1 = await withdraw({ requestRef: changedRef, amount: "100" });
  const k2 = await withdraw({ requestRef: changedRef, amount: "250" });
  const kept = (await transfers()).filter((r) => r.external_ref === `form:${changedRef}`);
  assert(
    next("A resent requestRef with another amount answers resendChanged and leaves the one transfer at the first amount"),
    k1?.data?.transactionId !== undefined &&
      kept.length === 1 &&
      kept[0].amount_cents === "10000" &&
      JSON.stringify(k2).includes("resendChanged") &&
      k2?.data?.transactionId === undefined,
    `${kept.length} transfer(s) at ${kept[0]?.amount_cents}, second = ${JSON.stringify(k2)}`,
  );

  // Q: the cash archived between the send and the resend must not be replaced by a new one
  const lateRef = randomUUID();
  const l1 = await withdraw({ requestRef: lateRef });
  const cashBefore = (await cashAccounts()).length;
  await fixtureSql`update accounts set archived_at = now() where owner_user_id = ${user.id} and subtype = 'cash'`;
  const l2 = await withdraw({ requestRef: lateRef });
  const lateRows = (await transfers()).filter((r) => r.external_ref === `form:${lateRef}`);
  assert(
    next("A resend after the cash was archived answers the booked transfer and creates no new cash account"),
    lateRows.length === 1 &&
      l1?.data?.transactionId === lateRows[0].id &&
      l2?.data?.transactionId === lateRows[0].id &&
      (await cashAccounts()).length === cashBefore,
    `${lateRows.length} transfer(s), ${cashBefore} -> ${(await cashAccounts()).length} cash account(s), second = ${JSON.stringify(l2)}`,
  );
}

type StaleAnswer = { serverError?: string; validationErrors?: unknown; data?: { ok?: boolean; reason?: string } } | undefined;

// M46: an account or a planned payment opened before another save is refused on save, and nothing moves (RF-156).
async function accountPlannedVersionSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const accountActions = (await import("@/app/actions/accounts")) as unknown as {
    updateAccountAction: (input: Record<string, unknown>) => Promise<StaleAnswer>;
  };
  const plannedActions = (await import("@/app/actions/planned-payments")) as unknown as {
    updatePlannedPaymentAction: (input: Record<string, unknown>) => Promise<StaleAnswer>;
  };
  const user = await createMembershipFreeUser();
  const { accountId } = await asUser(user, () =>
    createAccount({
      name: `Harness m46 ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: user.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 100_000,
      balanceOn: shiftDate(today, -10),
    }),
  );
  track("accounts", accountId);
  const { plannedPaymentId } = await asUser(user, () =>
    createPlannedPayment({
      fromAccountId: accountId,
      toAccountId: null,
      amountCents: 10_000,
      categoryId: null,
      dueDate: shiftDate(today, 5),
      remindOn: null,
      description: `m46 ${tag}`,
    }),
  );
  track("planned_payments", plannedPaymentId);

  const isStale = (r: StaleAnswer) =>
    r?.serverError === "errors.stale" || (r?.data?.ok === false && r.data.reason === "stale");
  const accountStamp = async () =>
    (await fixtureSql<{ t: string }[]>`select updated_at::text as t from accounts where id = ${accountId}`)[0]?.t ?? "";
  const plannedStamp = async () =>
    (await fixtureSql<{ t: string }[]>`select updated_at::text as t from planned_payments where id = ${plannedPaymentId}`)[0]?.t ?? "";
  const opening = async () =>
    (await fixtureSql<{ c: string }[]>`select initial_balance_cents::text as c from accounts where id = ${accountId}`)[0]?.c;
  const plannedAmount = async () =>
    (await fixtureSql<{ c: string }[]>`select amount_cents::text as c from planned_payments where id = ${plannedPaymentId}`)[0]?.c;
  // Another person's save: a raw update would lose the session the scope trigger reads.
  const touchPlanned = (description: string) =>
    asUser(user, () =>
      updatePlannedPayment({
        plannedPaymentId,
        fromAccountId: accountId,
        toAccountId: null,
        amountCents: 10_000,
        categoryId: null,
        dueDate: shiftDate(today, 5),
        remindOn: null,
        description,
      }),
    );
  // The comparison must be able to fail on a dropped microsecond, so the stamp is touched until it has some.
  const hasMicros = (t: string) => /\.\d{6}/.test(t) && !t.replace(/[+-]\d+$/, "").endsWith("000");
  for (let i = 0; i < 10 && !hasMicros(await accountStamp()); i++) {
    await fixtureSql`update accounts set name = name where id = ${accountId}`;
  }
  for (let i = 0; i < 10 && !hasMicros(await plannedStamp()); i++) {
    await touchPlanned(`m46 ${tag}`);
  }

  const saveAccount = (amount: string, expectedUpdatedAt?: string) =>
    asUser(user, () =>
      accountActions.updateAccountAction({
        accountId,
        name: `Harness m46 ${tag}`,
        kind: "asset",
        subtype: "bank",
        isShared: false,
        institution: "",
        lastFour: "",
        settlementCurrency: "COP",
        amount,
        balanceOn: shiftDate(today, -10),
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      }),
    );
  const savePlanned = (amount: string, expectedUpdatedAt?: string) =>
    asUser(user, () =>
      plannedActions.updatePlannedPaymentAction({
        plannedPaymentId,
        fromAccountId: accountId,
        toAccountId: null,
        amount,
        categoryId: null,
        dueDate: shiftDate(today, 5),
        remindOn: null,
        description: `m46 ${tag}`,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
      }),
    );

  // Q: the account form is open, someone else saves, the opening balance is saved
  const openedAccount = await accountStamp();
  assert(next("The account's updated_at::text carries microseconds the test can compare"), hasMicros(openedAccount), openedAccount);
  const before = await opening();
  await fixtureSql`update accounts set name = ${`Harness m46 ${tag} elsewhere`} where id = ${accountId}`;
  const movedAccount = await accountStamp();
  const staleAccount = await saveAccount("777", openedAccount);
  assert(
    next("An account saved with a stamp older than the row is refused as stale and leaves the opening balance as it was"),
    movedAccount !== openedAccount && isStale(staleAccount) && (await opening()) === before,
    `result = ${JSON.stringify(staleAccount)}, opening ${before} -> ${await opening()}, stamp ${openedAccount} -> ${movedAccount}`,
  );

  // Q: the account form carrying the row's own stamp
  const freshAccount = await saveAccount("123", await accountStamp());
  assert(
    next("An account saved with the row's own updated_at::text, microseconds and all, is updated"),
    freshAccount?.serverError === undefined && !isStale(freshAccount) && (await opening()) === "12300",
    `result = ${JSON.stringify(freshAccount)}, opening = ${await opening()}`,
  );

  // Q: an account save naming no stamp is stale (RF-156) and writes nothing
  const blindAccount = await saveAccount("456");
  assert(
    next("An account saved with no expectedUpdatedAt is refused as stale and leaves the opening balance as it was"),
    isStale(blindAccount) && (await opening()) === "12300",
    `result = ${JSON.stringify(blindAccount)}, opening = ${await opening()}`,
  );

  // Q: the planned payment form is open, someone else saves, the amount is saved
  for (let i = 0; i < 10 && !hasMicros(await plannedStamp()); i++) {
    await touchPlanned(`m46 ${tag}`);
  }
  const openedPlanned = await plannedStamp();
  assert(next("The planned payment's updated_at::text carries microseconds the test can compare"), hasMicros(openedPlanned), openedPlanned);
  const plannedBefore = await plannedAmount();
  await touchPlanned(`m46 ${tag} elsewhere`);
  const movedPlanned = await plannedStamp();
  const stalePlanned = await savePlanned("77", openedPlanned);
  assert(
    next("A planned payment saved with a stamp older than the row is refused as stale and leaves the amount as it was"),
    movedPlanned !== openedPlanned && isStale(stalePlanned) && (await plannedAmount()) === plannedBefore,
    `result = ${JSON.stringify(stalePlanned)}, amount ${plannedBefore} -> ${await plannedAmount()}, stamp ${openedPlanned} -> ${movedPlanned}`,
  );

  // Q: the planned payment form carrying the row's own stamp
  for (let i = 0; i < 10 && !hasMicros(await plannedStamp()); i++) {
    await touchPlanned(`m46 ${tag}`);
  }
  const freshStamp = await plannedStamp();
  const freshPlanned = await savePlanned("55", freshStamp);
  assert(
    next("A planned payment saved with the row's own updated_at::text, microseconds and all, is updated"),
    hasMicros(freshStamp) && freshPlanned?.serverError === undefined && !isStale(freshPlanned) && (await plannedAmount()) === "5500",
    `result = ${JSON.stringify(freshPlanned)}, amount = ${await plannedAmount()}, stamp ${freshStamp}`,
  );

  // Q: a planned payment save naming no stamp is stale (RF-156) and writes nothing
  const blindPlanned = await savePlanned("66");
  assert(
    next("A planned payment saved with no expectedUpdatedAt is refused as stale and leaves the amount as it was"),
    isStale(blindPlanned) && (await plannedAmount()) === "5500",
    `result = ${JSON.stringify(blindPlanned)}, amount = ${await plannedAmount()}`,
  );
}

// M52: deleting the account or category a learned rule trusts keeps the rule and forgets the target (Q8 a).
async function learnedRuleSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const { deleteAccount } = await import("@/db/queries/accounts");
  const { deleteCategory } = await import("@/db/queries/categories");
  const { recordIngestDelivery } = await import("@/db/queries/webhook-ingest");
  const { fingerprintMessage } = await import("@/lib/ingest/fingerprint");
  const { counterpartyPatternKey } = await import("@/lib/ingest/counterparty-pattern");
  const user = await createMembershipFreeUser();

  const mkAccount = async (name: string): Promise<string> => {
    const { accountId } = await asUser(user, () =>
      createAccount({
        name: `Harness m52 ${name} ${tag}`,
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
    return accountId;
  };
  const mkCategory = async (name: string): Promise<string> => {
    const { categoryId } = await asUser(user, () =>
      createCategory({ scope: { ownerUserId: user.id }, name: `Harness m52 ${name} ${tag}`, kind: "expense", parentId: null, color: "#0E7490" }),
    );
    track("categories", categoryId);
    return categoryId;
  };
  const origin = await mkAccount("origin");
  const spendCategory = await mkCategory("spend");

  const code = async (fn: (tx: Parameters<Parameters<typeof asOwner>[1]>[0]) => Promise<unknown>): Promise<string> => {
    try {
      await asOwner(user.id, async (tx) => {
        await fn(tx);
      });
      return "ok";
    } catch (error) {
      return pgErrorCode(error) ?? rootMessage(error);
    }
  };

  // ----- merchants -----
  const credentialId = randomUUID();
  await asOwner(user.id, async (tx) => {
    await tx`
      insert into webhook_credentials (id, owner_user_id, name, token_hash)
      values (${credentialId}, ${user.id}, 'Harness m52', ${createHash("sha256").update(`m52-${tag}`).digest("hex")})`;
  });
  track("webhook_credentials", credentialId);

  const smsFor = (shop: string) =>
    `Bancolombia: Compraste COP11.000,00 en ${shop} con tu T.Cred *4872, el 25/08/2026 a las 20:07.`;
  const merchantKeyOf = (shop: string) => fingerprintMessage(smsFor(shop)).merchant?.key ?? "";
  type MerchantRow = { state: string; streak: number; candidate: string | null; trusted: string | null };
  const merchantRow = async (shop: string): Promise<MerchantRow | undefined> =>
    (await fixtureSql<MerchantRow[]>`
      select state, streak::int as streak, candidate_category_id as candidate, trusted_category_id as trusted
      from ingest_merchants where owner_user_id = ${user.id} and merchant_key = ${merchantKeyOf(shop)}`)[0];
  const teachMerchant = (shop: string, category: string) =>
    asOwner(user.id, async (tx) => {
      await tx`select private.remember_ingest_merchant(${merchantKeyOf(shop)}, ${shop}, ${category})`;
    });
  const trustMerchant = async (shop: string, category: string) => {
    await teachMerchant(shop, category);
    await teachMerchant(shop, category);
  };
  const deliver = async (shop: string) => {
    const result = await recordIngestDelivery({
      ownerUserId: user.id,
      credentialId,
      defaultAccountId: null,
      defaultCategoryId: null,
      payload: { text: `${smsFor(shop)} ${randomUUID().slice(0, 6)}` } as Parameters<typeof recordIngestDelivery>[0]["payload"],
    });
    return (await fixtureSql<{ category: string | null; account: string | null; source: string | null }[]>`
      select proposed_category_id as category, proposed_account_id as account, category_source as source
      from ingest_deliveries where id = ${result.deliveryId}`)[0];
  };

  const trustedCategory = await mkCategory("trusted");
  const otherCategory = await mkCategory("other");
  const shopA = `TIENDA M52A ${tag}`;
  await trustMerchant(shopA, trustedCategory);
  const merchantBefore = await merchantRow(shopA);
  const proposalBefore = await deliver(shopA);
  assert(
    next("A merchant approved twice is trusted and its next delivery proposes the category (control)"),
    merchantBefore?.state === "trusted" && merchantBefore.trusted === trustedCategory && proposalBefore?.category === trustedCategory,
    `row = ${JSON.stringify(merchantBefore)}, proposed ${proposalBefore?.category ?? "null"}`,
  );
  let categoryDeleted: boolean | string;
  try {
    categoryDeleted = await asUser(user, () => deleteCategory({ categoryId: trustedCategory }));
  } catch (error) {
    categoryDeleted = refusal(error);
  }
  const merchantAfter = await merchantRow(shopA);
  assert(
    next("Deleting the category a merchant trusts succeeds"),
    categoryDeleted === true,
    `deleteCategory answered ${String(categoryDeleted)}`,
  );
  assert(
    next("The merchant row survives its category's deletion as learning, streak 0, candidate and trusted null"),
    merchantAfter?.state === "learning" &&
      merchantAfter.streak === 0 &&
      merchantAfter.candidate === null &&
      merchantAfter.trusted === null,
    `row = ${JSON.stringify(merchantAfter)}`,
  );
  const proposalAfter = await deliver(shopA);
  assert(
    next("The next delivery for that merchant proposes no category, no account and no category source, from the rule that was kept"),
    merchantAfter !== undefined && proposalAfter !== undefined && proposalAfter.category === null && proposalAfter.account === null && proposalAfter.source === null,
    `proposal = ${JSON.stringify(proposalAfter)}`,
  );

  // The forgotten rule learns again from zero: one approval is not trust.
  const relearnCategory = await mkCategory("relearn");
  await teachMerchant(shopA, relearnCategory);
  const relearnOnce = await merchantRow(shopA);
  assert(
    next("A merchant that lost its category starts over: one approval leaves it learning on streak 1"),
    relearnOnce?.state === "learning" && relearnOnce.streak === 1 && relearnOnce.candidate === relearnCategory && relearnOnce.trusted === null,
    `row = ${JSON.stringify(relearnOnce)}`,
  );

  // Deleting a category the rule does NOT trust leaves a trusted rule alone.
  const shopB = `TIENDA M52B ${tag}`;
  await trustMerchant(shopB, otherCategory);
  const unrelatedCategory = await mkCategory("unrelated");
  await asUser(user, () => deleteCategory({ categoryId: unrelatedCategory }));
  const merchantUntouched = await merchantRow(shopB);
  assert(
    next("Deleting a category some other rule trusts leaves a trusted merchant trusted on streak 2"),
    merchantUntouched?.state === "trusted" && merchantUntouched.streak === 2 && merchantUntouched.trusted === otherCategory,
    `row = ${JSON.stringify(merchantUntouched)}`,
  );

  // The trusted column moving to ANOTHER value is not forgetting.
  const movedCategory = await mkCategory("moved");
  const moved = await code((tx) => tx`update ingest_merchants set trusted_category_id = ${movedCategory} where owner_user_id = ${user.id} and merchant_key = ${merchantKeyOf(shopB)}`);
  const merchantMoved = await merchantRow(shopB);
  assert(
    next("A merchant whose trusted category changes to another category stays trusted on streak 2"),
    moved === "ok" && merchantMoved?.state === "trusted" && merchantMoved.streak === 2 && merchantMoved.trusted === movedCategory,
    `update ${moved}, row = ${JSON.stringify(merchantMoved)}`,
  );

  // A trusted merchant contradicted by a completion is ambiguous, not forgotten: RF-94 keeps that sticky.
  const shopC = `TIENDA M52C ${tag}`;
  await trustMerchant(shopC, otherCategory);
  await teachMerchant(shopC, movedCategory);
  const merchantAmbiguous = await merchantRow(shopC);
  assert(
    next("A trusted merchant contradicted by one approval becomes ambiguous with the new candidate, not learning"),
    merchantAmbiguous?.state === "ambiguous" && merchantAmbiguous.trusted === null && merchantAmbiguous.candidate === movedCategory,
    `row = ${JSON.stringify(merchantAmbiguous)}`,
  );

  // The check that binds state to the trusted column still refuses a forged half.
  const forgedTrustedState = await code((tx) => tx`update ingest_merchants set state = 'trusted' where owner_user_id = ${user.id} and merchant_key = ${merchantKeyOf(shopA)}`);
  const forgedTrustedColumn = await code((tx) => tx`update ingest_merchants set trusted_category_id = ${otherCategory} where owner_user_id = ${user.id} and merchant_key = ${merchantKeyOf(shopA)}`);
  assert(
    next("A merchant cannot be trusted without a category, nor hold a trusted category while learning (23514)"),
    forgedTrustedState === "23514" && forgedTrustedColumn === "23514",
    `state alone ${forgedTrustedState}, column alone ${forgedTrustedColumn}`,
  );

  // ----- counterparties -----
  type CounterpartyRow = { state: string; streak: number; candidate: string | null; trusted: string | null };
  const descriptionOf = (name: string) => `Harness m52 ${name} ${tag} cobro`;
  const patternOf = (name: string) => counterpartyPatternKey(descriptionOf(name));
  const counterpartyRow = async (name: string): Promise<CounterpartyRow | undefined> =>
    (await fixtureSql<CounterpartyRow[]>`
      select state, streak::int as streak, candidate_account_id as candidate, trusted_account_id as trusted
      from ingest_counterparties where owner_user_id = ${user.id} and pattern_key = ${patternOf(name)} and side = 'to'`)[0];
  const teachCounterparty = (name: string, account: string) =>
    asOwner(user.id, async (tx) => {
      await tx`select private.remember_counterparty(${patternOf(name)}, ${descriptionOf(name)}, 'to', ${account})`;
    });
  const trustCounterparty = async (name: string, account: string) => {
    await teachCounterparty(name, account);
    await teachCounterparty(name, account);
  };
  const awaiting = async (name: string): Promise<string> => {
    const { transactionId } = await asUser(user, () =>
      createTransaction({
        fromAccountId: origin,
        toAccountId: null,
        amountCents: 12_300,
        occurredAt: today,
        description: descriptionOf(name),
        externalRef: `m52-${tag}-${name}`,
        splits: [{ categoryId: spendCategory, amountCents: 12_300 }],
        labelIds: [],
      }),
    );
    track("transactions", transactionId);
    await asOwner(user.id, async (tx) => {
      await tx`update transactions set awaiting_counterparty = true where id = ${transactionId}`;
    });
    return transactionId;
  };
  const { listAwaitingCounterparty } = await import("@/db/queries/transactions");
  const proposedFor = async (id: string) =>
    (await asUser(user, () => listAwaitingCounterparty())).find((row) => row.id === id);

  const trustedAccount = await mkAccount("trusted");
  const otherAccount = await mkAccount("other");
  const movedAccount = await mkAccount("moved");
  await trustCounterparty("a", trustedAccount);
  const waiting = await awaiting("a");
  const counterpartyBefore = await counterpartyRow("a");
  const waitingBefore = await proposedFor(waiting);
  assert(
    next("A counterparty completed twice is trusted and its awaiting movement proposes the account (control)"),
    counterpartyBefore?.state === "trusted" && counterpartyBefore.trusted === trustedAccount && waitingBefore?.proposedAccountId === trustedAccount,
    `row = ${JSON.stringify(counterpartyBefore)}, proposed ${waitingBefore?.proposedAccountId ?? "null"}`,
  );
  let accountDeleted: boolean | string;
  try {
    accountDeleted = await asUser(user, () => deleteAccount({ accountId: trustedAccount }));
  } catch (error) {
    accountDeleted = refusal(error);
  }
  const counterpartyAfter = await counterpartyRow("a");
  assert(
    next("Deleting the account a counterparty trusts succeeds"),
    accountDeleted === true,
    `deleteAccount answered ${String(accountDeleted)}`,
  );
  assert(
    next("The counterparty row survives its account's deletion as learning, streak 0, candidate and trusted null"),
    counterpartyAfter?.state === "learning" &&
      counterpartyAfter.streak === 0 &&
      counterpartyAfter.candidate === null &&
      counterpartyAfter.trusted === null,
    `row = ${JSON.stringify(counterpartyAfter)}`,
  );
  const waitingAfter = await proposedFor(waiting);
  assert(
    next("The movement still awaiting its counterparty proposes no account once the rule, kept, lost it"),
    counterpartyAfter !== undefined && waitingAfter !== undefined && waitingAfter.proposedAccountId === null && waitingAfter.proposedAccountLabel === null,
    `proposal = ${JSON.stringify(waitingAfter && { id: waitingAfter.proposedAccountId, label: waitingAfter.proposedAccountLabel })}`,
  );

  const relearnAccount = await mkAccount("relearn");
  await teachCounterparty("a", relearnAccount);
  const relearnCounterparty = await counterpartyRow("a");
  assert(
    next("A counterparty that lost its account starts over: one completion leaves it learning on streak 1"),
    relearnCounterparty?.state === "learning" && relearnCounterparty.streak === 1 && relearnCounterparty.candidate === relearnAccount && relearnCounterparty.trusted === null,
    `row = ${JSON.stringify(relearnCounterparty)}`,
  );

  await trustCounterparty("b", otherAccount);
  const unrelatedAccount = await mkAccount("unrelated");
  await asUser(user, () => deleteAccount({ accountId: unrelatedAccount }));
  const counterpartyUntouched = await counterpartyRow("b");
  assert(
    next("Deleting an account some other rule trusts leaves a trusted counterparty trusted on streak 2"),
    counterpartyUntouched?.state === "trusted" && counterpartyUntouched.streak === 2 && counterpartyUntouched.trusted === otherAccount,
    `row = ${JSON.stringify(counterpartyUntouched)}`,
  );

  const movedCounterparty = await code((tx) => tx`update ingest_counterparties set trusted_account_id = ${movedAccount} where owner_user_id = ${user.id} and pattern_key = ${patternOf("b")} and side = 'to'`);
  const counterpartyMoved = await counterpartyRow("b");
  assert(
    next("A counterparty whose trusted account changes to another account stays trusted on streak 2"),
    movedCounterparty === "ok" && counterpartyMoved?.state === "trusted" && counterpartyMoved.streak === 2 && counterpartyMoved.trusted === movedAccount,
    `update ${movedCounterparty}, row = ${JSON.stringify(counterpartyMoved)}`,
  );

  await trustCounterparty("c", otherAccount);
  await teachCounterparty("c", movedAccount);
  const counterpartyAmbiguous = await counterpartyRow("c");
  assert(
    next("A trusted counterparty contradicted by one completion becomes ambiguous with the new candidate, not learning"),
    counterpartyAmbiguous?.state === "ambiguous" && counterpartyAmbiguous.trusted === null && counterpartyAmbiguous.candidate === movedAccount,
    `row = ${JSON.stringify(counterpartyAmbiguous)}`,
  );

  const forgedCounterpartyState = await code((tx) => tx`update ingest_counterparties set state = 'trusted' where owner_user_id = ${user.id} and pattern_key = ${patternOf("a")} and side = 'to'`);
  const forgedCounterpartyColumn = await code((tx) => tx`update ingest_counterparties set trusted_account_id = ${otherAccount} where owner_user_id = ${user.id} and pattern_key = ${patternOf("a")} and side = 'to'`);
  assert(
    next("A counterparty cannot be trusted without an account, nor hold a trusted account while learning (23514)"),
    forgedCounterpartyState === "23514" && forgedCounterpartyColumn === "23514",
    `state alone ${forgedCounterpartyState}, column alone ${forgedCounterpartyColumn}`,
  );

  // ----- the trigger functions -----
  for (const table of ["ingest_merchants", "ingest_counterparties"] as const) {
    const functions = await fixtureSql<
      { name: string; invoker: boolean; pinned: boolean; anon: boolean; authenticated: boolean; service: boolean; public: boolean }[]
    >`
      select p.proname as name,
        not p.prosecdef as invoker,
        coalesce(p.proconfig, '{}') && array['search_path=""'] as pinned,
        has_function_privilege('anon', p.oid, 'execute') as anon,
        has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
        has_function_privilege('service_role', p.oid, 'execute') as service,
        exists (
          select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = ${`finances.${table}`}::regclass
        and not t.tgisinternal
        and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16
        and t.tgname not like '%set_timestamps'`;
    assert(
      next(`${table} has a BEFORE UPDATE row trigger beyond the timestamps, SECURITY INVOKER with an empty search_path`),
      functions.length === 1 && functions[0].invoker && functions[0].pinned,
      `functions = ${JSON.stringify(functions)}`,
    );
    assert(
      next(`${table}'s forgetting trigger function is executable by PUBLIC, anon, authenticated and service_role: none`),
      functions.length === 1 && !functions[0].public && !functions[0].anon && !functions[0].authenticated && !functions[0].service,
      `functions = ${JSON.stringify(functions)}`,
    );
  }
}

// M49: a rule the night's run pauses says why, and a pause made while the run is mid-flight stays.
// The run is always scoped to the fixture's own user, so no other tenant's due rule is booked.
async function recurringPauseSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const user = await createMembershipFreeUser();
  const stranger = await createMembershipFreeUser();
  const open = async (owner: HarnessUser) => {
    const { accountId } = await asUser(owner, () =>
      createAccount({
        name: `Harness m49 ${tag}`,
        kind: "asset",
        subtype: "bank",
        ownerUserId: owner.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor: 100_000_000,
        balanceOn: shiftDate(today, -30),
      }),
    );
    track("accounts", accountId);
    const { categoryId } = await asUser(owner, () =>
      createCategory({ scope: { ownerUserId: owner.id }, name: `Harness m49 ${tag}`, kind: "expense", parentId: null, color: "#0E7490" }),
    );
    track("categories", categoryId);
    return { accountId, categoryId };
  };
  const own = await open(user);
  const foreign = await open(stranger);

  const makeRule = async (dueIn: number, categoryId = own.categoryId): Promise<string> => {
    const { recurringRuleId } = await asUser(user, () =>
      createRecurringRule({
        fromAccountId: own.accountId,
        toAccountId: null,
        amountCents: 1_000,
        categoryId,
        description: `m49 ${tag}`,
        frequency: "weekly",
        intervalN: 1,
        dayOfMonth: null,
        nextRunOn: shiftDate(today, dueIn),
        endsOn: null,
      }),
    );
    keep("recurring_rules", recurringRuleId);
    return recurringRuleId;
  };
  type State = { is_active: boolean; paused_reason: string | null; next_run_on: string };
  const read = async (id: string): Promise<State> =>
    (
      await fixtureSql<State[]>`
        select is_active, paused_reason, next_run_on::text as next_run_on from recurring_rules where id = ${id}`
    )[0];
  const booked = async (id: string): Promise<number> => {
    const rows = await fixtureSql<{ id: string }[]>`select id from transactions where recurring_rule_id = ${id}`;
    for (const r of rows) keep("transactions", r.id);
    return rows.length;
  };
  const row = async (label: string, body: () => Promise<{ ok: boolean; detail: string }>): Promise<void> => {
    try {
      const verdict = await body();
      assert(next(label), verdict.ok, verdict.detail);
    } catch (error) {
      assert(next(label), false, refusal(error));
    }
  };
  const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

  await row("A rule whose generated movement fails is paused by the run with paused_reason 'failed'", async () => {
    const id = await makeRule(-7, foreign.categoryId);
    await fixtureSql`select private.run_due_recurring_rules(${user.id}::uuid)`;
    const after = await read(id);
    return {
      ok: after.is_active === false && after.paused_reason === "failed" && (await booked(id)) === 0,
      detail: `is_active = ${after.is_active}, paused_reason = ${after.paused_reason}`,
    };
  });

  // A second connection holds the rule's row, the run starts against the rule it read as active, and the
  // second connection commits while the run waits. The run must lock the rule and look again.
  const raceRun = async (change: (tx: typeof fixtureSql) => Promise<void>) => {
    const writer = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1, connection: { search_path: "finances, public" } });
    const runner = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1, connection: { search_path: "finances, public" } });
    try {
      const [{ pid }] = await runner<{ pid: number }[]>`select pg_backend_pid() as pid`;
      let release!: () => void;
      const gate = new Promise<void>((done) => (release = done));
      let held!: () => void;
      const holding = new Promise<void>((done) => (held = done));
      const hold = writer.begin(async (tx) => {
        await change(tx as unknown as typeof fixtureSql);
        held();
        await gate;
      });
      await holding;
      // A postgres.js query is lazy: `execute` sends it now, so the run is in flight while the writer holds the row.
      const running = runner`select private.run_due_recurring_rules(${user.id}::uuid)`.execute();
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline && !waiting) {
        const [w] = await fixtureSql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock'`;
        waiting = w.n > 0;
        if (!waiting) await pause(25);
      }
      release();
      await hold;
      await running;
      return waiting;
    } finally {
      await writer.end();
      await runner.end();
    }
  };

  await row("A pause committed by a second connection while the run waits on the rule stays a pause", async () => {
    const id = await makeRule(-7);
    const waited = await raceRun(async (tx) => {
      await tx`update recurring_rules set is_active = false where id = ${id}`;
    });
    const after = await read(id);
    return {
      ok: waited && after.is_active === false && after.paused_reason === null && (await booked(id)) === 0,
      detail: `run waited on the lock = ${waited}, is_active = ${after.is_active}, paused_reason = ${after.paused_reason}`,
    };
  });

  await row("A next run moved by a second connection while the run waits is kept, and the run books nothing over it", async () => {
    const id = await makeRule(-7);
    const moved = shiftDate(today, 21);
    const waited = await raceRun(async (tx) => {
      await tx`update recurring_rules set next_run_on = ${moved} where id = ${id}`;
    });
    const after = await read(id);
    return {
      ok: waited && after.next_run_on === moved && after.is_active === true && (await booked(id)) === 0,
      detail: `run waited = ${waited}, next_run_on = ${after.next_run_on} (expected ${moved}), is_active = ${after.is_active}`,
    };
  });

  await row("Resuming a rule the run paused clears paused_reason and makes it active", async () => {
    const id = await makeRule(7);
    await fixtureSql`update recurring_rules set is_active = false, paused_reason = 'failed' where id = ${id}`;
    const result = await asUser(user, () => resumeRecurringRuleAction({ id }));
    const after = await read(id);
    return {
      ok: result?.serverError === undefined && after.is_active === true && after.paused_reason === null,
      detail: `result = ${JSON.stringify(result)}, is_active = ${after.is_active}, paused_reason = ${after.paused_reason}`,
    };
  });

  await row("Pausing a rule by hand leaves paused_reason null", async () => {
    const id = await makeRule(7);
    const result = await asUser(user, () => pauseRecurringRuleAction({ id }));
    const after = await read(id);
    return {
      ok: result?.serverError === undefined && after.is_active === false && after.paused_reason === null,
      detail: `result = ${JSON.stringify(result)}, is_active = ${after.is_active}, paused_reason = ${after.paused_reason}`,
    };
  });

  await row("Resuming a rule that ran to its end is refused by the database, books nothing and leaves it inactive", async () => {
    const { recurringRuleId: id } = await asUser(user, () =>
      createRecurringRule({
        fromAccountId: own.accountId,
        toAccountId: null,
        amountCents: 1_000,
        categoryId: own.categoryId,
        description: `m49 end ${tag}`,
        frequency: "weekly",
        intervalN: 1,
        dayOfMonth: null,
        nextRunOn: shiftDate(today, -7),
        endsOn: shiftDate(today, -1),
      }),
    );
    keep("recurring_rules", id);
    await fixtureSql`select private.run_due_recurring_rules(${user.id}::uuid)`;
    const ended = await read(id);
    const before = await booked(id);
    const result = await asUser(user, () => resumeRecurringRuleAction({ id }));
    const after = await read(id);
    return {
      ok:
        ended.is_active === false && before === 1 && result?.serverError !== undefined &&
        after.is_active === false && (await booked(id)) === before,
      detail: `ended inactive = ${!ended.is_active}, booked ${before}, resume = ${JSON.stringify(result)}, is_active = ${after.is_active}`,
    };
  });
}

// A resent form ref names the same destination and
// the same source it first booked (RF-158), an income resend has no source to compare yet is the
// same request, and an unstamped edit of a rule that is not there is refused notFound (RF-31).
async function resendAndMissingSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const actions = (await import("@/app/actions/transactions")) as unknown as {
    createTransactionAction: (input: Record<string, unknown>) => Promise<MovementResult>;
  };
  const { withdrawCashAction } = (await import("@/app/actions/cash")) as unknown as {
    withdrawCashAction: (input: Record<string, unknown>) => Promise<{
      serverError?: string;
      data?: { transactionId: string };
    } | undefined>;
  };
  const user = await createMembershipFreeUser();
  const mkAccount = async (name: string): Promise<string> => {
    const { accountId } = await asUser(user, () =>
      createAccount({
        name: `${name} ${tag}`,
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
    return accountId;
  };
  const accountA = await mkAccount("Harness m78 A");
  const accountB = await mkAccount("Harness m78 B");
  const accountC = await mkAccount("Harness m78 C");
  const { categoryId: incomeCategory } = await asUser(user, () =>
    createCategory({ scope: { ownerUserId: user.id }, name: `Harness m78 ${tag}`, kind: "income", parentId: null, color: "#0E7490" }),
  );
  track("categories", incomeCategory);
  const { categoryId: expenseCategory } = await asUser(user, () =>
    createCategory({ scope: { ownerUserId: user.id }, name: `Harness m78 gasto ${tag}`, kind: "expense", parentId: null, color: "#0E7490" }),
  );
  track("categories", expenseCategory);

  const send = (ref: string, over: Record<string, unknown>) =>
    asUser(user, () =>
      actions.createTransactionAction({
        requestRef: ref,
        amount: "100",
        occurredAt: today,
        description: `m78 ${tag}`,
        labelIds: [],
        ...over,
      }),
    );
  type Row = { id: string; to_account_id: string | null; from_account_id: string | null };
  const rowsOf = async (ref: string) => {
    const rows = await fixtureSql<Row[]>`
      select id, to_account_id, from_account_id from transactions
      where owner_user_id = ${user.id} and external_ref = ${`form:${ref}`}`;
    rows.forEach((r) => track("transactions", r.id));
    return rows;
  };
  const refused = (r: { serverError?: string; data?: { ok?: boolean; reason?: string } } | undefined) =>
    r?.serverError === "errors.resendChanged" || (r?.data?.ok === false && r.data.reason === "resendChanged");

  // Q: a transfer resent with another destination
  const transfer = { fromAccountId: accountA, toAccountId: accountB, splits: [] };
  const tRef = randomUUID();
  await send(tRef, transfer);
  const t2 = await send(tRef, { ...transfer, toAccountId: accountC });
  const tRows = await rowsOf(tRef);
  assert(
    next("A resend of a form ref with the same source and amount but another destination account is refused resendChanged and keeps the first destination"),
    refused(t2) && tRows.length === 1 && tRows[0].to_account_id === accountB,
    `result = ${JSON.stringify(t2)}, rows = ${JSON.stringify(tRows)}`,
  );

  // Q: an income, which has no source account, resent unchanged
  const income = { fromAccountId: null, toAccountId: accountA, splits: [{ categoryId: incomeCategory, amount: "100" }] };
  const iRef = randomUUID();
  const i1 = await send(iRef, income);
  const i2 = await send(iRef, income);
  const iRows = await rowsOf(iRef);
  assert(
    next("An income sent twice with the same requestRef answers ok with the first movement's id and books one row"),
    iRows.length === 1 && i1.data?.ok === true && i2.data?.ok === true &&
      i1.data.transactionId === iRows[0].id && i2.data.transactionId === iRows[0].id,
    `${iRows.length} row(s), first = ${JSON.stringify(i1)}, second = ${JSON.stringify(i2)}`,
  );

  // Q: a cash withdrawal resent from another source account
  const wRef = randomUUID();
  const withdraw = (source: string) =>
    asUser(user, () => withdrawCashAction({ sourceAccountId: source, amount: "100", requestRef: wRef }));
  const w1 = await withdraw(accountA);
  const w2 = await withdraw(accountB);
  const wRows = await rowsOf(wRef);
  const cashRows = await fixtureSql<{ id: string }[]>`select id from accounts where owner_user_id = ${user.id} and subtype = 'cash'`;
  cashRows.forEach((r) => track("accounts", r.id));
  assert(
    next("A resent withdrawal with the same amount but another source account is refused resendChanged and keeps the first source"),
    w1?.data?.transactionId !== undefined &&
      JSON.stringify(w2).includes("resendChanged") &&
      w2?.data?.transactionId === undefined &&
      wRows.length === 1 &&
      wRows[0].from_account_id === accountA,
    `first = ${JSON.stringify(w1)}, second = ${JSON.stringify(w2)}, rows = ${JSON.stringify(wRows)}`,
  );

  // Q: a stamped edit of a rule that is gone (the stamp guard would otherwise answer stale first)
  const { recurringRuleId } = await asUser(user, () =>
    createRecurringRule({
      fromAccountId: accountA,
      toAccountId: null,
      amountCents: 1_000,
      categoryId: expenseCategory,
      description: `m78 ${tag}`,
      frequency: "weekly",
      intervalN: 1,
      dayOfMonth: null,
      nextRunOn: shiftDate(today, 7),
      endsOn: null,
    }),
  );
  // The stamp guard answers before the lookup, so the form's stamp is read before the row goes.
  const [{ stamp: goneStamp }] = await fixtureSql<{ stamp: string }[]>`
    select updated_at::text as stamp from recurring_rules where id = ${recurringRuleId}`;
  await fixtureSql`delete from recurring_rules where id = ${recurringRuleId}`;
  const gone = (await asUser(user, () =>
    updateRecurringRuleAction({
      id: recurringRuleId,
      expectedUpdatedAt: goneStamp,
      fromAccountId: accountA,
      toAccountId: null,
      amount: "20",
      categoryId: expenseCategory,
      description: `m78 ${tag}`,
      frequency: "weekly",
      intervalN: 1,
      dayOfMonth: null,
      nextRunOn: shiftDate(today, 7),
      endsOn: null,
    } as Parameters<typeof updateRecurringRuleAction>[0]),
  )) as { serverError?: string; data?: { ok?: boolean; reason?: string } } | undefined;
  assert(
    next("A stamped edit of a rule that is gone is refused notFound"),
    gone?.serverError === "errors.notFound" && gone?.data?.ok !== true,
    `result = ${JSON.stringify(gone)}`,
  );
}

// M54: an estimate dated on or before the account's latest reconciliation cannot be confirmed (RF-123, RF-137).
async function billedBeforeReconciliationSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const user = await createMembershipFreeUser();
  await asUser(user, async () => {
  const { categoryId } = await createCategory({
    scope: { ownerUserId: user.id },
    name: `Harness m54 ${tag}`,
    kind: "expense",
    parentId: null,
    color: "#0E7490",
  });
  track("categories", categoryId);
  const { accountId } = await createAccount({
    name: `Harness m54 ${tag}`,
    kind: "asset",
    subtype: "bank",
    ownerUserId: user.id,
    groupId: null,
    isShared: false,
    institution: null,
    lastFour: null,
    settlementCurrency: "COP",
    amountMinor: 100_000_000,
    balanceOn: "2026-08-01",
  });
  track("accounts", accountId);
  const purchaseOn = async (day: string): Promise<string> => {
    const created = await createTransaction({
      fromAccountId: accountId,
      toAccountId: null,
      amountCents: 10_000,
      currency: "USD",
      counterAmountCents: 40_000_000,
      counterIsEstimate: true,
      occurredAt: day,
      description: `m54 ${tag} ${day}`,
      externalRef: null,
      splits: [{ categoryId: categoryId, amountCents: 10_000 }],
      labelIds: [],
    });
    track("transactions", created.transactionId);
    return created.transactionId;
  };
  const fifth = await purchaseOn("2026-09-05");
  const tenth = await purchaseOn("2026-09-10");
  const eleventh = await purchaseOn("2026-09-11");
  const sheet = await getReconcileSheet(accountId, "2026-09-10");
  const counted = await reconcileAccount({
    accountId,
    reconciledOn: "2026-09-10",
    realMagnitudeCents: 50_000_000,
    expectedDerivedCents: sheet?.account.derivedCents ?? 0,
  });
  assert(next("The fixture account is reconciled on the 10th"), counted.ok, JSON.stringify(counted));

  const state = async (id: string) => {
    const [row] = await fixtureSql<{ counter: string; estimate: boolean }[]>`
      select counter_amount_cents::text as counter, counter_is_estimate as estimate
      from transactions where id = ${id}`;
    return row;
  };
  const movements = async () =>
    (await fixtureSql<{ n: string }[]>`
      select count(*)::text as n from transactions where from_account_id = ${accountId} or to_account_id = ${accountId}`)[0].n;
  // The refusal may travel as a throw or as a result; either names its reason.
  const confirm = async (id: string) => {
    try {
      const answer = (await recordBilledAmount({
        transactionId: id,
        accountId,
        currency: "COP",
        billedCents: 41_500_000,
      })) as unknown;
      const reason = (answer as { reason?: string } | null)?.reason;
      return { answer, reason };
    } catch (error) {
      const thrown = error as { reason?: string; result?: { reason?: string }; message?: string };
      return { answer: "threw", reason: thrown.reason ?? thrown.result?.reason ?? thrown.message };
    }
  };

  const countBefore = await movements();
  const onFifth = await confirm(fifth);
  const fifthState = await state(fifth);
  assert(
    next("An estimate before the reconciliation is refused and writes nothing"),
    onFifth.reason === "beforeReconciliation" && fifthState.estimate === true &&
      fifthState.counter === "40000000" && (await movements()) === countBefore,
    `reason ${onFifth.reason}, estimate ${fifthState.estimate}, counter ${fifthState.counter}`,
  );
  const onTenth = await confirm(tenth);
  const tenthState = await state(tenth);
  assert(
    next("An estimate dated the day of the reconciliation is refused"),
    onTenth.reason === "beforeReconciliation" && tenthState.estimate === true &&
      tenthState.counter === "40000000",
    `reason ${onTenth.reason}, estimate ${tenthState.estimate}, counter ${tenthState.counter}`,
  );
  const onEleventh = await confirm(eleventh);
  const eleventhState = await state(eleventh);
  assert(
    next("An estimate the day after the reconciliation is confirmed"),
    onEleventh.reason === undefined && eleventhState.estimate === false &&
      eleventhState.counter === "41500000",
    `answer ${JSON.stringify(onEleventh.answer)}, estimate ${eleventhState.estimate}, counter ${eleventhState.counter}`,
  );

  const actions = (await import("@/app/actions/debt-settlement")) as unknown as {
    recordBilledAmountAction: (input: Record<string, unknown>) => Promise<StaleAnswer>;
  };
  const viaAction = await actions.recordBilledAmountAction({
    transactionId: fifth,
    accountId,
    currency: "COP",
    billedAmount: "415000",
  });
  assert(
    next("The action answers a refused estimate with debts.errors.beforeReconciliation"),
    viaAction?.serverError === "debts.errors.beforeReconciliation" && (await state(fifth)).estimate === true,
    `serverError = ${viaAction?.serverError ?? "none"}`,
  );
  assert(
    next("The before-reconciliation message exists in both languages"),
    typeof es.debts.errors.beforeReconciliation === "string" &&
      typeof en.debts.errors.beforeReconciliation === "string",
    "debts.errors.beforeReconciliation",
  );
  });
}

// M55: an asset account's still-estimated foreign purchase is listed for confirmation (RF-123).
async function pendingSettlementsOnAssetSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const user = await createMembershipFreeUser();
  await asUser(user, async () => {
    const { categoryId } = await createCategory({
      scope: { ownerUserId: user.id },
      name: `Harness m55 ${tag}`,
      kind: "expense",
      parentId: null,
      color: "#0E7490",
    });
    track("categories", categoryId);
    const { accountId } = await createAccount({
      name: `Harness m55 ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: user.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 100_000_000,
      balanceOn: "2026-08-01",
    });
    track("accounts", accountId);
    const purchase = async (currency: string, estimate: boolean, day: string): Promise<string> => {
      const created = await createTransaction({
        fromAccountId: accountId,
        toAccountId: null,
        amountCents: 10_000,
        currency,
        counterAmountCents: currency === "USD" ? 40_000_000 : null,
        counterIsEstimate: estimate,
        occurredAt: day,
        description: `m55 ${tag} ${currency} ${estimate} ${day}`,
        externalRef: null,
        splits: [{ categoryId: categoryId, amountCents: 10_000 }],
        labelIds: [],
      });
      track("transactions", created.transactionId);
      return created.transactionId;
    };
    const pending = await purchase("USD", true, "2026-09-05");
    const billed = await purchase("USD", false, "2026-09-06");
    await purchase("COP", false, "2026-09-07");

    const listed = await listPendingSettlements(accountId);
    assert(
      next("An asset account's pending foreign estimate is listed"),
      listed.some((row) => row.id === pending && row.currency === "USD" && row.amountCents === 10_000 && row.counterAmountCents === 40_000_000),
      JSON.stringify(listed),
    );
    assert(
      next("Only the estimate is listed: a billed purchase and a peso one are not"),
      listed.length === 1 && !listed.some((row) => row.id === billed),
      JSON.stringify(listed),
    );
  });
}

// RF-154, the server half of «X te invitó · Aceptar / Rechazar» and «Salir del fondo». The three functions
// are named here by what the person's tap does, and they are looked up when a row runs, not when the file
// loads: until they exist every row below fails with the missing name in its detail, and no other row moves.
// Each acts for the session's own user and answers a word: accept `accepted | gone | otherFund`, decline
// `declined | gone`, leave `left | leaderStays | notInFund`.
type InvitationApi = {
  acceptInvitation: (input: { memberId: string }) => Promise<string>;
  declineInvitation: (input: { memberId: string }) => Promise<string>;
  leaveFund: () => Promise<string>;
};

async function invitationApi(): Promise<InvitationApi> {
  const loaded = (await import("@/db/queries/group-members")) as unknown as Partial<InvitationApi>;
  const named = <K extends keyof InvitationApi>(name: K): InvitationApi[K] => {
    const found = loaded[name];
    if (typeof found === "function") return found as InvitationApi[K];
    return (async () => {
      throw new TypeError(`db/queries/group-members does not export ${name}`);
    }) as InvitationApi[K];
  };

  return {
    acceptInvitation: named("acceptInvitation"),
    declineInvitation: named("declineInvitation"),
    leaveFund: named("leaveFund"),
  };
}

// A refusal that raised reads as a word of its own, so an assertion on the answer fails with the cause.
async function tap(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (error) {
    return `threw ${refusal(error)}`;
  }
}

async function invitationActsSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const api = await invitationApi();
  const groupIds: string[] = [];

  type InviteRow = {
    id: string;
    user_id: string | null;
    invite_email: string | null;
    invite_state: string;
    name: string;
    role: string;
    archived_at: string | null;
  };
  const rowOf = async (id: string): Promise<InviteRow | undefined> =>
    (
      await fixtureSql<InviteRow[]>`
        select id, user_id, invite_email, invite_state, name, role, archived_at::text as archived_at
        from group_members where id = ${id}`
    )[0];
  const liveRowsOf = (userId: string) =>
    fixtureSql<{ id: string; group_id: string }[]>`
      select id, group_id from group_members where user_id = ${userId} and archived_at is null`;
  const liveCount = async (groupId: string): Promise<number> =>
    Number(
      (
        await fixtureSql<{ n: string }[]>`
          select count(*)::text as n from group_members where group_id = ${groupId} and user_id is not null and archived_at is null`
      )[0].n,
    );

  const openFund = async (label: string): Promise<{ leader: HarnessUser; groupId: string }> => {
    const leader = await createMembershipFreeUser();
    const { groupId } = await asUser(leader, () =>
      createGroup({ name: `Harness fondo ${label} ${tag}`, leaderName: `Harness lider ${label}`, cashMode: "shared", locale: "es" }),
    );
    track("groups", groupId);
    groupIds.push(groupId);
    return { leader, groupId };
  };
  const invite = async (fund: { leader: HarnessUser; groupId: string }, who: HarnessUser, name: string): Promise<string> => {
    const memberId = randomUUID();
    await seedPendingInvite({ groupId: fund.groupId, memberId, actorId: fund.leader.id, name, email: who.email, archived: false });
    return memberId;
  };
  const personalMovement = async (owner: HarnessUser): Promise<{ accountId: string; transactionId: string }> =>
    asUser(owner, async () => {
      const { accountId } = await createAccount({
        name: `Harness propia ${tag}`,
        kind: "asset",
        subtype: "bank",
        ownerUserId: owner.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor: 1_000_000,
        balanceOn: shiftDate(today, -10),
      });
      track("accounts", accountId);
      const { categoryId } = await createCategory({
        scope: { ownerUserId: owner.id },
        name: `Harness propia gasto ${tag}`,
        kind: "expense",
        parentId: null,
        color: "#0E7490",
      });
      track("categories", categoryId);
      const { transactionId } = await createTransaction({
        fromAccountId: accountId,
        toAccountId: null,
        amountCents: 10_000,
        currency: "COP",
        counterAmountCents: null,
        counterIsEstimate: false,
        occurredAt: shiftDate(today, -1),
        description: `Harness propio ${tag}`,
        externalRef: null,
        splits: [{ categoryId, amountCents: 10_000 }],
        labelIds: [],
      });
      track("transactions", transactionId);
      return { accountId, transactionId };
    });
  const accountIds = (who: HarnessUser) => asUser(who, async () => (await listAccounts({ archived: false })).map((a) => a.id));
  const sees = (who: HarnessUser, transactionId: string) =>
    asUser(who, async () => (await getTransactionById(transactionId)) !== null);

  try {
    // The invitation, accepted, refused and replayed.
    const fund = await openFund("acepta");
    const { leader, groupId } = fund;
    const invitee = await createMembershipFreeUser();
    const stranger = await createMembershipFreeUser();
    const inviteId = await invite(fund, invitee, "Harness invitada acepta");
    const own = await personalMovement(invitee);
    const rosterBefore = await liveCount(groupId);

    const wrongAccept = await tap(() => asUser(stranger, () => api.acceptInvitation({ memberId: inviteId })));
    const wrongDecline = await tap(() => asUser(stranger, () => api.declineInvitation({ memberId: inviteId })));
    const untouched = await rowOf(inviteId);
    assert(
      next("A person the invitation is not addressed to cannot accept or decline it: both answer gone, the row stays pending and unclaimed, and they join nothing"),
      wrongAccept === "gone" &&
        wrongDecline === "gone" &&
        untouched?.invite_state === "pending" &&
        untouched.user_id === null &&
        untouched.archived_at === null &&
        (await liveRowsOf(stranger.id)).length === 0,
      `accept = ${wrongAccept}, decline = ${wrongDecline}, row = ${JSON.stringify(untouched)}`,
    );

    const leaderSawBefore = (await accountIds(leader)).includes(own.accountId) || (await sees(leader, own.transactionId));
    const accepted = await tap(() => asUser(invitee, () => api.acceptInvitation({ memberId: inviteId })));
    const joined = await rowOf(inviteId);
    const asInvitee = await asUser(invitee, () => listMembers(groupId, { archived: false }));
    const leaderAccounts = await accountIds(leader);
    const inviteeAccounts = await accountIds(invitee);
    const [fundCash] = await fixtureSql<{ id: string }[]>`select id from accounts where group_id = ${groupId} and subtype = 'cash'`;
    assert(
      next("Accepting joins: the same row turns accepted with the person's user and no address left, the roster gains no row, and the fund now reads what membership reads, both ways"),
      !leaderSawBefore &&
        accepted === "accepted" &&
        joined?.invite_state === "accepted" &&
        joined.user_id === invitee.id &&
        joined.invite_email === null &&
        joined.name === "Harness invitada acepta" &&
        joined.role === "member" &&
        joined.archived_at === null &&
        (await liveCount(groupId)) === rosterBefore + 1 &&
        asInvitee.some((m) => m.id === inviteId) &&
        asInvitee.length === 2 &&
        leaderAccounts.includes(own.accountId) &&
        (await sees(leader, own.transactionId)) &&
        inviteeAccounts.includes(fundCash.id),
      `leader read the invitee's rows before accepting = ${leaderSawBefore}, accept = ${accepted}, row = ${JSON.stringify(joined)}, live members ${rosterBefore} -> ${await liveCount(groupId)}, invitee sees ${asInvitee.length} members, leader lists their account = ${leaderAccounts.includes(own.accountId)}, invitee lists the fund's cash = ${inviteeAccounts.includes(fundCash.id)}`,
    );

    const again = await tap(() => asUser(invitee, () => api.acceptInvitation({ memberId: inviteId })));
    const declineAfter = await tap(() => asUser(invitee, () => api.declineInvitation({ memberId: inviteId })));
    const stillIn = await rowOf(inviteId);
    assert(
      next("A second tap changes nothing, and declining after accepting cannot remove a live member: one membership, still accepted"),
      (again === "accepted" || again === "gone") &&
        declineAfter === "gone" &&
        stillIn?.invite_state === "accepted" &&
        stillIn.user_id === invitee.id &&
        stillIn.archived_at === null &&
        (await liveRowsOf(invitee.id)).length === 1,
      `second accept = ${again}, decline = ${declineAfter}, row = ${JSON.stringify(stillIn)}`,
    );

    // A withdrawn invitation is no longer one a person can accept.
    const withdrawnFor = await createMembershipFreeUser();
    const withdrawnId = await invite(fund, withdrawnFor, "Harness invitada retirada");
    const archived = await asUser(leader, () => archiveMember({ groupId, memberId: withdrawnId }));
    const lateAccept = await tap(() => asUser(withdrawnFor, () => api.acceptInvitation({ memberId: withdrawnId })));
    const withdrawnRow = await rowOf(withdrawnId);
    assert(
      next("An invitation the leader withdrew is refused as gone: the row stays archived and unclaimed and the person joins nothing"),
      archived &&
        lateAccept === "gone" &&
        withdrawnRow?.user_id === null &&
        withdrawnRow.archived_at !== null &&
        withdrawnRow.invite_state === "pending" &&
        (await liveRowsOf(withdrawnFor.id)).length === 0,
      `archived = ${archived}, accept = ${lateAccept}, row = ${JSON.stringify(withdrawnRow)}`,
    );

    // One fund at a time.
    const resident = await createMembershipFreeUser();
    const { groupId: homeGroupId } = await asUser(resident, () =>
      createGroup({ name: `Harness fondo propio ${tag}`, leaderName: "Harness residente", cashMode: "shared", locale: "es" }),
    );
    track("groups", homeGroupId);
    groupIds.push(homeGroupId);
    // Not alone: someone else lives in the resident's fund, so it is not one they may leave behind (Q32 a).
    await seedFellowMember(resident.id, homeGroupId);
    const otherInviteId = await invite(fund, resident, "Harness invitada de otro fondo");
    const blocked = await tap(() => asUser(resident, () => api.acceptInvitation({ memberId: otherInviteId })));
    const blockedRow = await rowOf(otherInviteId);
    const residentRows = await liveRowsOf(resident.id);
    assert(
      next("A person already in a fund with others who accepts another's invitation is refused as otherFund: still in their own fund, the invitation stays pending"),
      blocked === "otherFund" &&
        blockedRow?.invite_state === "pending" &&
        blockedRow.user_id === null &&
        residentRows.length === 1 &&
        residentRows[0].group_id === homeGroupId,
      `accept = ${blocked}, invitation = ${JSON.stringify(blockedRow)}, live memberships = ${JSON.stringify(residentRows)}`,
    );

    // Declining, and being invited again.
    const decliner = await createMembershipFreeUser();
    const declinedId = await invite(fund, decliner, "Harness invitada rechaza");
    const declined = await tap(() => asUser(decliner, () => api.declineInvitation({ memberId: declinedId })));
    const declinedRow = await rowOf(declinedId);
    const rosterAfterDecline = await asUser(leader, () => listMembers(groupId, { archived: false }));
    const revive = await tap(() => asUser(decliner, () => api.acceptInvitation({ memberId: declinedId })));
    assert(
      next("Declining archives the invitation: declined, no user, off the leader's roster, no membership, and a declined invitation cannot be accepted afterwards"),
      declined === "declined" &&
        declinedRow?.invite_state === "declined" &&
        declinedRow.archived_at !== null &&
        declinedRow.user_id === null &&
        !rosterAfterDecline.some((m) => m.id === declinedId) &&
        revive === "gone" &&
        (await liveRowsOf(decliner.id)).length === 0,
      `decline = ${declined}, row = ${JSON.stringify(declinedRow)}, on the roster = ${rosterAfterDecline.some((m) => m.id === declinedId)}, accept afterwards = ${revive}`,
    );

    const reinvited = await tap(async () =>
      asUser(leader, async () => {
        const { memberId } = await createMember({ groupId, name: "Harness invitada de nuevo", inviteEmail: decliner.email.toUpperCase() });
        track("group_members", memberId);
        return memberId;
      }),
    );
    const secondAccept = await tap(() => asUser(decliner, () => api.acceptInvitation({ memberId: reinvited })));
    const history = await rowOf(declinedId);
    assert(
      next("After declining, the same address can be invited again and the person can then accept: they join through the new row and the declined one stays as history"),
      !reinvited.startsWith("threw") &&
        reinvited !== declinedId &&
        secondAccept === "accepted" &&
        (await rowOf(reinvited))?.user_id === decliner.id &&
        history?.invite_state === "declined" &&
        history.user_id === null,
      `re-invited as ${reinvited}, accept = ${secondAccept}, history row = ${JSON.stringify(history)}`,
    );

    // Leaving. The invitee writes in the fund, then leaves.
    const [expenseCategory] = await fixtureSql<{ id: string }[]>`
      select id from categories where group_id = ${groupId} and kind = 'expense' and parent_id is null order by name limit 1`;
    const { accountId: bankId } = await asUser(leader, () =>
      createAccount({
        name: `Harness banco fondo ${tag}`,
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
    track("accounts", bankId);
    // A person who never joined cannot write here; the movement then names a row that does not exist and
    // the rows below fail on it, rather than the run aborting.
    const fundMovement = await asUser(invitee, async () => {
      try {
        return (await createTransaction({
            fromAccountId: bankId,
            toAccountId: null,
            amountCents: 7_000,
            currency: "COP",
            counterAmountCents: null,
            counterIsEstimate: false,
            occurredAt: shiftDate(today, -1),
            description: `Harness del fondo ${tag}`,
            externalRef: null,
            splits: [{ categoryId: expenseCategory.id, amountCents: 7_000 }],
            labelIds: [],
        })).transactionId;
      } catch {
        return randomUUID();
      }
    });
    track("transactions", fundMovement);
    const bankBalance = () =>
      asUser(leader, async () => (await listAccounts({ archived: false })).find((a) => a.id === bankId)?.balances[0]?.balanceCents);
    const balanceBefore = await bankBalance();
    const liveBefore = await liveCount(groupId);

    const left = await tap(() => asUser(invitee, () => api.leaveFund()));
    const leaderRoster = await asUser(leader, () => listMembers(groupId, { archived: false }));
    const leaderAccountsAfter = await accountIds(leader);
    const inviteeAccountsAfter = await accountIds(invitee);
    const [ownAccount] = await fixtureSql<{ owner_user_id: string | null; archived_at: string | null }[]>`
      select owner_user_id, archived_at::text as archived_at from accounts where id = ${own.accountId}`;
    const [{ n: ownMovements }] = await fixtureSql<{ n: string }[]>`select count(*)::text as n from transactions where id = ${own.transactionId}`;
    assert(
      next("Leaving takes the person out of the roster: no live membership, off the leader's roster, one live member fewer, and the fund's accounts are no longer theirs to read"),
      left === "left" &&
        (await liveRowsOf(invitee.id)).length === 0 &&
        !leaderRoster.some((m) => m.id === inviteId || m.userId === invitee.id) &&
        (await liveCount(groupId)) === liveBefore - 1 &&
        !inviteeAccountsAfter.includes(bankId) &&
        !inviteeAccountsAfter.includes(fundCash.id),
      `leave = ${left}, live members ${liveBefore} -> ${await liveCount(groupId)}, invitee still lists the fund's accounts = ${inviteeAccountsAfter.includes(bankId)}`,
    );
    assert(
      next("What the person wrote in the fund stays with the fund: the leader still reads their movement and the shared account's balance has not moved"),
      left === "left" &&
        (await sees(leader, fundMovement)) &&
        (await bankBalance()) === balanceBefore &&
        (await fixtureSql`select 1 from transactions where id = ${fundMovement}`).length === 1,
      `balance ${balanceBefore} -> ${await bankBalance()}, leader reads the movement = ${await sees(leader, fundMovement)}`,
    );
    assert(
      next("Their personal accounts become theirs alone: still theirs and still read by them, no longer listed or readable by the fund"),
      left === "left" &&
        ownAccount?.owner_user_id === invitee.id &&
        ownAccount.archived_at === null &&
        ownMovements === "1" &&
        inviteeAccountsAfter.includes(own.accountId) &&
        (await sees(invitee, own.transactionId)) &&
        !leaderAccountsAfter.includes(own.accountId) &&
        !(await sees(leader, own.transactionId)),
      `owner = ${ownAccount?.owner_user_id}, they list it = ${inviteeAccountsAfter.includes(own.accountId)}, the leader lists it = ${leaderAccountsAfter.includes(own.accountId)}`,
    );

    // Out, they are free to join another fund; and a leader stays while anyone else does.
    const second = await openFund("sale");
    const secondInvite = await invite(second, invitee, "Harness invitada vuelve");
    const rejoined = await tap(() => asUser(invitee, () => api.acceptInvitation({ memberId: secondInvite })));
    const leaderStays = await tap(() => asUser(second.leader, () => api.leaveFund()));
    const leaderRow = await fixtureSql<{ role: string; archived_at: string | null }[]>`
      select role, archived_at::text as archived_at from group_members where group_id = ${second.groupId} and user_id = ${second.leader.id}`;
    assert(
      next("Having left, the person joins another fund by accepting its invitation; and that fund's leader cannot leave while the fund has other members (leaderStays, still its leader)"),
      rejoined === "accepted" &&
        leaderStays === "leaderStays" &&
        leaderRow.length === 1 &&
        leaderRow[0].role === "leader" &&
        leaderRow[0].archived_at === null &&
        (await liveCount(second.groupId)) === 2,
      `rejoin = ${rejoined}, leader leaves = ${leaderStays}, leader row = ${JSON.stringify(leaderRow)}, live members = ${await liveCount(second.groupId)}`,
    );

    const secondRow = (await liveRowsOf(invitee.id))[0];
    const successorId = secondRow?.id ?? randomUUID();
    const handed = await tap(async () => ((await asUser(second.leader, () => transferLeadership({ memberId: successorId }))) ? "handed" : "refused"));
    const exLeaves = await tap(() => asUser(second.leader, () => api.leaveFund()));
    const [newLeader] = await fixtureSql<{ role: string }[]>`select role from group_members where id = ${successorId}`;
    assert(
      next("A leader who handed the fund over leaves like any member, and the fund goes on with its new leader"),
      handed === "handed" &&
        exLeaves === "left" &&
        (await liveRowsOf(second.leader.id)).length === 0 &&
        newLeader?.role === "leader" &&
        (await liveCount(second.groupId)) === 1,
      `handed = ${handed}, leave = ${exLeaves}, new leader role = ${newLeader?.role}, live members = ${await liveCount(second.groupId)}`,
    );

    // Nothing to leave.
    const rowsBefore = JSON.stringify(await readGroupMembers(groupId));
    const nowhere = await tap(() => asUser(stranger, () => api.leaveFund()));
    assert(
      next("A person in no fund who asks to leave is told notInFund and no member row of any fund moves"),
      nowhere === "notInFund" && JSON.stringify(await readGroupMembers(groupId)) === rowsBefore,
      `answer = ${nowhere}`,
    );
  } finally {
    for (const id of groupIds) {
      for (const row of await fixtureSql<{ id: string }[]>`select id from group_members where group_id = ${id}`) track("group_members", row.id);
      for (const row of await fixtureSql<{ id: string }[]>`select id from categories where group_id = ${id}`) track("categories", row.id);
      for (const row of await fixtureSql<{ id: string }[]>`select id from accounts where group_id = ${id}`) track("accounts", row.id);
    }
  }
}

// Q32 (a): a leader alone in their own fund accepts an invitation to another. Their fund is archived (their
// leader row, since a group has no archive column, so it keeps no live member) and their personal accounts
// come with them. Anyone else in the fund, live or invited, keeps the answer otherFund and moves nothing.
async function loneLeaderAcceptsSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const api = await invitationApi();
  const groupIds: string[] = [];
  let failureFunction: string | null = null;

  type Row = { id: string; user_id: string | null; invite_state: string; role: string; archived_at: string | null; group_id: string };
  const rowOf = async (id: string): Promise<Row | undefined> =>
    (
      await fixtureSql<Row[]>`
        select id, user_id, invite_state, role, archived_at::text as archived_at, group_id from group_members where id = ${id}`
    )[0];
  const leaderRowOf = async (groupId: string): Promise<Row | undefined> =>
    (
      await fixtureSql<Row[]>`
        select id, user_id, invite_state, role, archived_at::text as archived_at, group_id
        from group_members where group_id = ${groupId} and role = 'leader'`
    )[0];
  const liveRowsOf = (userId: string) =>
    fixtureSql<{ id: string; group_id: string }[]>`
      select id, group_id from group_members where user_id = ${userId} and archived_at is null`;
  const liveCount = async (groupId: string): Promise<number> =>
    Number(
      (
        await fixtureSql<{ n: string }[]>`
          select count(*)::text as n from group_members where group_id = ${groupId} and user_id is not null and archived_at is null`
      )[0].n,
    );
  const openFund = async (label: string) => {
    const leader = await createMembershipFreeUser();
    const { groupId } = await asUser(leader, () =>
      createGroup({ name: `Harness fondo ${label} ${tag}`, leaderName: `Harness lider ${label}`, cashMode: "shared", locale: "es" }),
    );
    track("groups", groupId);
    groupIds.push(groupId);
    return { leader, groupId };
  };
  const invite = async (fund: { leader: HarnessUser; groupId: string }, who: HarnessUser, name: string): Promise<string> => {
    const memberId = randomUUID();
    await seedPendingInvite({ groupId: fund.groupId, memberId, actorId: fund.leader.id, name, email: who.email, archived: false });
    return memberId;
  };
  const personalMovement = async (owner: HarnessUser): Promise<{ accountId: string; transactionId: string }> =>
    asUser(owner, async () => {
      const { accountId } = await createAccount({
        name: `Harness propia lider ${tag}`,
        kind: "asset",
        subtype: "bank",
        ownerUserId: owner.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor: 1_000_000,
        balanceOn: shiftDate(today, -10),
      });
      track("accounts", accountId);
      const { categoryId } = await createCategory({
        scope: { ownerUserId: owner.id },
        name: `Harness propia lider gasto ${tag}`,
        kind: "expense",
        parentId: null,
        color: "#0E7490",
      });
      track("categories", categoryId);
      const { transactionId } = await createTransaction({
        fromAccountId: accountId,
        toAccountId: null,
        amountCents: 10_000,
        currency: "COP",
        counterAmountCents: null,
        counterIsEstimate: false,
        occurredAt: shiftDate(today, -1),
        description: `Harness propio lider ${tag}`,
        externalRef: null,
        splits: [{ categoryId, amountCents: 10_000 }],
        labelIds: [],
      });
      track("transactions", transactionId);
      return { accountId, transactionId };
    });
  const accountIds = (who: HarnessUser) => asUser(who, async () => (await listAccounts({ archived: false })).map((a) => a.id));
  const sees = (who: HarnessUser, transactionId: string) =>
    asUser(who, async () => (await getTransactionById(transactionId)) !== null);

  try {
    // Alone, the leader accepts.
    const target = await openFund("destino");
    const alone = await openFund("sola");
    const aloneOldRow = await leaderRowOf(alone.groupId);
    const own = await personalMovement(alone.leader);
    const inviteId = await invite(target, alone.leader, "Harness lider sola invitada");
    const targetSawBefore = (await accountIds(target.leader)).includes(own.accountId);
    const accepted = await tap(() => asUser(alone.leader, () => api.acceptInvitation({ memberId: inviteId })));
    const oldRow = await rowOf(aloneOldRow?.id ?? randomUUID());
    const joined = await rowOf(inviteId);
    const live = await liveRowsOf(alone.leader.id);
    assert(
      next("A leader alone in their own fund who accepts an invitation to another is answered accepted"),
      aloneOldRow?.role === "leader" && aloneOldRow.archived_at === null && accepted === "accepted",
      `answer = ${accepted}`,
    );
    assert(
      next("Their old leader row is archived, not deleted: the same row, still theirs, with an archive stamp"),
      accepted === "accepted" && oldRow?.archived_at !== null && oldRow?.user_id === alone.leader.id && oldRow.role === "leader",
      `answer = ${accepted}, old row = ${JSON.stringify(oldRow)}`,
    );
    assert(
      next("They are a live member of the new fund through the invitation row, and of no other: one live membership"),
      accepted === "accepted" &&
        joined?.invite_state === "accepted" &&
        joined.user_id === alone.leader.id &&
        joined.archived_at === null &&
        joined.role === "member" &&
        live.length === 1 &&
        live[0].group_id === target.groupId,
      `answer = ${accepted}, joined = ${JSON.stringify(joined)}, live = ${JSON.stringify(live)}`,
    );
    const targetAccounts = await accountIds(target.leader);
    assert(
      next("Their personal accounts come with them: the new fund's leader, who could not read them before, now lists the account and reads its movement"),
      !targetSawBefore &&
        accepted === "accepted" &&
        targetAccounts.includes(own.accountId) &&
        (await sees(target.leader, own.transactionId)) &&
        (await accountIds(alone.leader)).includes(own.accountId),
      `before = ${targetSawBefore}, answer = ${accepted}, leader lists it = ${targetAccounts.includes(own.accountId)}`,
    );
    assert(
      next("The old fund is left with no live member, and the new fund counts the newcomer"),
      accepted === "accepted" && (await liveCount(alone.groupId)) === 0 && (await liveCount(target.groupId)) === 2,
      `answer = ${accepted}, old fund live = ${await liveCount(alone.groupId)}, new fund live = ${await liveCount(target.groupId)}`,
    );

    // Atomic: a join that fails takes the archive with it.
    const failing = await openFund("falla");
    const failTarget = await openFund("destino falla");
    const failInvite = await invite(failTarget, failing.leader, "Harness lider falla");
    const failingLeaderRow = await leaderRowOf(failing.groupId);
    failureFunction = `harness_m81_fail_${tag.replace(/-/g, "")}`;
    await fixtureSql.unsafe(
      `create function finances.${failureFunction}() returns trigger language plpgsql as $f$ begin raise exception 'm81 injected join failure'; end $f$`,
    );
    await fixtureSql.unsafe(
      `create trigger ${failureFunction} before update on finances.group_members for each row when (new.id = '${failInvite}' and new.user_id is not null) execute function finances.${failureFunction}()`,
    );
    const failed = await tap(() => asUser(failing.leader, () => api.acceptInvitation({ memberId: failInvite })));
    const failedOld = await rowOf(failingLeaderRow?.id ?? randomUUID());
    const failedInvite = await rowOf(failInvite);
    const failedLive = await liveRowsOf(failing.leader.id);
    assert(
      next("When joining the new fund fails the old leader row is not archived (a lone leader is never told otherFund): still live in their own fund, the invitation still pending"),
      failed !== "accepted" &&
        failed !== "otherFund" &&
        failedOld?.archived_at === null &&
        failedInvite?.user_id === null &&
        failedInvite.invite_state === "pending" &&
        failedLive.length === 1 &&
        failedLive[0].group_id === failing.groupId,
      `answer = ${failed}, old row = ${JSON.stringify(failedOld)}, invitation = ${JSON.stringify(failedInvite)}, live = ${JSON.stringify(failedLive)}`,
    );
    await fixtureSql.unsafe(`drop trigger if exists ${failureFunction} on finances.group_members`);
    await fixtureSql.unsafe(`drop function if exists finances.${failureFunction}()`);
    failureFunction = null;

    // Not alone: another live member.
    const crowded = await openFund("con miembro");
    await seedFellowMember(crowded.leader.id, crowded.groupId);
    const crowdedTarget = await openFund("destino 2");
    const crowdedInvite = await invite(crowdedTarget, crowded.leader, "Harness lider acompanada");
    const crowdedRow = await leaderRowOf(crowded.groupId);
    const crowdedLiveBefore = await liveCount(crowded.groupId);
    const crowdedAnswer = await tap(() => asUser(crowded.leader, () => api.acceptInvitation({ memberId: crowdedInvite })));
    const crowdedAfter = await leaderRowOf(crowded.groupId);
    assert(
      next("A leader whose fund has another live member is still refused as otherFund and nothing is archived"),
      crowdedAnswer === "otherFund" &&
        crowdedAfter?.archived_at === null &&
        crowdedRow?.archived_at === null &&
        (await liveCount(crowded.groupId)) === crowdedLiveBefore &&
        (await rowOf(crowdedInvite))?.user_id === null,
      `answer = ${crowdedAnswer}, leader row = ${JSON.stringify(crowdedAfter)}, live ${crowdedLiveBefore} -> ${await liveCount(crowded.groupId)}`,
    );

    // Not alone: someone is invited.
    const waiting = await openFund("con invitada");
    const someoneElse = await createMembershipFreeUser();
    await invite(waiting, someoneElse, "Harness invitada espera");
    const waitingTarget = await openFund("destino 3");
    const waitingInvite = await invite(waitingTarget, waiting.leader, "Harness lider con invitada");
    const waitingAnswer = await tap(() => asUser(waiting.leader, () => api.acceptInvitation({ memberId: waitingInvite })));
    const waitingRow = await leaderRowOf(waiting.groupId);
    assert(
      next("A leader whose fund has a pending invitation is not alone: otherFund, the leader row stays live, the invitation to the other fund stays pending"),
      waitingAnswer === "otherFund" &&
        waitingRow?.archived_at === null &&
        (await rowOf(waitingInvite))?.user_id === null &&
        (await liveRowsOf(waiting.leader.id)).length === 1,
      `answer = ${waitingAnswer}, leader row = ${JSON.stringify(waitingRow)}`,
    );

    // A plain member of a fund with others.
    const home = await openFund("miembros");
    const member = await seedFellowMember(home.leader.id, home.groupId);
    const memberTarget = await openFund("destino 4");
    const memberInvite = await invite(memberTarget, member, "Harness miembra invitada");
    const memberAnswer = await tap(() => asUser(member, () => api.acceptInvitation({ memberId: memberInvite })));
    const memberLive = await liveRowsOf(member.id);
    assert(
      next("A plain member of a fund with others is refused as otherFund: still a live member of their fund, the invitation stays pending"),
      memberAnswer === "otherFund" &&
        memberLive.length === 1 &&
        memberLive[0].group_id === home.groupId &&
        (await rowOf(memberInvite))?.user_id === null &&
        (await liveCount(home.groupId)) === 2,
      `answer = ${memberAnswer}, live = ${JSON.stringify(memberLive)}`,
    );
  } finally {
    if (failureFunction) {
      await fixtureSql.unsafe(`drop trigger if exists ${failureFunction} on finances.group_members`);
      await fixtureSql.unsafe(`drop function if exists finances.${failureFunction}()`);
    }
    for (const id of groupIds) {
      for (const row of await fixtureSql<{ id: string }[]>`select id from group_members where group_id = ${id}`) track("group_members", row.id);
      for (const row of await fixtureSql<{ id: string }[]>`select id from categories where group_id = ${id}`) track("categories", row.id);
      for (const row of await fixtureSql<{ id: string }[]>`select id from accounts where group_id = ${id}`) track("accounts", row.id);
    }
  }
}

// M49 (RF-31): the occurrence that falls on `ends_on` is the rule's last and books; and a rule the run
// skipped after the lock (its date moved past today by someone else) is not written at all.
async function recurringEndsOnSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const user = await createMembershipFreeUser();
  const { accountId } = await asUser(user, () =>
    createAccount({
      name: `Harness m82 ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: user.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 100_000_000,
      balanceOn: shiftDate(today, -40),
    }),
  );
  track("accounts", accountId);
  const { categoryId } = await asUser(user, () =>
    createCategory({ scope: { ownerUserId: user.id }, name: `Harness m82 ${tag}`, kind: "expense", parentId: null, color: "#0E7490" }),
  );
  track("categories", categoryId);
  const makeRule = async (dueIn: number, endsIn: number | null): Promise<string> => {
    const { recurringRuleId } = await asUser(user, () =>
      createRecurringRule({
        fromAccountId: accountId,
        toAccountId: null,
        amountCents: 1_000,
        categoryId,
        description: `m82 ${tag}`,
        frequency: "weekly",
        intervalN: 1,
        dayOfMonth: null,
        nextRunOn: shiftDate(today, dueIn),
        endsOn: endsIn === null ? null : shiftDate(today, endsIn),
      }),
    );
    keep("recurring_rules", recurringRuleId);
    return recurringRuleId;
  };
  const bookedDays = async (id: string): Promise<string[]> => {
    const rows = await fixtureSql<{ id: string; day: string }[]>`
      select id, occurred_at::text as day from transactions where recurring_rule_id = ${id} order by occurred_at`;
    for (const r of rows) keep("transactions", r.id);
    return rows.map((r) => r.day);
  };
  const row = async (label: string, body: () => Promise<{ ok: boolean; detail: string }>): Promise<void> => {
    try {
      const verdict = await body();
      assert(next(label), verdict.ok, verdict.detail);
    } catch (error) {
      assert(next(label), false, refusal(error));
    }
  };

  await row("A weekly rule whose last occurrence falls exactly on ends_on books it, then ends: nothing after ends_on is booked", async () => {
    const id = await makeRule(-14, -7);
    await fixtureSql`select private.run_due_recurring_rules(${user.id}::uuid)`;
    const days = await bookedDays(id);
    const [after] = await fixtureSql<{ is_active: boolean }[]>`select is_active from recurring_rules where id = ${id}`;
    const expected = [shiftDate(today, -14), shiftDate(today, -7)];
    return {
      ok: JSON.stringify(days) === JSON.stringify(expected) && after.is_active === false,
      detail: `booked ${JSON.stringify(days)}, expected ${JSON.stringify(expected)}, is_active = ${after.is_active}`,
    };
  });

  await row("A rule the run reads as due, whose date a second connection pushes past today before the run locks it, is left untouched: no second update, no audit row", async () => {
    const id = await makeRule(-7, null);
    const moved = shiftDate(today, 21);
    const writer = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1, connection: { search_path: "finances, public" } });
    const runner = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1, connection: { search_path: "finances, public" } });
    let waited = false;
    try {
      const [{ pid }] = await runner<{ pid: number }[]>`select pg_backend_pid() as pid`;
      let release!: () => void;
      const gate = new Promise<void>((done) => (release = done));
      let held!: () => void;
      const holding = new Promise<void>((done) => (held = done));
      const hold = writer.begin(async (tx) => {
        await tx`update recurring_rules set next_run_on = ${moved} where id = ${id}`;
        held();
        await gate;
      });
      await holding;
      const running = runner`select private.run_due_recurring_rules(${user.id}::uuid)`.execute();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !waited) {
        const [w] = await fixtureSql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity where pid = ${pid} and wait_event_type = 'Lock'`;
        waited = w.n > 0;
        if (!waited) await new Promise<void>((done) => setTimeout(done, 25));
      }
      release();
      await hold;
      await running;
    } finally {
      await writer.end();
      await runner.end();
    }
    const [after] = await fixtureSql<{ next_run_on: string }[]>`select next_run_on::text as next_run_on from recurring_rules where id = ${id}`;
    const [{ n }] = await fixtureSql<{ n: number }[]>`
      select count(*)::int as n from audit_log where record_id = ${id} and action = 'UPDATE'`;
    return {
      ok: waited && after.next_run_on === moved && n === 1 && (await bookedDays(id)).length === 0,
      detail: `run waited = ${waited}, next_run_on = ${after.next_run_on} (expected ${moved}), UPDATE audit rows = ${n} (expected 1: the second connection's)`,
    };
  });
}

// M68 (RF-154): a leader whose only fellow member has left is alone, so she accepts an invitation to another
// fund. The member's archived row is not company.
async function leaderWhoseMemberLeftSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const api = await invitationApi();
  const leader = await createMembershipFreeUser();
  const target = await createMembershipFreeUser();
  const { groupId } = await asUser(leader, () =>
    createGroup({ name: `Harness fondo quedo ${tag}`, leaderName: "Harness lider quedo", cashMode: "shared", locale: "es" }),
  );
  track("groups", groupId);
  const targetFund = await asUser(target, () =>
    createGroup({ name: `Harness fondo destino quedo ${tag}`, leaderName: "Harness destino quedo", cashMode: "shared", locale: "es" }),
  );
  track("groups", targetFund.groupId);
  const left = await seedFellowMember(leader.id, groupId);
  await fixtureSql`update group_members set archived_at = now() where group_id = ${groupId} and user_id = ${left.id}`;
  const memberId = randomUUID();
  await seedPendingInvite({
    groupId: targetFund.groupId,
    memberId,
    actorId: target.id,
    name: "Harness lider quedo invitada",
    email: leader.email,
    archived: false,
  });
  const answer = await tap(() => asUser(leader, () => api.acceptInvitation({ memberId })));
  const [joined] = await fixtureSql<{ user_id: string | null; invite_state: string }[]>`
    select user_id, invite_state from group_members where id = ${memberId}`;
  const [oldLeader] = await fixtureSql<{ archived_at: string | null }[]>`
    select archived_at::text as archived_at from group_members where group_id = ${groupId} and role = 'leader'`;
  for (const id of [groupId, targetFund.groupId]) {
    for (const r of await fixtureSql<{ id: string }[]>`select id from group_members where group_id = ${id}`) track("group_members", r.id);
    for (const r of await fixtureSql<{ id: string }[]>`select id from categories where group_id = ${id}`) track("categories", r.id);
    for (const r of await fixtureSql<{ id: string }[]>`select id from accounts where group_id = ${id}`) track("accounts", r.id);
  }
  assert(
    next("A leader whose only fellow member left (archived row) is alone: she accepts an invitation to another fund, joins it and archives her leader row"),
    answer === "accepted" && joined?.user_id === leader.id && joined.invite_state === "accepted" && oldLeader?.archived_at !== null,
    `answer = ${answer}, joined = ${JSON.stringify(joined)}, old leader row = ${JSON.stringify(oldLeader)}`,
  );
}

// RF-123 on the accounts screen: the pending foreign estimates listed are the live asset accounts' alone.
async function pendingAssetSettlementsScopeSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const user = await createMembershipFreeUser();
  await asUser(user, async () => {
    const { categoryId } = await createCategory({
      scope: { ownerUserId: user.id },
      name: `Harness m82 estimado ${tag}`,
      kind: "expense",
      parentId: null,
      color: "#0E7490",
    });
    track("categories", categoryId);
    const open = async (kind: "asset" | "liability", label: string): Promise<string> => {
      const { accountId } = await createAccount({
        name: `Harness m82 ${label} ${tag}`,
        kind,
        subtype: kind === "asset" ? "bank" : "card",
        ownerUserId: user.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor: kind === "asset" ? 100_000_000 : 1_000_000,
        balanceOn: shiftDate(today, -40),
      });
      track("accounts", accountId);
      return accountId;
    };
    const estimate = async (accountId: string, label: string): Promise<string> => {
      const created = await createTransaction({
        fromAccountId: accountId,
        toAccountId: null,
        amountCents: 10_000,
        currency: "USD",
        counterAmountCents: 40_000_000,
        counterIsEstimate: true,
        occurredAt: shiftDate(today, -2),
        description: `m82 ${tag} ${label}`,
        externalRef: null,
        splits: [{ categoryId, amountCents: 10_000 }],
        labelIds: [],
      });
      track("transactions", created.transactionId);
      return created.transactionId;
    };
    const live = await open("asset", "viva");
    const card = await open("liability", "tarjeta");
    const closed = await open("asset", "cerrada");
    const liveEstimate = await estimate(live, "viva");
    const cardEstimate = await estimate(card, "tarjeta");
    const closedEstimate = await estimate(closed, "cerrada");
    await archiveAccount({ accountId: closed });

    const listed = (await listPendingAssetSettlements()).filter((row) => [live, card, closed].includes(row.accountId));
    assert(
      next("The accounts screen's pending estimates include a live asset account's estimate"),
      listed.some((row) => row.id === liveEstimate && row.accountId === live),
      JSON.stringify(listed),
    );
    assert(
      next("They leave out a liability's estimate: a card's estimate belongs to the debt screen"),
      !listed.some((row) => row.id === cardEstimate || row.accountId === card),
      JSON.stringify(listed),
    );
    assert(
      next("They leave out an archived asset account's estimate"),
      !listed.some((row) => row.id === closedEstimate || row.accountId === closed) && listed.length === 1,
      JSON.stringify(listed),
    );
  });
}

// RF-88 / RF-67: the dashboard names each member bucket off the fund's LIVE roster, whole: every live member,
// not the first one, and never someone who left.
async function dashboardRosterNamesSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const leader = await createMembershipFreeUser();
  const { groupId } = await asUser(leader, () =>
    createGroup({ name: `Harness fondo nombres ${tag}`, leaderName: `Harness Alfa ${tag}`, cashMode: "shared", locale: "es" }),
  );
  track("groups", groupId);
  const fellow = await seedFellowMember(leader.id, groupId);
  const gone = await seedFellowMember(leader.id, groupId);
  await fixtureSql`update group_members set name = ${`Harness Zeta ${tag}`} where group_id = ${groupId} and user_id = ${fellow.id}`;
  await fixtureSql`update group_members set name = ${`Harness Beta fuera ${tag}`} where group_id = ${groupId} and user_id = ${gone.id}`;
  for (const person of [leader, fellow, gone]) {
    const accountId = randomUUID();
    await fixtureSql`
      insert into accounts (id, owner_user_id, name, kind, subtype, initial_balance_cents, initial_balance_on)
      values (${accountId}, ${person.id}, ${`Harness cuenta nombres ${tag}`}, 'asset', 'bank', 1000, current_date)`;
    track("accounts", accountId);
  }
  await fixtureSql`update group_members set archived_at = now() where group_id = ${groupId} and user_id = ${gone.id}`;
  // The fellow left once under another name and came back: the old row stays, archived, and sorts after the live one.
  await fixtureSql`
    insert into group_members (group_id, user_id, name, role, archived_at)
    values (${groupId}, ${fellow.id}, ${`Harness Zz antiguo ${tag}`}, 'member', now())`;
  for (const r of await fixtureSql<{ id: string }[]>`select id from group_members where group_id = ${groupId}`) track("group_members", r.id);
  for (const r of await fixtureSql<{ id: string }[]>`select id from categories where group_id = ${groupId}`) track("categories", r.id);

  const data = await asUser(leader, () => getDashboardData());
  const nameOf = (userId: string) => data.netWorth.find((b) => b.ownerUserId === userId);
  const shown = JSON.stringify(data.netWorth.map((b) => [b.bucket, b.name, b.isSelf]));
  assert(
    next("The dashboard names a live member other than the first by name, and the caller's own bucket by theirs"),
    nameOf(fellow.id)?.name === `Harness Zeta ${tag}` && nameOf(leader.id)?.name === `Harness Alfa ${tag}`,
    shown,
  );
  assert(
    next("The dashboard names no member who left the fund"),
    nameOf(gone.id) === undefined || nameOf(gone.id)?.name === null,
    shown,
  );
}

// RF-51, RF-52, RF-45, RNF-15: a re-imported file costs the same statements for one updated row as for fifty, every
// updated row lands and is audited, a failing row takes the whole file back, and a second commit of the same file racing
// the first is refused with a typed error the action words, leaving one copy.
async function importCommitSetSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const pesos = (cents: number) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
  const empty = (): CommitInput => ({
    members: [],
    categories: [],
    accounts: [],
    recurringRules: [],
    transactions: [],
    adjustments: [],
  });

  // Read off the module at run time: the class is the contract, and a module that does not export it yet is a red row,
  // not a run that cannot start.
  const typedClass = (importCommitModule as unknown as Record<string, unknown>).ImportAlreadyCommitting;
  const isTyped = (error: unknown): boolean =>
    typeof typedClass === "function" && error instanceof (typedClass as abstract new (...args: never[]) => unknown);
  // Looser on purpose, for the row that must NOT be typed: a same-named class anywhere on the chain counts as typed.
  const looksTyped = (error: unknown): boolean => {
    let current: unknown = error;
    for (let hop = 0; hop < 5 && typeof current === "object" && current !== null; hop++) {
      if (isTyped(current)) return true;
      const named = current as { name?: unknown; constructor?: { name?: unknown } };
      if (named.name === "ImportAlreadyCommitting" || named.constructor?.name === "ImportAlreadyCommitting") return true;
      current = "cause" in current ? (current as { cause: unknown }).cause : undefined;
    }
    return false;
  };
  const describe = (error: unknown) =>
    `${(error as { constructor?: { name?: string } })?.constructor?.name ?? typeof error}: ${refusal(error)}`;

  type Outcome = { ok: true } | { ok: false; error: unknown };
  // No `asUser` inside: a race runs both commits under one identity, set once around the pair.
  const commitRaw = async (userId: string, input: CommitInput, groupId: string | null = null): Promise<Outcome> => {
    try {
      await withUserDb((tx) => commitImport(tx, input, { userId, groupId }));
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  };
  const commitAs = (user: HarnessUser, input: CommitInput, groupId: string | null = null) =>
    asUser(user, () => commitRaw(user.id, input, groupId));
  const measured = async (user: HarnessUser, input: CommitInput, groupId: string | null = null) => {
    const before = roundTrips();
    const outcome = await commitAs(user, input, groupId);
    return { trips: roundTrips() - before, outcome };
  };
  const said = (outcome: Outcome) => (outcome.ok ? "ok" : `threw ${describe(outcome.error)}`);
  const auditMark = async () =>
    (await fixtureSql<{ id: string }[]>`select coalesce(max(id), 0)::text as id from audit_log`)[0].id;
  const updatesSince = async (mark: string, entity: string, ids: string[]) =>
    new Map(
      (
        await fixtureSql<{ record_id: string; n: number }[]>`
          select record_id, count(*)::int as n from audit_log
          where id > ${mark}::bigint and entity = ${entity} and action = 'UPDATE' and record_id in ${fixtureSql(ids)}
          group by record_id`
      ).map((r) => [r.record_id, r.n]),
    );

  // ---- Fifty movements of one person, each with a key and one split.
  const owner = await createMembershipFreeUser();
  const fixture = await asUser(owner, async () => {
    const categoryIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { categoryId } = await createCategory({
        scope: { ownerUserId: owner.id },
        name: `Harness m3 categoria ${i} ${tag}`,
        kind: "expense",
        parentId: null,
        color: CATEGORY_COLORS[i],
      });
      track("categories", categoryId);
      categoryIds.push(categoryId);
    }
    const { accountId: bank } = await createAccount({
      name: `Harness m3 banco ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: owner.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 900_000_000,
      balanceOn: shiftDate(today, -60),
    });
    track("accounts", bank);
    const ids: string[] = [];
    const refs: string[] = [];
    for (let i = 0; i < 50; i++) {
      const ref = `m3-${tag}-t${i}`;
      const { transactionId } = await createTransaction({
        fromAccountId: bank,
        toAccountId: null,
        amountCents: 10_000 + i,
        occurredAt: shiftDate(today, -40),
        description: `m3 ${tag} antes ${i}`,
        externalRef: ref,
        splits: [{ categoryId: categoryIds[0], amountCents: 10_000 + i }],
        labelIds: [],
      });
      track("transactions", transactionId);
      ids.push(transactionId);
      refs.push(ref);
    }
    return { categoryIds, bank, ids, refs };
  });
  const { categoryIds, bank, ids, refs } = fixture;

  type Wanted = { amount: number; date: string; description: string; splits: { categoryId: string; amount: number }[] };
  const updated = (i: number, wanted: Wanted): CommitInput["transactions"][number] => ({
    status: "update",
    index: i,
    sheetRow: i + 2,
    externalRef: refs[i],
    placeholderId: null,
    object: {
      fromAccountId: bank,
      toAccountId: null,
      amount: pesos(wanted.amount),
      occurredAt: wanted.date,
      description: wanted.description,
      externalRef: refs[i],
      splits: wanted.splits.map((s) => ({ categoryId: s.categoryId, amount: pesos(s.amount) })),
      labelIds: [],
    },
  });
  // Every row moves to its own amount, day and words, so a column read off its neighbour cannot pass.
  const finalOf = (i: number): Wanted => {
    const amount = 50_000 + i * 101;
    return {
      amount,
      date: shiftDate(today, -1 - (i % 20)),
      description: `m3 ${tag} despues ${i}`,
      splits:
        i === 0
          ? [
              { categoryId: categoryIds[1], amount: amount - 1_234 },
              { categoryId: categoryIds[2], amount: 1_234 },
            ]
          : [{ categoryId: categoryIds[1], amount }],
    };
  };

  const one = await measured(owner, {
    ...empty(),
    transactions: [
      updated(0, {
        amount: 20_000,
        date: shiftDate(today, -30),
        description: `m3 ${tag} uno`,
        splits: [{ categoryId: categoryIds[2], amount: 20_000 }],
      }),
    ],
  });
  const mark = await auditMark();
  const fifty = await measured(owner, {
    ...empty(),
    transactions: ids.map((_, i) => updated(i, finalOf(i))),
  });
  assert(
    next("Committing fifty updated movements costs the round trips one updated movement costs (RNF-15)"),
    one.outcome.ok && fifty.outcome.ok && fifty.trips === one.trips,
    `one: ${said(one.outcome)} in ${one.trips} round trips; fifty: ${said(fifty.outcome)} in ${fifty.trips}`,
  );

  const stored = await fixtureSql<{ id: string; amount_cents: number; occurred_at: string; description: string | null }[]>`
    select id, amount_cents::int as amount_cents, occurred_at::text as occurred_at, description
    from transactions where id in ${fixtureSql(ids)}`;
  const storedById = new Map(stored.map((r) => [r.id, r]));
  const wrongValues = ids
    .map((id, i) => ({ i, row: storedById.get(id), want: finalOf(i) }))
    .filter(
      ({ row, want }) =>
        !row || row.amount_cents !== want.amount || row.occurred_at !== want.date || row.description !== want.description,
    );
  assert(
    next("Each of the fifty updated movements reads its own new amount, day and description (RF-52)"),
    fifty.outcome.ok && wrongValues.length === 0,
    `${said(fifty.outcome)}; ${wrongValues.length} wrong${
      wrongValues.length > 0
        ? `, first row ${wrongValues[0].i}: stored ${JSON.stringify(wrongValues[0].row)}, wanted ${JSON.stringify({ amount: wrongValues[0].want.amount, date: wrongValues[0].want.date, description: wrongValues[0].want.description })}`
        : ""
    }`,
  );

  const splitRows = await fixtureSql<{ transaction_id: string; category_id: string; amount_cents: number }[]>`
    select transaction_id, category_id, amount_cents::int as amount_cents
    from transaction_splits where transaction_id in ${fixtureSql(ids)}`;
  const splitsOf = (id: string) =>
    splitRows
      .filter((s) => s.transaction_id === id)
      .map((s) => `${s.category_id}:${s.amount_cents}`)
      .sort();
  const wantSplits = (i: number) => finalOf(i).splits.map((s) => `${s.categoryId}:${s.amount}`).sort();
  const wrongSplits = ids.filter((id, i) => JSON.stringify(splitsOf(id)) !== JSON.stringify(wantSplits(i)));
  assert(
    next("An updated movement given two new splits reads exactly those two, and every other one exactly its new one"),
    fifty.outcome.ok && wrongSplits.length === 0,
    `${said(fifty.outcome)}; row 0 reads [${splitsOf(ids[0])}], wanted [${wantSplits(0)}]; ${wrongSplits.length} rows wrong`,
  );

  const audited = await updatesSince(mark, "transactions", ids);
  const misAudited = ids.filter((id) => audited.get(id) !== 1);
  assert(
    next("The fifty-row commit leaves one audit_log UPDATE row for each of the fifty movements (RF-45)"),
    fifty.outcome.ok && misAudited.length === 0 && audited.size === 50,
    `${said(fifty.outcome)}; ${audited.size} movements audited, ${misAudited.length} without exactly one UPDATE row (first: ${
      misAudited[0] ? `${misAudited[0]} with ${audited.get(misAudited[0]) ?? 0}` : "none"
    })`,
  );

  // ---- Every other kind: three of each, keyed, then updated one and three at a time.
  const placeholderOf = (i: number) => `00000000-0000-4000-8000-${String(900 + i).padStart(12, "0")}`;
  const categoryRef = (i: number) => `m3-${tag}-c${i}`;
  const accountRef = (i: number) => `m3-${tag}-a${i}`;
  const ruleRef = (i: number) => `m3-${tag}-r${i}`;
  const memberRef = (i: number) => `m3-${tag}-m${i}`;
  const nextRun = shiftDate(today, 10);
  const dayOfMonth = Number(nextRun.slice(8, 10));
  const categoryRow = (i: number, status: "new" | "update", name: string): CommitInput["categories"][number] => ({
    status,
    index: i,
    sheetRow: i + 2,
    externalRef: categoryRef(i),
    placeholderId: status === "new" ? placeholderOf(i) : null,
    object: { name, kind: "expense", parentId: null, color: CATEGORY_COLORS[i] },
  });
  const accountRow = (i: number, status: "new" | "update", name: string): CommitInput["accounts"][number] => ({
    status,
    index: i,
    sheetRow: i + 2,
    externalRef: accountRef(i),
    placeholderId: status === "new" ? placeholderOf(10 + i) : null,
    object: {
      name,
      kind: "asset",
      subtype: "bank",
      placement: "personal",
      institution: null,
      settlementCurrency: "COP",
      amount: pesos(1_000_000 + i),
      balanceOn: shiftDate(today, -20),
    },
  });
  const ruleRow = (
    i: number,
    status: "new" | "update",
    description: string,
    accountId: string,
    categoryId: string,
  ): CommitInput["recurringRules"][number] => ({
    status,
    index: i,
    sheetRow: i + 2,
    externalRef: ruleRef(i),
    placeholderId: null,
    object: {
      fromAccountId: accountId,
      toAccountId: null,
      amount: pesos(30_000 + i),
      categoryId,
      description,
      frequency: "monthly",
      intervalN: 1,
      dayOfMonth,
      nextRunOn: nextRun,
      endsOn: null,
    },
  });
  const memberRow = (i: number, status: "new" | "update", name: string): CommitInput["members"][number] => ({
    status,
    index: i,
    sheetRow: i + 2,
    externalRef: memberRef(i),
    placeholderId: null,
    object: { name, email: undefined },
  });

  const keeper = await createMembershipFreeUser();
  const seeded = await commitAs(keeper, {
    ...empty(),
    categories: [0, 1, 2].map((i) => categoryRow(i, "new", `Harness m3 cat ${i} ${tag}`)),
    accounts: [0, 1, 2].map((i) => accountRow(i, "new", `Harness m3 cuenta ${i} ${tag}`)),
    recurringRules: [0, 1, 2].map((i) =>
      ruleRow(i, "new", `m3 ${tag} regla ${i}`, placeholderOf(10 + i), placeholderOf(i)),
    ),
  });
  const keyed = async (table: "categories" | "accounts" | "recurring_rules", ref: (i: number) => string) => {
    const rows = await fixtureSql<{ id: string; external_ref: string }[]>`
      select id, external_ref from ${fixtureSql(table)}
      where owner_user_id = ${keeper.id} and external_ref in ${fixtureSql([0, 1, 2].map(ref))}`;
    for (const r of rows) track(table, r.id);
    return [0, 1, 2].map((i) => rows.find((r) => r.external_ref === ref(i))?.id ?? "");
  };
  const keptCategories = await keyed("categories", categoryRef);
  const keptAccounts = await keyed("accounts", accountRef);
  const keptRules = await keyed("recurring_rules", ruleRef);

  const leader = await createMembershipFreeUser();
  const { groupId } = await asUser(leader, () =>
    createGroup({ name: `Harness fondo m3 ${tag}`, leaderName: `Harness m3 lider ${tag}`, cashMode: "shared", locale: "es" }),
  );
  track("groups", groupId);
  const seededMembers = await commitAs(
    leader,
    { ...empty(), members: [0, 1, 2].map((i) => memberRow(i, "new", `Harness m3 miembro ${i} ${tag}`)) },
    groupId,
  );
  const memberRows = await fixtureSql<{ id: string; external_ref: string }[]>`
    select id, external_ref from group_members where group_id = ${groupId} and external_ref is not null`;
  for (const r of memberRows) track("group_members", r.id);
  const keptMembers = [0, 1, 2].map((i) => memberRows.find((r) => r.external_ref === memberRef(i))?.id ?? "");
  for (const r of await fixtureSql<{ id: string }[]>`select id from categories where group_id = ${groupId}`) track("categories", r.id);

  const kinds: {
    kind: string;
    entity: string;
    user: HarnessUser;
    groupId: string | null;
    ids: string[];
    input: (rows: number[], round: string) => CommitInput;
    read: () => Promise<Map<string, string | null>>;
    nameOf: (i: number, round: string) => string;
  }[] = [
    {
      kind: "member",
      entity: "group_members",
      user: leader,
      groupId,
      ids: keptMembers,
      nameOf: (i, round) => `Harness m3 miembro ${round} ${i} ${tag}`,
      input: (rows, round) => ({ ...empty(), members: rows.map((i) => memberRow(i, "update", `Harness m3 miembro ${round} ${i} ${tag}`)) }),
      read: async () =>
        new Map(
          (await fixtureSql<{ id: string; name: string }[]>`select id, name from group_members where id in ${fixtureSql(keptMembers)}`).map(
            (r) => [r.id, r.name],
          ),
        ),
    },
    {
      kind: "category",
      entity: "categories",
      user: keeper,
      groupId: null,
      ids: keptCategories,
      nameOf: (i, round) => `Harness m3 cat ${round} ${i} ${tag}`,
      input: (rows, round) => ({ ...empty(), categories: rows.map((i) => categoryRow(i, "update", `Harness m3 cat ${round} ${i} ${tag}`)) }),
      read: async () =>
        new Map(
          (await fixtureSql<{ id: string; name: string }[]>`select id, name from categories where id in ${fixtureSql(keptCategories)}`).map(
            (r) => [r.id, r.name],
          ),
        ),
    },
    {
      kind: "account",
      entity: "accounts",
      user: keeper,
      groupId: null,
      ids: keptAccounts,
      nameOf: (i, round) => `Harness m3 cuenta ${round} ${i} ${tag}`,
      input: (rows, round) => ({ ...empty(), accounts: rows.map((i) => accountRow(i, "update", `Harness m3 cuenta ${round} ${i} ${tag}`)) }),
      read: async () =>
        new Map(
          (await fixtureSql<{ id: string; name: string }[]>`select id, name from accounts where id in ${fixtureSql(keptAccounts)}`).map(
            (r) => [r.id, r.name],
          ),
        ),
    },
    {
      kind: "recurring rule",
      entity: "recurring_rules",
      user: keeper,
      groupId: null,
      ids: keptRules,
      nameOf: (i, round) => `m3 ${tag} regla ${round} ${i}`,
      input: (rows, round) => ({
        ...empty(),
        recurringRules: rows.map((i) => ruleRow(i, "update", `m3 ${tag} regla ${round} ${i}`, keptAccounts[i], keptCategories[i])),
      }),
      read: async () =>
        new Map(
          (
            await fixtureSql<{ id: string; description: string | null }[]>`
              select id, description from recurring_rules where id in ${fixtureSql(keptRules)}`
          ).map((r) => [r.id, r.description]),
        ),
    },
  ];

  for (const kind of kinds) {
    const oneRow = await measured(kind.user, kind.input([0], "uno"), kind.groupId);
    const kindMark = await auditMark();
    const threeRows = await measured(kind.user, kind.input([0, 1, 2], "tres"), kind.groupId);
    const names = await kind.read();
    const kindAudited = await updatesSince(kindMark, kind.entity, kind.ids.filter(Boolean));
    const seededOk = kind.kind === "member" ? seededMembers : seeded;
    assert(
      next(`Committing three updated ${kind.kind} rows costs the round trips one costs`),
      seededOk.ok && oneRow.outcome.ok && threeRows.outcome.ok && threeRows.trips === oneRow.trips,
      `seed ${said(seededOk)}; one: ${said(oneRow.outcome)} in ${oneRow.trips}; three: ${said(threeRows.outcome)} in ${threeRows.trips}`,
    );
    const wrongNames = [0, 1, 2].filter((i) => names.get(kind.ids[i]) !== kind.nameOf(i, "tres"));
    assert(
      next(`Each updated ${kind.kind} reads its new name, and each is audited once`),
      threeRows.outcome.ok &&
        kind.ids.every(Boolean) &&
        wrongNames.length === 0 &&
        kind.ids.every((id) => kindAudited.get(id) === 1),
      `${said(threeRows.outcome)}; stored [${kind.ids.map((id) => names.get(id))}]; UPDATE rows [${kind.ids.map((id) => kindAudited.get(id) ?? 0)}]`,
    );
  }

  // ---- Another error stays its own: a split naming a category that does not exist is refused as it is today
  // (the scope check, 23514), never as "already importing".
  const badCategory = randomUUID();
  const brokenRow = (i: number): CommitInput["transactions"][number] => ({
    status: "new",
    index: i,
    sheetRow: i + 2,
    externalRef: `m3-${tag}-roto-${i}`,
    placeholderId: null,
    object: {
      fromAccountId: bank,
      toAccountId: null,
      amount: pesos(7_000),
      occurredAt: today,
      description: `m3 ${tag} roto`,
      externalRef: `m3-${tag}-roto-${i}`,
      splits: [{ categoryId: badCategory, amount: pesos(7_000) }],
      labelIds: [],
    },
  });
  const broken = await commitAs(owner, { ...empty(), transactions: [brokenRow(0)] });
  const brokenFailure = (() => {
    if (broken.ok) return null;
    try {
      return JSON.parse((broken.error as Error).message) as { entity?: string; sheetRow?: number; reasonKey?: string };
    } catch {
      return null;
    }
  })();
  assert(
    next("A commit whose split names a missing category still throws its own row failure, not ImportAlreadyCommitting"),
    !broken.ok &&
      !looksTyped(broken.error) &&
      broken.error instanceof ActionError &&
      brokenFailure?.entity === "transactions" &&
      brokenFailure.sheetRow === 2 &&
      brokenFailure.reasonKey === "transactions.errors.splitsScopeViolation" &&
      pgErrorCode(broken.error) === "23514",
    `${said(broken)}; failure ${JSON.stringify(brokenFailure)}`,
  );

  // ---- All or nothing (RF-51): a new account and five updates ride with a last row that fails.
  const lostRef = `m3-${tag}-perdida`;
  const partial = await commitAs(owner, {
    ...empty(),
    accounts: [{ ...accountRow(0, "new", `Harness m3 perdida ${tag}`), externalRef: lostRef, placeholderId: null }],
    transactions: [
      ...[1, 2, 3, 4, 5].map((i) => updated(i, { ...finalOf(i), description: `m3 ${tag} nunca ${i}` })),
      brokenRow(6),
    ],
  });
  const lostAccounts = await fixtureSql<{ id: string }[]>`
    select id from accounts where owner_user_id = ${owner.id} and external_ref = ${lostRef}`;
  for (const r of lostAccounts) track("accounts", r.id);
  const afterPartial = await fixtureSql<{ description: string | null }[]>`
    select description from transactions where id in ${fixtureSql(ids.slice(1, 6))} order by external_ref`;
  assert(
    next("A commit whose last row fails leaves none of its rows: no new account, no updated movement (RF-51)"),
    !partial.ok && lostAccounts.length === 0 && afterPartial.every((r) => r.description?.includes("despues") === true),
    `${said(partial)}; ${lostAccounts.length} accounts with the new key; descriptions [${afterPartial.map((r) => r.description)}]`,
  );

  // ---- Two commits of the same file at once. A second connection holds a row the first commit needs AFTER it has
  // written the file's keyed rows, so the first sits mid-transaction; the second then writes the same keys and waits on
  // the first. Releasing the holder lets the first commit, and the second meets the unique key.
  const race = async (
    lock: (sql: postgres.TransactionSql) => Promise<unknown>,
    first: () => Promise<Outcome>,
    second: () => Promise<Outcome>,
  ) => {
    const holder = postgres(process.env.DATABASE_URL!, {
      prepare: false,
      max: 1,
      connection: { search_path: "finances, public" },
    });
    try {
      const [{ pid: holderPid }] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      let release!: () => void;
      const gate = new Promise<void>((done) => (release = done));
      let held!: () => void;
      const holding = new Promise<void>((done) => (held = done));
      const hold = holder.begin(async (sql) => {
        await lock(sql);
        held();
        await gate;
      });
      await holding;
      const blockedBy = async (pid: number) => {
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          const [w] = await fixtureSql<{ pid: number }[]>`
            select pid from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid)) limit 1`;
          if (w) return w.pid;
          await pause(25);
        }
        return null;
      };
      const firstRun = first();
      const firstPid = await blockedBy(holderPid);
      const secondRun = second();
      const secondPid = firstPid === null ? null : await blockedBy(firstPid);
      release();
      await hold;
      const [a, b] = await Promise.all([firstRun, secondRun]);
      return { firstWaited: firstPid !== null, secondWaited: secondPid !== null, a, b };
    } finally {
      await holder.end();
    }
  };
  const raceSaid = (r: Awaited<ReturnType<typeof race>>) =>
    `first waited on the holder: ${r.firstWaited}, second waited on the first: ${r.secondWaited}; first ${said(r.a)}; second ${said(r.b)}`;
  const oneOkOneTyped = (r: Awaited<ReturnType<typeof race>>) =>
    (r.a.ok && !r.b.ok && isTyped(r.b.error)) || (r.b.ok && !r.a.ok && isTyped(r.a.error));

  // A file with a new keyed account and an update of a movement the holder has locked.
  const racer = await createMembershipFreeUser();
  const racerFixture = await asUser(racer, async () => {
    const { categoryId } = await createCategory({
      scope: { ownerUserId: racer.id },
      name: `Harness m3 carrera ${tag}`,
      kind: "expense",
      parentId: null,
      color: CATEGORY_COLORS[0],
    });
    track("categories", categoryId);
    const { accountId } = await createAccount({
      name: `Harness m3 carrera banco ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: racer.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 50_000_000,
      balanceOn: shiftDate(today, -30),
    });
    track("accounts", accountId);
    const { accountId: other } = await createAccount({
      name: `Harness m3 carrera otra ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: racer.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 50_000_000,
      balanceOn: shiftDate(today, -30),
    });
    track("accounts", other);
    const { transactionId } = await createTransaction({
      fromAccountId: accountId,
      toAccountId: null,
      amountCents: 40_000,
      occurredAt: shiftDate(today, -3),
      description: `m3 ${tag} carrera antes`,
      externalRef: `m3-${tag}-carrera`,
      splits: [{ categoryId, amountCents: 40_000 }],
      labelIds: [],
    });
    track("transactions", transactionId);
    return { categoryId, accountId, other, transactionId };
  });
  const raceRef = `m3-${tag}-carrera-cuenta`;
  const raceFile: CommitInput = {
    ...empty(),
    accounts: [{ ...accountRow(0, "new", `Harness m3 carrera nueva ${tag}`), externalRef: raceRef, placeholderId: null }],
    transactions: [
      {
        status: "update",
        index: 0,
        sheetRow: 2,
        externalRef: `m3-${tag}-carrera`,
        placeholderId: null,
        object: {
          fromAccountId: racerFixture.accountId,
          toAccountId: null,
          amount: pesos(45_000),
          occurredAt: shiftDate(today, -3),
          description: `m3 ${tag} carrera despues`,
          externalRef: `m3-${tag}-carrera`,
          splits: [{ categoryId: racerFixture.categoryId, amount: pesos(45_000) }],
          labelIds: [],
        },
      },
    ],
  };
  const raced = await asUser(racer, () =>
    race(
      (sql) => sql`select id from finances.transactions where id = ${racerFixture.transactionId} for update`,
      () => commitRaw(racer.id, raceFile),
      () => commitRaw(racer.id, raceFile),
    ),
  );
  const raceCopies = await fixtureSql<{ id: string }[]>`
    select id from accounts where owner_user_id = ${racer.id} and external_ref = ${raceRef}`;
  for (const r of raceCopies) track("accounts", r.id);
  assert(
    next("Two commits of the same file racing on two connections: one lands, the other throws ImportAlreadyCommitting, and the new account exists once"),
    raced.firstWaited && raced.secondWaited && oneOkOneTyped(raced) && raceCopies.length === 1,
    `${raceSaid(raced)}; ${raceCopies.length} accounts carry the key`,
  );

  // A statement of movements alone: the keys are the movements', and the holder locks the account a later adjustment books on.
  const movementRefs = [`m3-${tag}-mov-1`, `m3-${tag}-mov-2`];
  const movementFile: CommitInput = {
    ...empty(),
    transactions: movementRefs.map((ref, i) => ({
      status: "new" as const,
      index: i,
      sheetRow: i + 2,
      externalRef: ref,
      placeholderId: null,
      object: {
        fromAccountId: racerFixture.accountId,
        toAccountId: null,
        amount: pesos(1_000 + i),
        occurredAt: shiftDate(today, -1),
        description: `m3 ${tag} extracto ${i}`,
        externalRef: ref,
        splits: [{ categoryId: racerFixture.categoryId, amount: pesos(1_000 + i) }],
        labelIds: [],
      },
    })),
    adjustments: [
      {
        status: "new",
        index: 2,
        sheetRow: 4,
        externalRef: `m3-${tag}-ajuste`,
        placeholderId: null,
        object: {
          adjustment: true,
          accountId: racerFixture.other,
          direction: "up",
          amount: pesos(5_000),
          occurredAt: today,
        },
      },
    ],
  };
  const racedMovements = await asUser(racer, () =>
    race(
      (sql) => sql`select id from finances.accounts where id = ${racerFixture.other} for update`,
      () => commitRaw(racer.id, movementFile),
      () => commitRaw(racer.id, movementFile),
    ),
  );
  const movementCopies = await fixtureSql<{ id: string; external_ref: string }[]>`
    select id, external_ref from transactions where owner_user_id = ${racer.id} and external_ref in ${fixtureSql(movementRefs)}`;
  for (const r of movementCopies) track("transactions", r.id);
  assert(
    next("Two commits of the same movements-only file racing: one lands, the other throws ImportAlreadyCommitting, and each movement exists once"),
    racedMovements.firstWaited &&
      racedMovements.secondWaited &&
      oneOkOneTyped(racedMovements) &&
      movementRefs.every((ref) => movementCopies.filter((r) => r.external_ref === ref).length === 1),
    `${raceSaid(racedMovements)}; copies [${movementRefs.map((ref) => movementCopies.filter((r) => r.external_ref === ref).length)}]`,
  );

  // ---- The action, driven with a real workbook from two tabs at once: the second tab is told why.
  const tabs = await createMembershipFreeUser();
  const tabsFixture = await asUser(tabs, async () => {
    const { categoryId } = await createCategory({
      scope: { ownerUserId: tabs.id },
      name: `Harness m3 pestanas ${tag}`,
      kind: "expense",
      parentId: null,
      color: CATEGORY_COLORS[0],
    });
    track("categories", categoryId);
    const { accountId } = await createAccount({
      name: `Harness m3 pestanas banco ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: tabs.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 50_000_000,
      balanceOn: shiftDate(today, -30),
    });
    track("accounts", accountId);
    const { transactionId } = await createTransaction({
      fromAccountId: accountId,
      toAccountId: null,
      amountCents: 40_000,
      occurredAt: shiftDate(today, -3),
      description: `m3 ${tag} pestanas antes`,
      externalRef: `m3-${tag}-pestanas`,
      splits: [{ categoryId, amountCents: 40_000 }],
      labelIds: [],
    });
    track("transactions", transactionId);
    const exported = await readExport({ entityKeys: ["accounts", "transactions"] });
    return { accountId, transactionId, exported };
  });
  const tabsRef = `m3-${tag}-pestanas-cuenta`;
  const exportedAccount = (tabsFixture.exported.accounts ?? []).find((r) => String(r.name).includes(`pestanas banco ${tag}`));
  const exportedMovement = (tabsFixture.exported.transactions ?? []).find((r) => r.externalRef === `m3-${tag}-pestanas`);
  // The harness's next-intl answers each key with itself, so the pipeline reads a tab named by its key.
  const sheetLabels = {
    sheetName: (entity: string) => `sheets.${entity}`,
    columnHeader: (key: string) => `columns.${key}`,
  };
  const workbook = buildWorkbook({
    data: {
      accounts: exportedAccount
        ? [{ ...exportedAccount, name: `Harness m3 pestanas nueva ${tag}`, externalRef: tabsRef }]
        : [],
      transactions: exportedMovement ? [{ ...exportedMovement, description: `m3 ${tag} pestanas despues` }] : [],
    },
    labels: sheetLabels,
  });
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  const tab = async (): Promise<Outcome & { answer: string }> => {
    const form = new FormData();
    form.append("file", new File([bytes], `m3-${tag}.xlsx`));
    try {
      const result = await commitImportAction(form);
      return result?.serverError === undefined
        ? { ok: true, answer: `data ${JSON.stringify(result?.data)}` }
        : { ok: false, error: new Error(result.serverError), answer: `serverError ${result.serverError}` };
    } catch (error) {
      return { ok: false, error, answer: `threw ${describe(error)}` };
    }
  };
  let answers: string[] = [];
  const racedTabs = await asUser(tabs, async () => {
    const results: (Outcome & { answer: string })[] = [];
    const r = await race(
      (sql) => sql`select id from finances.transactions where id = ${tabsFixture.transactionId} for update`,
      async () => {
        const out = await tab();
        results[0] = out;
        return out;
      },
      async () => {
        const out = await tab();
        results[1] = out;
        return out;
      },
    );
    answers = results.map((x) => x.answer);
    return r;
  });
  const tabsCopies = await fixtureSql<{ id: string }[]>`
    select id from accounts where owner_user_id = ${tabs.id} and external_ref = ${tabsRef}`;
  for (const r of tabsCopies) track("accounts", r.id);
  const okTabs = answers.filter((a) => a.startsWith("data ")).length;
  const toldWhy = answers.filter((a) => a === "serverError data.import.errors.alreadyCommitting").length;
  assert(
    next("Two tabs confirming the same workbook at once: one imports, the other answers data.import.errors.alreadyCommitting, and the file lands once"),
    Boolean(exportedAccount && exportedMovement) &&
      racedTabs.firstWaited &&
      racedTabs.secondWaited &&
      okTabs === 1 &&
      toldWhy === 1 &&
      tabsCopies.length === 1,
    `exported account ${Boolean(exportedAccount)}, movement ${Boolean(exportedMovement)}; first waited ${racedTabs.firstWaited}, second waited ${racedTabs.secondWaited}; answers [${answers.join(" | ")}]; ${tabsCopies.length} accounts carry the key`,
  );

  // ---- The words the second tab reads.
  const wordsOf = (catalogue: unknown) =>
    (catalogue as { data?: { import?: { errors?: Record<string, string> } } }).data?.import?.errors?.alreadyCommitting;
  assert(
    next("es and en say why the second tab's import was refused"),
    wordsOf(es) ===
      "Este archivo ya se estaba importando en otra pestaña. Revisa los movimientos antes de importarlo otra vez." &&
      wordsOf(en) ===
        "This file was already being imported in another tab. Check the movements before importing it again.",
    `es «${wordsOf(es)}»; en «${wordsOf(en)}»`,
  );
}

// M13 (RF-160): a parent category's budget and its movement filter count its subcategories; a
// savings goal sums only the aportes in its own currency; no two category rows a fund member sees
// draw the same text. Every figure is read back through the app's own queries.
async function parentCategorySuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const user = await createMembershipFreeUser();
  // Every read below scans the ledger the whole run has built, through the row policies, so on a database another
  // lane is loading one can cross the 8 s statement timeout (57014). A read changes nothing: it is asked again, twice
  // at most, and a read that is slow every time still fails. The timeout itself stays where it is.
  const patient = async <T>(read: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await read();
      } catch (error) {
        if (pgErrorCode(error) !== "57014" || attempt === 3) throw error;
      }
    }
  };
  const open = async (name: string, settlementCurrency: "COP" | "USD") => {
    const { accountId } = await asUser(user, () =>
      createAccount({
        name: `Harness m13 ${name} ${tag}`,
        kind: "asset",
        subtype: "bank",
        ownerUserId: user.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency,
        amountMinor: 1_000_000_000,
        balanceOn: shiftDate(today, -120),
      }),
    );
    track("accounts", accountId);
    return accountId;
  };
  const [cop, otherCop, usd] = [await open("cop", "COP"), await open("cop2", "COP"), await open("usd", "USD")];
  const category = async (name: string, parentId: string | null): Promise<string> => {
    const { categoryId } = await asUser(user, () =>
      createCategory({ scope: { ownerUserId: user.id }, name: `Harness m13 ${name} ${tag}`, kind: "expense", parentId, color: "#0E7490" }),
    );
    track("categories", categoryId);
    return categoryId;
  };
  const spend = async (from: string, splits: [string, number][], occurredAt = today): Promise<string> => {
    const amountCents = splits.reduce((sum, [, cents]) => sum + cents, 0);
    const { transactionId } = await asUser(user, () =>
      createTransaction({
        fromAccountId: from,
        toAccountId: null,
        amountCents,
        occurredAt,
        description: `Harness m13 gasto ${tag}`,
        externalRef: null,
        splits: splits.map(([categoryId, cents]) => ({ categoryId, amountCents: cents })),
        labelIds: [],
      }),
    );
    track("transactions", transactionId);
    return transactionId;
  };

  // P (Vivienda) with A, B; Q is another parent with child C; P2 has two children a mixed movement spans; E is empty.
  const P = await category("padre", null);
  const A = await category("hija A", P);
  const B = await category("hija B", P);
  const Q = await category("otro padre", null);
  const C = await category("hija C", Q);
  const P2 = await category("padre mixto", null);
  const A2 = await category("mixto A", P2);
  const B2 = await category("mixto B", P2);
  const E = await category("padre vacio", null);
  const E2 = await category("padre con hijas sin gasto", null);
  await category("hija sin gasto", E2);

  // W: only the window tells today's 2 on a child from last month's 40. X: only the currency tells 4 pesos from 3 dollars.
  const W = await category("padre ventana", null);
  const WA = await category("ventana hija", W);
  const X = await category("padre moneda", null);
  const XB = await category("moneda hija", X);
  await spend(cop, [[WA, 2_00]]);
  await spend(cop, [[WA, 40_00]], shiftDate(today, -45));
  await spend(cop, [[XB, 4_00]]);
  await spend(usd, [[XB, 3_00]]);

  const onA = await spend(cop, [[A, 10_00]]);
  const onB = await spend(otherCop, [[B, 20_00]]);
  const onP = await spend(cop, [[P, 5_00]]);
  const onC = await spend(cop, [[C, 7_00]]);
  const onQ = await spend(cop, [[Q, 9_00]]);
  const oldA = await spend(cop, [[A, 40_00]], shiftDate(today, -45));
  const usdB = await spend(usd, [[B, 3_00]]);
  const mixed = await spend(cop, [[A2, 10_00], [B2, 20_00]]);

  const budgetOn = async (categoryId: string, accountId: string | null = null): Promise<string> => {
    const { budgetId } = await asUser(user, () =>
      createBudget({
        ownerUserId: user.id,
        groupId: null,
        categoryId,
        accountId,
        labelId: null,
        period: "monthly",
        limitCents: 1_000_00,
        thresholdPct: 80,
        name: `Harness m13 presupuesto ${tag} ${categoryId.slice(0, 8)}`,
      }),
    );
    keep("budgets", budgetId);
    return budgetId;
  };
  const [bP, bA, bP2, bE, bE2, bPOtherCop, bQ, bW, bX] = [
    await budgetOn(P),
    await budgetOn(A),
    await budgetOn(P2),
    await budgetOn(E),
    await budgetOn(E2),
    await budgetOn(P, otherCop),
    await budgetOn(Q),
    await budgetOn(W),
    await budgetOn(X),
  ];
  const statuses = await asUser(user, () => patient(() => listBudgetsWithStatus()));
  const spentOf = (id: string) => statuses.find((row) => row.id === id)?.spentCents;

  assert(
    next("A parent's budget counts its own splits and its subcategories' (10 on A, 20 on B, 5 on P): 35, the sibling parent's child and the old and dollar splits out"),
    spentOf(bP) === 35_00,
    `spent ${spentOf(bP)}, expected 3500`,
  );
  assert(next("A child's budget counts that child alone"), spentOf(bA) === 10_00, `spent ${spentOf(bA)}, expected 1000`);
  assert(
    next("A movement split 10 on one child and 20 on its sibling counts 30 once in the parent's budget"),
    spentOf(bP2) === 30_00,
    `spent ${spentOf(bP2)}, expected 3000`,
  );
  assert(
    next("A split on another parent's child is not in this parent's budget, and that parent counts it with its own: 7 on C, 9 on Q"),
    spentOf(bP) === 35_00 && spentOf(bQ) === 16_00,
    `P ${spentOf(bP)}, Q ${spentOf(bQ)}`,
  );
  assert(
    next("A dollar split on a child is not counted in a peso parent's budget (3 on B in dollars)"),
    spentOf(bP) === 35_00 && spentOf(bX) === 4_00,
    `P ${spentOf(bP)}, X ${spentOf(bX)} (4 pesos expected, the 3 dollars out)`,
  );
  assert(
    next("A split on a child last month is not in this month's parent budget"),
    spentOf(bP) === 35_00 && spentOf(bW) === 2_00,
    `P ${spentOf(bP)}, W ${spentOf(bW)} (the 40.00 on a child, ${shiftDate(today, -45)}, must stay out)`,
  );
  assert(
    next("A parent's budget narrowed to an account counts only the subcategory splits booked on that account"),
    spentOf(bPOtherCop) === 20_00,
    `spent ${spentOf(bPOtherCop)}, expected 2000`,
  );
  assert(
    next("A parent with no spend, and one whose subcategories have none, reads 0"),
    spentOf(bE) === 0 && spentOf(bE2) === 0,
    `empty ${spentOf(bE)}, children-only ${spentOf(bE2)}`,
  );

  const ids = async (categoryId: string) =>
    (await asUser(user, () => patient(() => listTransactions({ categoryId })))).map((row) => row.id).sort();
  const sorted = (...list: string[]) => [...list].sort();
  assert(
    next("Filtering movements by a parent lists those with a split in the parent or in a subcategory"),
    JSON.stringify(await ids(P)) === JSON.stringify(sorted(onA, onB, onP, oldA, usdB)),
    `got ${JSON.stringify(await ids(P))}`,
  );
  assert(
    next("Filtering by a child lists that child's movements alone"),
    JSON.stringify(await ids(A)) === JSON.stringify(sorted(onA, oldA)),
    `got ${JSON.stringify(await ids(A))}`,
  );
  assert(
    next("A movement split across two subcategories is listed once under their parent"),
    JSON.stringify(await ids(P2)) === JSON.stringify([mixed]),
    `got ${JSON.stringify(await ids(P2))}`,
  );
  assert(
    next("Filtering by a parent leaves out another parent's child and the other parent's own movements"),
    !(await ids(P)).includes(onC) && !(await ids(P)).includes(onQ),
    `got ${JSON.stringify(await ids(P))}`,
  );
  const monthStart = `${today.slice(0, 8)}01`;
  const totals = await asUser(user, () => patient(() => getTransactionTotals({ categoryId: P, from: monthStart, to: today })));
  const month = await asUser(user, () => patient(() => listTransactions({ categoryId: P, from: monthStart, to: today })));
  assert(
    next("The parent's this-month filter lists the A, B, P and dollar-B movements and its count agrees with the list"),
    JSON.stringify(month.map((row) => row.id).sort()) === JSON.stringify(sorted(onA, onB, onP, usdB)) && totals.count === month.length,
    `listed ${month.length}, counted ${totals.count}`,
  );

  // A goal on a dollar account sums only dollar aportes (RF-124).
  const goalUsd = await spend(usd, [[A, 1_00]]);
  const goalCop = await spend(cop, [[A, 1_00]]);
  const { goalId } = await asUser(user, () =>
    createGoal({ ownerUserId: user.id, groupId: null, name: `Harness m13 meta ${tag}`, targetAmountCents: 1_000_00, targetDate: null, accountId: usd }),
  );
  keep("savings_goals", goalId);
  for (const [transactionId, amountCents] of [[null, 5_00], [goalUsd, 11_00], [goalCop, 7_00]] as const) {
    const { contributionId } = await asUser(user, () => addGoalContribution({ goalId, transactionId, amountCents }));
    keep("goal_contributions", contributionId);
  }
  const goal = (await asUser(user, () => patient(() => listGoalsWithProgress()))).find((row) => row.id === goalId);
  assert(
    next("A goal on a dollar account sums its virtual and dollar aportes and ignores one earmarking a peso movement"),
    goal?.currency === "USD" && goal.savedCents === 16_00,
    JSON.stringify(goal),
  );

  // Seed text (prove first): a fund member holds the personal set and the fund's, both seeded.
  const leader = await createMembershipFreeUser();
  const { groupId } = await asUser(leader, () =>
    createGroup({ name: `Harness fondo m13 ${tag}`, leaderName: "Harness lider m13", cashMode: "shared", locale: "es" }),
  );
  track("groups", groupId);
  await asUser(leader, () => withUserDb((tx) => seedPersonalCategories(tx, { userId: leader.id, locale: "es" })));
  const [seededFund] = await fixtureSql<{ member_id: string; account_id: string }[]>`
    select
      (select id from group_members where group_id = ${groupId} and user_id = ${leader.id}) as member_id,
      (select id from accounts where group_id = ${groupId} and subtype = 'cash') as account_id`;
  track("group_members", seededFund.member_id);
  track("accounts", seededFund.account_id);
  for (const row of await fixtureSql<{ id: string }[]>`select id from categories where group_id = ${groupId} or owner_user_id = ${leader.id}`) {
    track("categories", row.id);
  }
  const { listScopedCategories } = await import("@/db/queries/categories");
  const { categoryNamesById, scopedCategoryName } = await import("@/lib/fund/category-names");
  const mark = (name: string) => `${name} · fondo`;
  const nodes = await asUser(leader, () => patient(() => listScopedCategories(leader.id)));
  const pickerDrawn = [...categoryNamesById(nodes, mark).values()];
  const pickerRepeats = pickerDrawn.filter((text, index) => pickerDrawn.indexOf(text) !== index);

  // Every seeded category carries one expense so the report lists the whole set.
  const fundCash = seededFund.account_id;
  const { accountId: personalCash } = await asUser(leader, () =>
    createAccount({
      name: `Harness m13 propia ${tag}`,
      kind: "asset",
      subtype: "bank",
      ownerUserId: leader.id,
      groupId: null,
      isShared: false,
      institution: null,
      lastFour: null,
      settlementCurrency: "COP",
      amountMinor: 1_000_000,
      balanceOn: shiftDate(today, -10),
    }),
  );
  track("accounts", personalCash);
  const seededRows = await fixtureSql<{ id: string; group_id: string | null }[]>`
    select id, group_id from categories where (group_id = ${groupId} or owner_user_id = ${leader.id}) and kind = 'expense'`;
  for (const row of seededRows) {
    const { transactionId } = await asUser(leader, () =>
      createTransaction({
        fromAccountId: row.group_id === null ? personalCash : fundCash,
        toAccountId: null,
        amountCents: 1_00,
        occurredAt: today,
        description: `Harness m13 semilla ${tag}`,
        externalRef: null,
        splits: [{ categoryId: row.id, amountCents: 1_00 }],
        labelIds: [],
      }),
    );
    track("transactions", transactionId);
  }
  const report = await asUser(leader, () => patient(() => getExpensesByCategory(currentMonthRange())));
  const reportDrawn = report.map((row) => scopedCategoryName(row.name, row.scope, mark));
  const reportRepeats = reportDrawn.filter((text, index) => reportDrawn.indexOf(text) !== index);
  assert(
    next("A fund member's category pickers and report never draw two rows with identical text across the personal and fund seeded sets"),
    nodes.length > 0 &&
      pickerRepeats.length === 0 &&
      report.length === seededRows.length &&
      reportRepeats.length === 0,
    `picker repeats [${pickerRepeats.join(", ")}] of ${pickerDrawn.length}; report repeats [${reportRepeats.join(", ")}] of ${report.length}/${seededRows.length}`,
  );
}

// M24: what a re-import may touch and in what order it writes (RF-51, RF-52, RF-31, RNF-15). Each row is a survivor of the
// oleada-4 mutator: a key shared by two of the caller's scopes, a file longer than one chunk, the labels and review stamp
// of an updated movement, the typed refusal on a fund's movement key, and the order of a backup's adjustments.
async function importCommitScopesSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const pesos = (cents: number) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  const empty = (): CommitInput => ({
    members: [],
    categories: [],
    accounts: [],
    recurringRules: [],
    transactions: [],
    adjustments: [],
  });
  type Outcome = { ok: true } | { ok: false; error: unknown };
  const commit = async (user: HarnessUser, input: CommitInput, groupId: string | null): Promise<Outcome> => {
    try {
      await asUser(user, () => withUserDb((tx) => commitImport(tx, input, { userId: user.id, groupId })));
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  };
  const said = (outcome: Outcome) => (outcome.ok ? "ok" : `threw ${refusal(outcome.error)}`);
  const openAccount = async (user: HarnessUser, name: string, cents: number, balanceOn: string) => {
    const { accountId } = await asUser(user, () =>
      createAccount({
        name: `Harness m24 ${name} ${tag}`,
        kind: "asset",
        subtype: "bank",
        ownerUserId: user.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor: cents,
        balanceOn,
      }),
    );
    track("accounts", accountId);
    return accountId;
  };
  const bookExpense = async (
    user: HarnessUser,
    accountId: string,
    categoryId: string,
    ref: string,
    cents: number,
    description: string,
    labelIds: string[] = [],
    occurredAt = shiftDate(today, -3),
  ) => {
    const { transactionId } = await asUser(user, () =>
      createTransaction({
        fromAccountId: accountId,
        toAccountId: null,
        amountCents: cents,
        occurredAt,
        description,
        externalRef: ref,
        splits: [{ categoryId, amountCents: cents }],
        labelIds,
      }),
    );
    track("transactions", transactionId);
    return transactionId;
  };
  const updateRow = (
    ref: string,
    accountId: string,
    categoryId: string,
    cents: number,
    description: string,
    i = 0,
  ): CommitInput["transactions"][number] => ({
    status: "update",
    index: i,
    sheetRow: i + 2,
    externalRef: ref,
    placeholderId: null,
    object: {
      fromAccountId: accountId,
      toAccountId: null,
      amount: pesos(cents),
      occurredAt: shiftDate(today, -3),
      description,
      externalRef: ref,
      splits: [{ categoryId, amount: pesos(cents) }],
      labelIds: [],
    },
  });
  const categoryRow = (
    ref: string,
    status: "new" | "update",
    name: string,
    i = 0,
  ): CommitInput["categories"][number] => ({
    status,
    index: i,
    sheetRow: i + 2,
    externalRef: ref,
    placeholderId: status === "new" ? randomUUID() : null,
    object: { name, kind: "expense", parentId: null, color: CATEGORY_COLORS[0] },
  });
  const descriptionOf = async (id: string) =>
    (await fixtureSql<{ description: string | null }[]>`select description from transactions where id = ${id}`)[0]?.description;
  const trackKeyed = async (table: "categories", ref: string) => {
    for (const r of await fixtureSql<{ id: string }[]>`select id from ${fixtureSql(table)} where external_ref = ${ref}`) track(table, r.id);
  };

  // ---- A file longer than one chunk loses no updated row (RNF-15).
  const bulk = await createMembershipFreeUser();
  const BULK = 501;
  const bulkRef = (i: number) => `m24-${tag}-b${i}`;
  const indexes = Array.from({ length: BULK }, (_, i) => i);
  const seeded = await commit(bulk, { ...empty(), categories: indexes.map((i) => categoryRow(bulkRef(i), "new", `Harness m24 masa ${i} ${tag}`, i)) }, null);
  const bulkRows = await fixtureSql<{ id: string; external_ref: string }[]>`
    select id, external_ref from categories where owner_user_id = ${bulk.id} and external_ref like ${`m24-${tag}-b%`}`;
  for (const r of bulkRows) track("categories", r.id);
  const renamed = await commit(bulk, { ...empty(), categories: indexes.map((i) => categoryRow(bulkRef(i), "update", `Harness m24 masa nueva ${i} ${tag}`, i)) }, null);
  const names = new Map(
    (await fixtureSql<{ external_ref: string; name: string }[]>`
      select external_ref, name from categories where owner_user_id = ${bulk.id} and external_ref like ${`m24-${tag}-b%`}`).map((r) => [r.external_ref, r.name]),
  );
  const notRenamed = indexes.filter((i) => names.get(bulkRef(i)) !== `Harness m24 masa nueva ${i} ${tag}`);
  assert(
    next("A re-import of 501 updated rows renames every one, the 500th of the first chunk included (RNF-15)"),
    seeded.ok && renamed.ok && bulkRows.length === BULK && notRenamed.length === 0,
    `seed ${said(seeded)}; update ${said(renamed)}; ${bulkRows.length} seeded; not renamed: [${notRenamed.slice(0, 5)}] of ${notRenamed.length}`,
  );

  // ---- An updated movement: its old labels go with its old splits, and a generated one is confirmed (RF-31).
  const solo = await createMembershipFreeUser();
  const soloBank = await openAccount(solo, "banco", 50_000_000, shiftDate(today, -60));
  const soloCategory = (await asUser(solo, () =>
    createCategory({ scope: { ownerUserId: solo.id }, name: `Harness m24 categoria ${tag}`, kind: "expense", parentId: null, color: CATEGORY_COLORS[0] }),
  )).categoryId;
  track("categories", soloCategory);
  const label = (await asUser(solo, () => createLabel({ scope: { ownerUserId: solo.id }, name: `Harness m24 etiqueta ${tag}`, color: "#047857" }))).labelId;
  track("labels", label);
  const tagged = await bookExpense(solo, soloBank, soloCategory, `m24-${tag}-etiquetado`, 12_000, `m24 ${tag} etiquetado antes`, [label]);
  const labelsBefore = (await fixtureSql<{ n: number }[]>`select count(*)::int as n from transaction_labels where transaction_id = ${tagged}`)[0].n;
  const relabelled = await commit(solo, { ...empty(), transactions: [updateRow(`m24-${tag}-etiquetado`, soloBank, soloCategory, 13_000, `m24 ${tag} etiquetado despues`)] }, null);
  const labelsAfter = (await fixtureSql<{ n: number }[]>`select count(*)::int as n from transaction_labels where transaction_id = ${tagged}`)[0].n;
  assert(
    next("An updated movement whose row carries no label leaves the movement with none (RF-52)"),
    labelsBefore === 1 && relabelled.ok && labelsAfter === 0 && (await descriptionOf(tagged)) === `m24 ${tag} etiquetado despues`,
    `labels before ${labelsBefore}, after ${labelsAfter}; ${said(relabelled)}`,
  );

  const { recurringRuleId } = await asUser(solo, () =>
    createRecurringRule({
      fromAccountId: soloBank,
      toAccountId: null,
      amountCents: 30_000,
      categoryId: soloCategory,
      description: `Harness m24 regla ${tag}`,
      frequency: "monthly",
      intervalN: 1,
      dayOfMonth: 5,
      nextRunOn: shiftDate(today, 20),
      endsOn: null,
    }),
  );
  track("recurring_rules", recurringRuleId);
  const generated = await bookExpense(solo, soloBank, soloCategory, `m24-${tag}-generado`, 14_000, `m24 ${tag} generado antes`);
  const manual = await bookExpense(solo, soloBank, soloCategory, `m24-${tag}-manual`, 15_000, `m24 ${tag} manual antes`);
  const confirmed = await bookExpense(solo, soloBank, soloCategory, `m24-${tag}-confirmado`, 16_000, `m24 ${tag} confirmado antes`);
  await asOwner(solo.id, async (tx) => {
    await tx`update transactions set recurring_rule_id = ${recurringRuleId} where id in ${tx([generated, confirmed])}`;
    await tx`update transactions set reviewed_at = '2026-01-02T03:04:05Z' where id = ${confirmed}`;
  });
  const stamps = async () =>
    new Map(
      (await fixtureSql<{ id: string; reviewed_at: string | null }[]>`
        select id, reviewed_at::text as reviewed_at from transactions where id in ${fixtureSql([generated, manual, confirmed])}`).map((r) => [r.id, r.reviewed_at]),
    );
  const stampsBefore = await stamps();
  const corrected = await commit(solo, {
    ...empty(),
    transactions: [
      updateRow(`m24-${tag}-generado`, soloBank, soloCategory, 14_500, `m24 ${tag} generado despues`, 0),
      updateRow(`m24-${tag}-manual`, soloBank, soloCategory, 15_500, `m24 ${tag} manual despues`, 1),
      updateRow(`m24-${tag}-confirmado`, soloBank, soloCategory, 16_500, `m24 ${tag} confirmado despues`, 2),
    ],
  }, null);
  const stampsAfter = await stamps();
  assert(
    next("Correcting an unreviewed generated movement by import confirms it; a manual one stays unreviewed and a reviewed one keeps its stamp (RF-31)"),
    corrected.ok &&
      stampsBefore.get(generated) === null &&
      stampsAfter.get(generated) !== null &&
      stampsAfter.get(manual) === null &&
      stampsAfter.get(confirmed) === stampsBefore.get(confirmed),
    `${said(corrected)}; before ${JSON.stringify([...stampsBefore])}; after ${JSON.stringify([...stampsAfter])}`,
  );

  // ---- A backup's adjustment counts the balance of its day after the file's movements landed (RF-137, RF-138).
  const adjustDay = shiftDate(today, -5);
  const OPEN = 50_000_000;
  const adjustBank = await openAccount(solo, "ajuste", OPEN, shiftDate(today, -60));
  const adjusted = await commit(solo, {
    ...empty(),
    transactions: [
      {
        status: "new",
        index: 0,
        sheetRow: 2,
        externalRef: `m24-${tag}-gasto-ajuste`,
        placeholderId: null,
        object: {
          fromAccountId: adjustBank,
          toAccountId: null,
          amount: pesos(10_000),
          occurredAt: shiftDate(today, -7),
          description: `m24 ${tag} gasto del extracto`,
          externalRef: `m24-${tag}-gasto-ajuste`,
          splits: [{ categoryId: soloCategory, amount: pesos(10_000) }],
          labelIds: [],
        },
      },
    ],
    adjustments: [
      {
        status: "new",
        index: 1,
        sheetRow: 3,
        externalRef: `m24-${tag}-ajuste`,
        placeholderId: null,
        object: { adjustment: true, accountId: adjustBank, direction: "up", amount: pesos(50_000), occurredAt: adjustDay },
      },
    ],
  }, null);
  const [counted] = await fixtureSql<{ counted: number }[]>`
    select counted_balance_cents::int as counted from account_reconciliations where account_id = ${adjustBank}`;
  const [balance] = await fixtureSql<{ balance: number }[]>`
    select private.account_settlement_balance_on(${adjustBank}::uuid, ${adjustDay}::date)::int as balance`;
  assert(
    next("A backup adjustment counts the account's balance of its day with the file's earlier movements in it: opening, less the expense, plus the gap"),
    adjusted.ok && counted?.counted === OPEN - 10_000 + 50_000 && balance.balance === counted.counted,
    `${said(adjusted)}; counted ${counted?.counted}, balance that day ${balance.balance}, wanted ${OPEN - 10_000 + 50_000}`,
  );

  // ---- A fund: a key shared by the caller's own scope and the fund's.
  const leader = await createMembershipFreeUser();
  const { groupId } = await asUser(leader, () =>
    createGroup({ name: `Harness fondo m24 ${tag}`, leaderName: `Harness m24 lider ${tag}`, cashMode: "shared", locale: "es" }),
  );
  track("groups", groupId);
  const [{ id: fundCash }] = await fixtureSql<{ id: string }[]>`select id from accounts where group_id = ${groupId} and subtype = 'cash'`;
  track("accounts", fundCash);
  // The fund's cash opens today; back to the own bank's day, so the movements below postdate it (RF-162).
  await fixtureSql`update accounts set initial_balance_on = ${shiftDate(today, -60)} where id = ${fundCash}`;
  const ownBank = await openAccount(leader, "propia", 50_000_000, shiftDate(today, -60));
  const ownCategory = (await asUser(leader, () =>
    createCategory({ scope: { ownerUserId: leader.id }, name: `Harness m24 propia ${tag}`, kind: "expense", parentId: null, color: CATEGORY_COLORS[0] }),
  )).categoryId;
  const fundCategory = (await asUser(leader, () =>
    createCategory({ scope: { groupId }, name: `Harness m24 fondo ${tag}`, kind: "expense", parentId: null, color: CATEGORY_COLORS[1] }),
  )).categoryId;
  track("categories", ownCategory);
  track("categories", fundCategory);
  for (const r of await fixtureSql<{ id: string }[]>`select id from group_members where group_id = ${groupId}`) track("group_members", r.id);

  const sharedRef = `m24-${tag}-compartida`;
  const ownMove = await bookExpense(leader, ownBank, ownCategory, sharedRef, 20_000, `m24 ${tag} propia antes`);
  const fundMove = await bookExpense(leader, fundCash, fundCategory, sharedRef, 21_000, `m24 ${tag} fondo antes`);

  const personalOnly = await commit(leader, { ...empty(), transactions: [updateRow(sharedRef, ownBank, ownCategory, 22_000, `m24 ${tag} propia despues`)] }, null);
  assert(
    next("A personal-scope re-import of a key both the caller's own scope and the fund hold updates the own movement and leaves the fund's"),
    personalOnly.ok &&
      (await descriptionOf(ownMove)) === `m24 ${tag} propia despues` &&
      (await descriptionOf(fundMove)) === `m24 ${tag} fondo antes`,
    `${said(personalOnly)}; own "${await descriptionOf(ownMove)}", fund "${await descriptionOf(fundMove)}"`,
  );

  const otherOwn = await bookExpense(leader, ownBank, ownCategory, `m24-${tag}-otra-propia`, 23_000, `m24 ${tag} otra propia antes`);
  const otherFund = await bookExpense(leader, fundCash, fundCategory, `m24-${tag}-otra-fondo`, 24_000, `m24 ${tag} otra fondo antes`);
  const both = await commit(leader, {
    ...empty(),
    transactions: [
      updateRow(`m24-${tag}-otra-propia`, ownBank, ownCategory, 23_500, `m24 ${tag} otra propia despues`, 0),
      updateRow(`m24-${tag}-otra-fondo`, fundCash, fundCategory, 24_500, `m24 ${tag} otra fondo despues`, 1),
    ],
  }, groupId);
  assert(
    next("A fund-scope re-import updates both the fund's movement and the caller's own movement, each by its key"),
    both.ok &&
      (await descriptionOf(otherOwn)) === `m24 ${tag} otra propia despues` &&
      (await descriptionOf(otherFund)) === `m24 ${tag} otra fondo despues`,
    `${said(both)}; own "${await descriptionOf(otherOwn)}", fund "${await descriptionOf(otherFund)}"`,
  );

  const categoryRef = `m24-${tag}-categoria`;
  const madeOwn = await commit(leader, { ...empty(), categories: [categoryRow(categoryRef, "new", `Harness m24 cat propia ${tag}`)] }, null);
  const madeFund = await commit(leader, { ...empty(), categories: [categoryRow(categoryRef, "new", `Harness m24 cat fondo ${tag}`)] }, groupId);
  await trackKeyed("categories", categoryRef);
  const renamedFund = await commit(leader, { ...empty(), categories: [categoryRow(categoryRef, "update", `Harness m24 cat fondo nueva ${tag}`)] }, groupId);
  const categoryNames = await fixtureSql<{ owner: string | null; name: string }[]>`
    select owner_user_id as owner, name from categories where external_ref = ${categoryRef} order by owner_user_id nulls last`;
  assert(
    next("A fund-scope re-import of a category key the caller's own scope also holds renames the fund's category and leaves the own"),
    madeOwn.ok && madeFund.ok && renamedFund.ok &&
      categoryNames.length === 2 &&
      categoryNames.some((r) => r.owner === leader.id && r.name === `Harness m24 cat propia ${tag}`) &&
      categoryNames.some((r) => r.owner === null && r.name === `Harness m24 cat fondo nueva ${tag}`),
    `${said(madeOwn)} / ${said(madeFund)} / ${said(renamedFund)}; ${JSON.stringify(categoryNames)}`,
  );

  // A member's key is the group's: a commit whose scope names another group renames nothing here.
  const memberRef = `m24-${tag}-miembro`;
  const addedMember = await commit(leader, {
    ...empty(),
    members: [{ status: "new", index: 0, sheetRow: 2, externalRef: memberRef, placeholderId: null, object: { name: `Harness m24 miembro ${tag}`, email: undefined } }],
  }, groupId);
  for (const r of await fixtureSql<{ id: string }[]>`select id from group_members where group_id = ${groupId}`) track("group_members", r.id);
  const elsewhere = await commit(leader, {
    ...empty(),
    members: [{ status: "update", index: 0, sheetRow: 2, externalRef: memberRef, placeholderId: null, object: { name: `Harness m24 miembro ajeno ${tag}`, email: undefined } }],
  }, randomUUID());
  const memberName = (await fixtureSql<{ name: string }[]>`select name from group_members where group_id = ${groupId} and external_ref = ${memberRef}`)[0]?.name;
  assert(
    next("A member update under the scope of another group leaves the leader's own group's member as it was"),
    addedMember.ok && memberName === `Harness m24 miembro ${tag}`,
    `${said(addedMember)} / ${said(elsewhere)}; member reads "${memberName}"`,
  );

  // ---- A key the fund already holds is the typed refusal, for a fund's movements too (RF-52).
  const clash = await commit(leader, {
    ...empty(),
    transactions: [
      {
        ...updateRow(`m24-${tag}-otra-fondo`, fundCash, fundCategory, 25_000, `m24 ${tag} repetida`),
        status: "new",
      },
    ],
  }, groupId);
  const typedClass = importCommitModule.ImportAlreadyCommitting;
  assert(
    next("A new movement whose key the fund's movement already holds throws ImportAlreadyCommitting, as a second tab does"),
    !clash.ok && clash.error instanceof typedClass,
    `${said(clash)}`,
  );
}

// o5-m1: a liability's settlement pocket read by its sign. Owed only below zero, credit only above,
// interest and the minimum struck on what is owed alone, and the credit lifting the available credit
// (RF-79, RF-80, RF-83, RF-124; docs/DESIGN.md «Debts»).
async function debtCreditSideSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const IN_CREDIT = 15_000_000;
  const OWING = 8_000_000;
  const LIMIT = 100_000_000;
  const FIXED = 5_000_000;
  const PCT = "0.0333";
  const RATE = "0.3000";
  const MIXED_OWING = 1_000_000;
  const USD_CREDIT = 2_000;
  const BARE_CREDIT = 3_000_000;
  const monthlyRate = Math.pow(1 + Number(RATE), 1 / 12) - 1;
  const interestOn = (owed: number) => Math.round(owed * monthlyRate);
  const pctMinimumOn = (owed: number) => Math.round(owed * Number(PCT));

  const holder = await createMembershipFreeUser();
  const open = async (
    kind: "asset" | "liability",
    name: string,
    amountMinor: number,
  ): Promise<string> => {
    const { accountId } = await asUser(holder, () =>
      createAccount({
        name: `Harness o5m1 ${name} ${tag}`,
        kind,
        subtype: kind === "asset" ? "bank" : "card",
        ownerUserId: holder.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor,
        balanceOn: shiftDate(today, -30),
      }),
    );
    track("accounts", accountId);
    return accountId;
  };
  const terms = async (
    accountId: string,
    minimum: { fixed: number | null; pct: string | null },
    creditLimitCents: number | null,
  ): Promise<void> => {
    await asUser(holder, () =>
      upsertDebtTerms({
        accountId,
        debtKind: "revolving",
        annualRate: RATE,
        minimumPaymentCents: minimum.fixed,
        minimumPaymentPct: minimum.pct,
        creditLimitCents,
        statementCutOffDay: 15,
        paymentDueDay: 5,
        avalCents: null,
      }),
    );
    keep("debt_terms", accountId);
  };
  const pay = async (fromAccountId: string, toAccountId: string, amountCents: number) => {
    const { transactionId } = await asUser(holder, () =>
      createTransaction({
        fromAccountId,
        toAccountId,
        amountCents,
        occurredAt: today,
        description: `o5m1 ${tag}`,
        externalRef: null,
        splits: [],
        labelIds: [],
      }),
    );
    track("transactions", transactionId);
  };
  const refundInDollars = async (toAccountId: string, amountCents: number) => {
    const { categoryId } = await asUser(holder, () =>
      createCategory({
        scope: { ownerUserId: holder.id },
        name: `Harness o5m1 refund ${tag}`,
        kind: "income",
        parentId: null,
        color: "#B4542F",
      }),
    );
    keep("categories", categoryId);
    const { transactionId } = await asUser(holder, () =>
      createTransaction({
        fromAccountId: null,
        toAccountId,
        amountCents,
        currency: "USD",
        counterAmountCents: amountCents * 4_000,
        counterIsEstimate: true,
        occurredAt: today,
        description: `o5m1 refund ${tag}`,
        externalRef: null,
        splits: [{ categoryId, amountCents }],
        labelIds: [],
      }),
    );
    track("transactions", transactionId);
  };

  const bank = await open("asset", "bank", 1_000_000_000);
  const pctCredit = await open("liability", "pct credit", 0);
  const pctOwing = await open("liability", "pct owing", OWING);
  const fixedCredit = await open("liability", "fixed credit", 0);
  const fixedOwing = await open("liability", "fixed owing", OWING);
  const bareCredit = await open("liability", "bare credit", 0);
  const mixed = await open("liability", "mixed", MIXED_OWING);
  const noTerms = await open("liability", "no terms", 0);
  await terms(pctCredit, { fixed: null, pct: PCT }, LIMIT);
  await terms(pctOwing, { fixed: null, pct: PCT }, LIMIT);
  await terms(fixedCredit, { fixed: FIXED, pct: null }, null);
  await terms(fixedOwing, { fixed: FIXED, pct: null }, null);
  await terms(bareCredit, { fixed: null, pct: null }, null);
  await terms(mixed, { fixed: null, pct: PCT }, null);

  const screenBefore = await asUser(holder, () => getDebtsScreenData());
  await pay(bank, pctCredit, IN_CREDIT);
  await pay(bank, fixedCredit, IN_CREDIT);
  await pay(bank, bareCredit, IN_CREDIT);
  await pay(bank, noTerms, BARE_CREDIT);
  await refundInDollars(mixed, USD_CREDIT);

  const [overview, screen, statementCredit, statementOwing, statementFixedCredit, statementFixedOwing] =
    await asUser(holder, () =>
      Promise.all([
        getDebtOverview(),
        getDebtsScreenData(),
        getCurrentStatement(pctCredit),
        getCurrentStatement(pctOwing),
        getCurrentStatement(fixedCredit),
        getCurrentStatement(fixedOwing),
      ]),
    );
  const rowOf = (accountId: string) => overview.find((row) => row.accountId === accountId);
  const screenRowOf = (accountId: string) => screen.withTerms.find((row) => row.accountId === accountId);
  const show = (row: object | undefined) => JSON.stringify(row ?? "no row");
  const pick = (row: DebtOverviewRow | undefined) =>
    row === undefined
      ? "no row"
      : JSON.stringify({
          owedCents: row.owedCents,
          creditCents: row.creditCents,
          availableCreditCents: row.availableCreditCents,
          monthlyInterestCents: row.monthlyInterestCents,
          minimumPaymentCents: row.minimumPaymentCents,
          otherOwed: row.otherOwed,
        });

  // Owed in credit: the overview row and the screen's row of the same card.
  const creditRow = rowOf(pctCredit);
  const creditScreenRow = screenRowOf(pctCredit);
  assert(
    next("Owed in credit: a terms card holding 15000000 in its favour owes 0 and carries 15000000 credit, on the overview and the screen"),
    creditRow?.owedCents === 0 &&
      creditRow.creditCents === IN_CREDIT &&
      creditScreenRow?.owedCents === 0 &&
      creditScreenRow.creditCents === IN_CREDIT,
    `overview ${pick(creditRow)}, screen ${pick(creditScreenRow)}`,
  );

  // Owed when owing: the card that owes reads exactly as before.
  const owingRow = rowOf(pctOwing);
  const owingScreenRow = screenRowOf(pctOwing);
  assert(
    next("Owed when owing: a terms card at -8000000 owes 8000000 and carries 0 credit, on the overview and the screen"),
    owingRow?.owedCents === OWING &&
      owingRow.creditCents === 0 &&
      owingScreenRow?.owedCents === OWING &&
      owingScreenRow.creditCents === 0,
    `overview ${pick(owingRow)}, screen ${pick(owingScreenRow)}`,
  );

  // Available credit: the limit plus the signed balance, and the totals fold the same figures.
  const copAfter = screen.totals.byCurrency.find((set) => set.currency === "COP");
  const copBefore = screenBefore.totals.byCurrency.find((set) => set.currency === "COP");
  assert(
    next("Available credit: limit 100000000 with 15000000 in credit leaves 115000000 available; owing 8000000 leaves 92000000"),
    creditRow?.availableCreditCents === LIMIT + IN_CREDIT &&
      owingRow?.availableCreditCents === LIMIT - OWING &&
      creditScreenRow?.availableCreditCents === LIMIT + IN_CREDIT &&
      owingScreenRow?.availableCreditCents === LIMIT - OWING,
    `in credit ${creditRow?.availableCreditCents} (screen ${creditScreenRow?.availableCreditCents}), expected ${LIMIT + IN_CREDIT}; owing ${owingRow?.availableCreditCents} (screen ${owingScreenRow?.availableCreditCents}), expected ${LIMIT - OWING}`,
  );
  assert(
    next("Available credit: the peso totals add the 15000000 credit to the available credit, and the limit stays the summed limits"),
    copAfter?.availableCreditCents === LIMIT + IN_CREDIT + (LIMIT - OWING) &&
      copAfter.creditLimitCents === 2 * LIMIT &&
      copBefore?.availableCreditCents === LIMIT + (LIMIT - OWING),
    `before ${copBefore?.availableCreditCents}, after ${copAfter?.availableCreditCents} of limit ${copAfter?.creditLimitCents}, expected ${LIMIT + (LIMIT - OWING)} then ${LIMIT + IN_CREDIT + (LIMIT - OWING)} of ${2 * LIMIT}`,
  );

  // Interest: struck on what is owed, at the effective monthly rate of 30 % EA.
  assert(
    next("Interest: a card in credit carries 0 interest; owing 8000000 at 30 % EA carries round(8000000 × ((1.30)^(1/12) − 1)) to the cent"),
    creditRow?.monthlyInterestCents === 0 &&
      creditScreenRow?.monthlyInterestCents === 0 &&
      owingRow?.monthlyInterestCents === interestOn(OWING) &&
      owingScreenRow?.monthlyInterestCents === interestOn(OWING),
    `in credit ${creditRow?.monthlyInterestCents} (screen ${creditScreenRow?.monthlyInterestCents}), owing ${owingRow?.monthlyInterestCents} (screen ${owingScreenRow?.monthlyInterestCents}), expected 0 and ${interestOn(OWING)}`,
  );

  // Minimum, pct: on what is owed alone.
  assert(
    next("Minimum, pct: a card in credit has a minimum of 0; owing 8000000 at 0.0333 has round(8000000 × 0.0333)"),
    creditRow?.minimumPaymentCents === 0 &&
      creditScreenRow?.minimumPaymentCents === 0 &&
      owingRow?.minimumPaymentCents === pctMinimumOn(OWING) &&
      owingScreenRow?.minimumPaymentCents === pctMinimumOn(OWING),
    `in credit ${creditRow?.minimumPaymentCents} (screen ${creditScreenRow?.minimumPaymentCents}), owing ${owingRow?.minimumPaymentCents} (screen ${owingScreenRow?.minimumPaymentCents}), expected 0 and ${pctMinimumOn(OWING)}`,
  );

  // Minimum, fixed: the fixed amount only while something is owed.
  const fixedCreditRow = rowOf(fixedCredit);
  const fixedOwingRow = rowOf(fixedOwing);
  assert(
    next("Minimum, fixed: terms fixing 5000000 ask 0 of a card in credit and 5000000 of a card owing 8000000"),
    fixedCreditRow?.minimumPaymentCents === 0 &&
      screenRowOf(fixedCredit)?.minimumPaymentCents === 0 &&
      fixedOwingRow?.minimumPaymentCents === FIXED &&
      screenRowOf(fixedOwing)?.minimumPaymentCents === FIXED,
    `in credit ${fixedCreditRow?.minimumPaymentCents}, owing ${fixedOwingRow?.minimumPaymentCents}, expected 0 and ${FIXED}`,
  );
  const bareRow = rowOf(bareCredit);
  assert(
    next("Minimum, no minimum in the terms: a card in credit has a minimum of 0, whatever the terms"),
    bareRow?.minimumPaymentCents === 0 && bareRow.owedCents === 0 && bareRow.monthlyInterestCents === 0,
    pick(bareRow),
  );

  // Statement minimum: the current statement strikes its minimum through the same rule.
  assert(
    next("Statement minimum: getCurrentStatement asks 0 of the cards in credit and the owed minimum of the cards owing"),
    statementCredit?.minimumPaymentCents === 0 &&
      statementFixedCredit?.minimumPaymentCents === 0 &&
      statementOwing?.minimumPaymentCents === pctMinimumOn(OWING) &&
      statementFixedOwing?.minimumPaymentCents === FIXED,
    `pct in credit ${statementCredit?.minimumPaymentCents}, fixed in credit ${statementFixedCredit?.minimumPaymentCents}, pct owing ${statementOwing?.minimumPaymentCents}, fixed owing ${statementFixedOwing?.minimumPaymentCents}; expected 0, 0, ${pctMinimumOn(OWING)}, ${FIXED}`,
  );

  // Other pocket: a dollar pocket in credit beside a peso pocket that owes.
  const mixedRow = rowOf(mixed);
  const usdPocket = mixedRow?.otherOwed.find((pocket) => pocket.currency === "USD");
  assert(
    next("Other pocket: a USD pocket at +2000 beside a COP pocket at -1000000 owes 0 and carries 2000 credit; the COP pocket owes 1000000"),
    usdPocket?.owedCents === 0 &&
      usdPocket.creditCents === USD_CREDIT &&
      mixedRow?.owedCents === MIXED_OWING &&
      mixedRow.creditCents === 0,
    pick(mixedRow),
  );

  // Totals unchanged: a credit adds 0 owed and 0 interest to every set.
  const usdAfter = screen.totals.byCurrency.find((set) => set.currency === "USD");
  const owedTotal = OWING + OWING + MIXED_OWING;
  const interestTotal = interestOn(OWING) + interestOn(OWING) + interestOn(MIXED_OWING);
  assert(
    next("Totals unchanged: the peso set owes 17000000 and charges the owing cards' interest alone, before and after the credits; the dollar set owes 0"),
    copBefore?.owedCents === owedTotal &&
      copAfter?.owedCents === owedTotal &&
      copAfter.monthlyInterestCents === copBefore.monthlyInterestCents &&
      copAfter.monthlyInterestCents === interestTotal &&
      screen.totals.owedCents === owedTotal &&
      (usdAfter?.owedCents ?? 0) === 0,
    `peso owed ${copBefore?.owedCents} before, ${copAfter?.owedCents} after; interest ${copBefore?.monthlyInterestCents} before, ${copAfter?.monthlyInterestCents} after; dollar owed ${usdAfter?.owedCents ?? "no set"}; expected ${owedTotal}, ${interestTotal}, 0`,
  );

  // No-terms row: the same shape as a terms row.
  const noTermsRow = screen.withoutTerms.find((debt) => debt.accountId === noTerms);
  assert(
    next("No-terms row: a liability with no terms holding 3000000 in its favour owes 0 and carries 3000000 credit"),
    noTermsRow?.owedCents === 0 && noTermsRow.creditCents === BARE_CREDIT,
    show(noTermsRow),
  );

  // Integer cents: every figure the three reads hand out.
  const figures: [string, unknown][] = [];
  const pocketFigures = (where: string, pockets: DebtPocket[]) =>
    pockets.forEach((pocket) =>
      figures.push([`${where} ${pocket.currency} owed`, pocket.owedCents], [`${where} ${pocket.currency} credit`, pocket.creditCents]),
    );
  for (const row of [...overview, ...screen.withTerms]) {
    figures.push(
      [`${row.accountId} owed`, row.owedCents],
      [`${row.accountId} credit`, row.creditCents],
      [`${row.accountId} interest`, row.monthlyInterestCents],
      [`${row.accountId} due installments`, row.dueInstallmentsCents],
    );
    if (row.availableCreditCents !== null) figures.push([`${row.accountId} available`, row.availableCreditCents]);
    if (row.minimumPaymentCents !== null) figures.push([`${row.accountId} minimum`, row.minimumPaymentCents]);
    pocketFigures(row.accountId, row.otherOwed);
  }
  for (const debt of screen.withoutTerms) {
    figures.push([`${debt.accountId} owed`, debt.owedCents], [`${debt.accountId} credit`, debt.creditCents]);
    pocketFigures(debt.accountId, debt.otherOwed);
  }
  for (const set of screen.totals.byCurrency) {
    figures.push([`${set.currency} owed`, set.owedCents], [`${set.currency} interest`, set.monthlyInterestCents]);
    if (set.availableCreditCents !== null) figures.push([`${set.currency} available`, set.availableCreditCents]);
  }
  for (const statement of [statementCredit, statementOwing, statementFixedCredit, statementFixedOwing]) {
    figures.push([`statement minimum`, statement?.minimumPaymentCents]);
  }
  const notInteger = figures.filter(([, value]) => !Number.isSafeInteger(value));
  assert(
    next("Integer cents: every owed, credit, available, interest and minimum figure the overview, the screen and the statement hand out is a safe integer"),
    figures.length > 0 && notInteger.length === 0,
    `${figures.length} figures, not integer: ${JSON.stringify(notInteger.slice(0, 6))}`,
  );
}

// O5-M2: what a count that takes money out of an account, the first and last day of a range, and an English seed owe
// the person (RF-137, RF-138, RF-118, RF-50, RF-46). Each block is a survivor of an earlier mutation round.
async function o5m2SurvivorsSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const thisMonth = today.slice(0, 7);
  const holder = await createMembershipFreeUser();
  const open = async (name: string, amountMinor: number): Promise<string> => {
    const { accountId } = await asUser(holder, () =>
      createAccount({
        name: `Harness o5m2 ${name} ${tag}`,
        kind: "asset",
        subtype: "bank",
        ownerUserId: holder.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor,
        balanceOn: shiftDate(today, -60),
      }),
    );
    track("accounts", accountId);
    return accountId;
  };
  const category = async (name: string, kind: "expense" | "income"): Promise<string> => {
    const { categoryId } = await asUser(holder, () =>
      createCategory({ scope: { ownerUserId: holder.id }, name: `Harness o5m2 ${name} ${tag}`, kind, parentId: null, color: "#0E7490" }),
    );
    track("categories", categoryId);
    return categoryId;
  };
  const spend = async (from: string, categoryId: string, amountCents: number, occurredAt: string, description: string) => {
    const { transactionId } = await asUser(holder, () =>
      createTransaction({
        fromAccountId: from,
        toAccountId: null,
        amountCents,
        occurredAt,
        description,
        externalRef: null,
        splits: [{ categoryId, amountCents }],
        labelIds: [],
      }),
    );
    track("transactions", transactionId);
    return transactionId;
  };

  // A count that leaves the account: the gap is negative, and no report reads it as an expense.
  const bank = await open("banco", 1_000_000);
  const wallet = await open("billetera", 0);
  const food = await category("mercado", "expense");
  await spend(bank, food, 50_000, today, `Harness o5m2 gasto ${tag}`);
  const down = await asUser(holder, () =>
    reconcileAccount({ accountId: bank, reconciledOn: today, realMagnitudeCents: 350_000, expectedDerivedCents: 950_000 }),
  );
  const up = await asUser(holder, () =>
    reconcileAccount({ accountId: wallet, reconciledOn: today, realMagnitudeCents: 80_000, expectedDerivedCents: 0 }),
  );
  const bookedLegs = async (reconciliationId: string) =>
    fixtureSql<{ from_account_id: string | null; to_account_id: string | null; amount_cents: string }[]>`
      select from_account_id, to_account_id, amount_cents::text from transactions where reconciliation_id = ${reconciliationId}`;
  const [downLegs, upLegs] = await Promise.all([
    down.ok ? bookedLegs(down.id) : Promise.resolve([]),
    up.ok ? bookedLegs(up.id) : Promise.resolve([]),
  ]);
  assert(
    next("A count below the derived figure books 600000 out of the account and reports a gap of -600000; one above books 80000 in and reports +80000"),
    down.ok && up.ok &&
      downLegs.length === 1 && downLegs[0].from_account_id === bank && downLegs[0].to_account_id === null && downLegs[0].amount_cents === "600000" &&
      upLegs.length === 1 && upLegs[0].to_account_id === wallet && upLegs[0].from_account_id === null && upLegs[0].amount_cents === "80000" &&
      down.gapCents === -600_000 && up.gapCents === 80_000,
    `down ${down.ok ? down.gapCents : down.reason} (legs ${JSON.stringify(downLegs)}), up ${up.ok ? up.gapCents : up.reason} (legs ${JSON.stringify(upLegs)})`,
  );

  const history = await asUser(holder, () => listAccountReconciliations(bank));
  assert(
    next("The account's count history reads the same gap with the same sign, and the derived figure it was shown"),
    history.length === 1 && history[0].gapCents === -600_000 && history[0].countedCents === 350_000 && history[0].derivedCents === 950_000,
    JSON.stringify(history),
  );

  const [six, month] = await asUser(holder, () => Promise.all([getSixMonthFlow(), getMonthlyFlow(currentMonthRange())]));
  const sixNow = six.find((row) => row.currency === "COP" && row.monthStart.startsWith(thisMonth));
  const monthNow = month.find((row) => row.currency === "COP");
  assert(
    next("The six-month trend and the month count the 50000 spent as the only expense and no income; the two adjustments are their own signed sum, -520000"),
    sixNow?.expenseCents === 50_000 && sixNow.incomeCents === 0 && sixNow.adjustmentCents === -520_000 &&
      monthNow?.expenseCents === 50_000 && monthNow.incomeCents === 0 && monthNow.netCents === -50_000 && monthNow.adjustmentCents === -520_000,
    `six ${JSON.stringify(sixNow)}, month ${JSON.stringify(monthNow)}`,
  );

  // A range keeps its first and its last day and drops the days beside them.
  const ranged = await open("rango", 1_000_000);
  const first = shiftDate(today, -30);
  const last = shiftDate(today, -20);
  const days: [string, number][] = [["before", -31], ["first", -30], ["middle", -25], ["last", -20], ["after", -19]];
  const dayOf = new Map<string, string>();
  for (const [name, offset] of days) {
    const description = `Harness o5m2 dia ${name} ${tag}`;
    await spend(ranged, food, 1_00, shiftDate(today, offset), description);
    dayOf.set(description, name);
  }
  const names = (rows: { description?: string | null }[]) =>
    rows.flatMap((row) => (typeof row.description === "string" && dayOf.has(row.description) ? [dayOf.get(row.description) as string] : [])).sort();
  const listed = (filters: { from?: string; to?: string }) =>
    asUser(holder, () => listTransactions({ accountId: ranged, ...filters })).then(names);
  const exported = (range: { from?: Date | string; to?: Date | string }) =>
    asUser(holder, () => readExport({ entityKeys: ["transactions"], ...range })).then((result) => names(result.transactions ?? []));
  const civilNoon = (day: string) => new Date(`${day}T12:00:00-05:00`);
  const [both, onlyFrom, onlyTo] = await Promise.all([
    listed({ from: first, to: last }),
    listed({ from: first }),
    listed({ to: last }),
  ]);
  assert(
    next("The movement list keeps the first and the last day of its range, drops the day before and the day after, and honours either bound alone"),
    JSON.stringify(both) === JSON.stringify(["first", "last", "middle"]) &&
      JSON.stringify(onlyFrom) === JSON.stringify(["after", "first", "last", "middle"]) &&
      JSON.stringify(onlyTo) === JSON.stringify(["before", "first", "last", "middle"]),
    `both ${JSON.stringify(both)}, from alone ${JSON.stringify(onlyFrom)}, to alone ${JSON.stringify(onlyTo)}`,
  );
  const [xBoth, xFrom, xTo, xDates] = await Promise.all([
    exported({ from: first, to: last }),
    exported({ from: first }),
    exported({ to: last }),
    exported({ from: civilNoon(first), to: civilNoon(last) }),
  ]);
  assert(
    next("The export keeps the first and the last day of its range, drops the day before and the day after, honours either bound alone, and reads a Date as its Bogota day"),
    JSON.stringify(xBoth) === JSON.stringify(["first", "last", "middle"]) &&
      JSON.stringify(xFrom) === JSON.stringify(["after", "first", "last", "middle"]) &&
      JSON.stringify(xTo) === JSON.stringify(["before", "first", "last", "middle"]) &&
      JSON.stringify(xDates) === JSON.stringify(["first", "last", "middle"]),
    `both ${JSON.stringify(xBoth)}, from alone ${JSON.stringify(xFrom)}, to alone ${JSON.stringify(xTo)}, dates ${JSON.stringify(xDates)}`,
  );

  // The English seed writes the English names, parent and child alike.
  const seeded = await createMembershipFreeUser();
  const { seedCategoryTree } = await import("@/db/queries/seed-categories");
  await asUser(seeded, () => withUserDb((tx) => seedCategoryTree(tx, { ownerUserId: seeded.id }, "en")));
  const rows = await fixtureSql<{ id: string; name: string; parent_id: string | null }[]>`
    select id, name, parent_id from categories where owner_user_id = ${seeded.id}`;
  for (const row of rows) track("categories", row.id);
  const nameOf = new Map(rows.map((row) => [row.id, row.name]));
  const parents = rows.filter((row) => row.parent_id === null).map((row) => row.name).sort();
  const childrenOf = (parent: string) =>
    rows.filter((row) => row.parent_id !== null && nameOf.get(row.parent_id) === parent).map((row) => row.name).sort();
  const expectedParents = SEED_CATEGORIES.map((category) => category.name.en).sort();
  const wrongChildren = SEED_CATEGORIES.filter(
    (category) => JSON.stringify(childrenOf(category.name.en)) !== JSON.stringify((category.children ?? []).map((child) => child.name.en).sort()),
  ).map((category) => category.name.en);
  assert(
    next("Seeding in English writes the English parent names and the English child names, each child under its English parent"),
    JSON.stringify(parents) === JSON.stringify(expectedParents) &&
      wrongChildren.length === 0 &&
      parents.includes("Housing") && childrenOf("Housing").includes("Rent") &&
      rows.length === SEED_CATEGORIES.reduce((sum, category) => sum + 1 + (category.children?.length ?? 0), 0),
    `parents ${JSON.stringify(parents)}, parents with other children [${wrongChildren.join(", ")}], ${rows.length} rows`,
  );
}

// o5-m15 (RF-142, RF-52, RF-124): a backup of a fund holding a dollar purchase on a peso card comes back in
// dollars, with the amount the card was charged and whether it is still an estimate, and the balances stand
// where they stood. The file is the real one: written by the workbook, read by the workbook, then the pipeline
// and the commit, as the person who imports.
async function dollarBackupSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const source = await createMembershipFreeUser();
  const refOf = (suffix: string) => `o5m15-${tag}-${suffix}`;
  const cardName = `Harness o5m15 tarjeta ${tag}`;
  const bankName = `Harness o5m15 banco ${tag}`;
  const categoryName = `Harness o5m15 categoria ${tag}`;
  const USD_CENTS = 2_500;
  const ESTIMATE_CENTS = 10_500_000;
  const BILLED_USD_CENTS = 1_000;
  const BILLED_CENTS = 4_200_000;
  const COP_CENTS = 40_000;

  await asUser(source, async () => {
    const { categoryId } = await createCategory({
      scope: { ownerUserId: source.id },
      name: categoryName,
      kind: "expense",
      parentId: null,
      color: CATEGORY_COLORS[0],
    });
    track("categories", categoryId);
    const open = async (name: string, kind: "asset" | "liability", subtype: string, amountMinor: number) => {
      const { accountId } = await createAccount({
        name,
        kind,
        subtype,
        ownerUserId: source.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor,
        balanceOn: shiftDate(today, -60),
      } as never);
      track("accounts", accountId);
      return accountId;
    };
    const card = await open(cardName, "liability", "card", 0);
    const bank = await open(bankName, "asset", "bank", 900_000_000);
    const book = async (
      from: string,
      amountCents: number,
      suffix: string,
      foreign?: { counterAmountCents: number; counterIsEstimate: boolean },
    ) => {
      const { transactionId } = await createTransaction({
        fromAccountId: from,
        toAccountId: null,
        amountCents,
        ...(foreign ? { currency: "USD", ...foreign } : {}),
        occurredAt: shiftDate(today, -5),
        description: `Harness o5m15 ${suffix} ${tag}`,
        externalRef: refOf(suffix),
        splits: [{ categoryId, amountCents }],
        labelIds: [],
      } as never);
      track("transactions", transactionId);
    };
    await book(card, USD_CENTS, "usd", { counterAmountCents: ESTIMATE_CENTS, counterIsEstimate: true });
    await book(card, BILLED_USD_CENTS, "billed", { counterAmountCents: BILLED_CENTS, counterIsEstimate: false });
    await book(bank, COP_CENTS, "cop");
  });

  const labels: ReverseSheetLabels = {
    entityBySheetName: new Map(SHEET_ENTITIES.map((entity) => [`sheets.${entity}`, entity] as const)),
    columnKeyByHeader: new Map(
      SHEET_ENTITIES.map(
        (entity) =>
          [entity, new Map(sheetDescriptors[entity].columns.map((column) => [`columns.${column.key}`, column.key] as const))] as const,
      ),
    ),
  };
  const sheetLabels = {
    sheetName: (entity: string) => `sheets.${entity}`,
    columnHeader: (key: string) => `columns.${key}`,
  };

  // The fund's own backup. Accounts and categories carry the stable key a re-import matches on.
  const exported = await asUser(source, () => readExport({ entityKeys: ["accounts", "categories", "transactions"] }));
  const keyed = <T extends { name?: unknown }>(rows: T[] | undefined, names: Record<string, string>) =>
    (rows ?? []).filter((row) => String(row.name) in names).map((row) => ({ ...row, externalRef: names[String(row.name)] }));
  const accountRows = keyed(exported.accounts, { [cardName]: refOf("card"), [bankName]: refOf("bank") });
  const categoryRows = keyed(exported.categories, { [categoryName]: refOf("category") });
  const movementRows = (exported.transactions ?? []).filter((row) => String(row.externalRef).startsWith(`o5m15-${tag}-`));
  const fileOf = async (movements: typeof movementRows) => {
    const workbook = buildWorkbook({
      data: { accounts: accountRows as never, categories: categoryRows as never, transactions: movements as never },
      labels: sheetLabels,
    });
    return { workbook, bytes: new Uint8Array(await workbook.xlsx.writeBuffer()) };
  };
  const original = await fileOf(movementRows);

  // ---- Export: what the sheet carries for each movement.
  const cell = (ref: string, column: string) => {
    const sheet = original.workbook.getWorksheet("sheets.transactions")!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    const at = (key: string) => header.indexOf(`columns.${key}`) + 1;
    for (let r = 2; r <= sheet.rowCount; r += 1) {
      if (sheet.getRow(r).getCell(at("externalRef")).value === refOf(ref)) {
        const value = sheet.getRow(r).getCell(at(column)).value;
        return value === undefined ? null : value;
      }
    }
    return "no such row";
  };
  assert(
    next("The export writes a dollar purchase on a peso card with its currency, 25, the 105000 estimated on the card, and the estimate flag TRUE"),
    cell("usd", "currency") === "USD" &&
      cell("usd", "amount") === 25 &&
      cell("usd", "counterAmount") === 105_000 &&
      cell("usd", "counterIsEstimate") === true,
    `currency ${cell("usd", "currency")}, amount ${cell("usd", "amount")}, counterAmount ${cell("usd", "counterAmount")}, counterIsEstimate ${cell("usd", "counterIsEstimate")}`,
  );
  assert(
    next("The export writes a billed dollar purchase with the 42000 the card charged and no estimate mark, and leaves both cells blank on a peso movement"),
    cell("billed", "counterAmount") === 42_000 &&
      cell("billed", "counterIsEstimate") !== true &&
      cell("cop", "counterAmount") === null &&
      cell("cop", "counterIsEstimate") === null,
    `billed ${cell("billed", "counterAmount")}/${cell("billed", "counterIsEstimate")}, peso ${cell("cop", "counterAmount")}/${cell("cop", "counterIsEstimate")}`,
  );

  // ---- The reader: a file in, the commit input out.
  const prepare = async (user: HarnessUser, bytes: Uint8Array) => {
    const parsed = await parseWorkbook({ buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, labels });
    const importScope = await asUser(user, () => readImportScope());
    const recordsOf = (entity: (typeof SHEET_ENTITIES)[number]) => (parsed[entity] ?? []).map((row) => row.record as RawRow);
    const refs = buildEffectiveRefs(importScope, recordsOf);
    const rows = (entity: (typeof SHEET_ENTITIES)[number]) =>
      (parsed[entity] ?? []).map((row, index) =>
        processRow(entity, row.record as RawRow, index, row.sheetRow, refs, importScope.existingRefs[entity]),
      );
    const [categories, accounts, transactions] = [rows("categories"), rows("accounts"), rows("transactions")];
    const errors = [...categories, ...accounts, ...transactions].flatMap((row) => row.errors.map((e) => `${e.key}@${e.column ?? ""}`));
    const input: CommitInput = {
      members: [],
      categories: categories.map((row) => ({ ...row, object: row.object as never })),
      accounts: accounts.map((row) => ({ ...row, object: row.object as never })),
      recurringRules: [],
      transactions: transactions.map((row) => ({ ...row, object: row.object as never })),
      adjustments: [],
    };
    return { input, errors };
  };
  type Committed = { outcome?: { inserted: number; updated: number }; error?: unknown; role?: string; trips: number };
  const commitAs = async (user: HarnessUser, input: CommitInput): Promise<Committed> => {
    const before = roundTrips();
    let role: string | undefined;
    try {
      const outcome = await asUser(user, () =>
        withUserDb(async (tx) => {
          role = String(((await tx.execute(sql`select current_user as role`)) as unknown as { role: string }[])[0].role);
          return commitImport(tx, input, { userId: user.id, groupId: null });
        }),
      );
      return { outcome, role, trips: roundTrips() - before };
    } catch (error) {
      return { error, role, trips: roundTrips() - before };
    }
  };
  const said = (result: Committed) => (result.error === undefined ? "ok" : `threw ${refusal(result.error)}`);
  const stored = (user: HarnessUser) =>
    fixtureSql<{ ref: string; currency: string; amount: string; counter: string | null; estimate: boolean }[]>`
      select t.external_ref as ref, t.currency, t.amount_cents::text as amount,
        t.counter_amount_cents::text as counter, t.counter_is_estimate as estimate
      from transactions t
      join accounts a on a.id = coalesce(t.from_account_id, t.to_account_id)
      where a.owner_user_id = ${user.id}
      order by t.external_ref`;
  const balances = (user: HarnessUser) =>
    fixtureSql<{ name: string; currency: string; balance: string }[]>`
      select a.name, b.currency, b.balance_cents::text as balance
      from account_balances b join accounts a on a.id = b.id
      where a.owner_user_id = ${user.id}
      order by a.name, b.currency`;
  const owned = async (user: HarnessUser) => {
    const [row] = await fixtureSql<{ accounts: number; categories: number; movements: number }[]>`
      select (select count(*)::int from accounts where owner_user_id = ${user.id}) as accounts,
        (select count(*)::int from categories where owner_user_id = ${user.id}) as categories,
        (select count(*)::int from transactions t join accounts a on a.id = coalesce(t.from_account_id, t.to_account_id)
          where a.owner_user_id = ${user.id}) as movements`;
    return row;
  };
  const trackOwned = async (user: HarnessUser) => {
    for (const r of await fixtureSql<{ id: string }[]>`select id from accounts where owner_user_id = ${user.id}`) track("accounts", r.id);
    for (const r of await fixtureSql<{ id: string }[]>`select id from categories where owner_user_id = ${user.id}`) track("categories", r.id);
  };

  // ---- Round trip into a clean fund.
  const before = await balances(source);
  const clean = await createMembershipFreeUser();
  const first = await prepare(clean, original.bytes);
  const firstCommit = await commitAs(clean, first.input);
  await trackOwned(clean);
  const restored = await stored(clean);
  const byRef = (rows: typeof restored, suffix: string) => rows.find((r) => r.ref === refOf(suffix));
  assert(
    next("Importing the backup into a clean fund gives the dollar purchase back as USD 25.00 charged 105000.00 on the card, still an estimate"),
    first.errors.length === 0 &&
      said(firstCommit) === "ok" &&
      JSON.stringify(byRef(restored, "usd")) ===
        JSON.stringify({ ref: refOf("usd"), currency: "USD", amount: String(USD_CENTS), counter: String(ESTIMATE_CENTS), estimate: true }),
    `file errors [${first.errors.join(",")}]; commit ${said(firstCommit)}; restored ${JSON.stringify(byRef(restored, "usd"))}`,
  );
  assert(
    next("The billed dollar purchase comes back billed and the peso movement comes back in pesos with no second amount"),
    JSON.stringify(byRef(restored, "billed")) ===
      JSON.stringify({ ref: refOf("billed"), currency: "USD", amount: String(BILLED_USD_CENTS), counter: String(BILLED_CENTS), estimate: false }) &&
      JSON.stringify(byRef(restored, "cop")) ===
        JSON.stringify({ ref: refOf("cop"), currency: "COP", amount: String(COP_CENTS), counter: null, estimate: false }),
    `billed ${JSON.stringify(byRef(restored, "billed"))}; peso ${JSON.stringify(byRef(restored, "cop"))}`,
  );

  // ---- RF-124: the same pockets, per currency, on both accounts. A billed purchase lands in the card's pesos (0051), so only the estimated one stays in dollars.
  const after = await balances(clean);
  const cardUsd = before.find((r) => r.name === cardName && r.currency === "USD");
  assert(
    next("After the round trip each account's balance per currency is what it was, the card's dollars standing apart from its pesos"),
    Math.abs(Number(cardUsd?.balance)) === USD_CENTS &&
      before.some((r) => r.name === bankName) &&
      JSON.stringify(before) === JSON.stringify(after),
    `before ${JSON.stringify(before)}; after ${JSON.stringify(after)}`,
  );

  // ---- As the caller: the role that writes is the one that is granted.
  assert(
    next("The import commit runs as the authenticated role and is never refused for a column it has no grant on"),
    firstCommit.role === "authenticated" &&
      pgErrorCode(firstCommit.error) !== "42501" &&
      said(firstCommit) === "ok" &&
      byRef(restored, "usd")?.currency === "USD" &&
      byRef(restored, "usd")?.counter === String(ESTIMATE_CENTS),
    `role ${firstCommit.role}; ${said(firstCommit)}; dollar row ${JSON.stringify(byRef(restored, "usd"))}`,
  );

  // ---- RF-52: the same file again.
  const again = await prepare(clean, original.bytes);
  const secondCommit = await commitAs(clean, again.input);
  const restoredAgain = await stored(clean);
  assert(
    next("Importing the same backup again inserts nothing, updates its six rows by their keys, and leaves every amount, currency and estimate mark as they were"),
    again.errors.length === 0 &&
      again.input.transactions.every((row) => row.status === "update") &&
      secondCommit.outcome?.inserted === 0 &&
      secondCommit.outcome?.updated === 6 &&
      JSON.stringify(restoredAgain) === JSON.stringify(restored) &&
      JSON.stringify(await balances(clean)) === JSON.stringify(before),
    `commit ${said(secondCommit)} ${JSON.stringify(secondCommit.outcome)}; rows ${JSON.stringify(restoredAgain)}`,
  );
  const copOnly = await commitAs(clean, { ...again.input, transactions: again.input.transactions.filter((row) => row.externalRef === refOf("cop")) });
  assert(
    next("Updating the dollar rows costs the commit no more round trips than updating one peso row: the updates stay one statement per kind"),
    secondCommit.error === undefined &&
      copOnly.error === undefined &&
      byRef(restoredAgain, "usd")?.counter === String(ESTIMATE_CENTS) &&
      secondCommit.trips === copOnly.trips,
    `three rows ${secondCommit.trips} trips, one row ${copOnly.trips}`,
  );

  // ---- RF-52: the file says the bank has now billed 106000.
  const corrected = movementRows.map((row) =>
    row.externalRef === refOf("usd") ? { ...row, counterAmount: 10_600_000, counterIsEstimate: false } : row,
  );
  const correctedFile = await fileOf(corrected);
  const third = await prepare(clean, correctedFile.bytes);
  const thirdCommit = await commitAs(clean, third.input);
  const restoredCorrected = await stored(clean);
  assert(
    next("A re-import whose file carries the billed amount updates the purchase to 106000.00 charged and no longer an estimate, its dollars untouched"),
    third.errors.length === 0 &&
      thirdCommit.outcome?.inserted === 0 &&
      JSON.stringify(byRef(restoredCorrected, "usd")) ===
        JSON.stringify({ ref: refOf("usd"), currency: "USD", amount: String(USD_CENTS), counter: "10600000", estimate: false }),
    `commit ${said(thirdCommit)}; row ${JSON.stringify(byRef(restoredCorrected, "usd"))}`,
  );

  // ---- All or nothing: a movement the database refuses takes the whole file with it.
  const doomed = await createMembershipFreeUser();
  const whole = await prepare(doomed, original.bytes);
  const peso = whole.input.transactions.find((row) => row.externalRef === refOf("cop"))!;
  const bad = {
    ...peso,
    sheetRow: 99,
    externalRef: refOf("bad"),
    object: { ...(peso.object as object), currency: "USD", externalRef: refOf("bad") } as never,
  };
  const refused = await commitAs(doomed, { ...whole.input, transactions: [...whole.input.transactions, bad] });
  await trackOwned(doomed);
  const left = await owned(doomed);
  let named: { entity?: string; sheetRow?: number; reasonKey?: string } = {};
  try {
    named = JSON.parse((refused.error as Error).message);
  } catch {
    named = {};
  }
  assert(
    next("A file with one dollar row the card cannot take is refused naming that row, and not one account, category or movement of it is written"),
    whole.errors.length === 0 &&
      refused.error !== undefined &&
      named.entity === "transactions" &&
      named.sheetRow === 99 &&
      named.reasonKey === "transactions.errors.currencyMismatch" &&
      left.accounts === 0 &&
      left.categories === 0 &&
      left.movements === 0,
    `${said(refused)}; named ${JSON.stringify(named)}; left ${JSON.stringify(left)}`,
  );
}

// O6-M2: a movement names the planned payment it settled (RF-161), the consolidated next payment is never a debt that
// owes nothing (RF-83), a foreign pocket states what it is still expected to bill and nothing sums it (RF-123, RF-124),
// and the minimum and credit totals hold at their edges (D2, D14). Every holder is fresh, so each fund reads only its
// own debts.
async function o6m2DebtsAndSettledSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const LIMIT = 100_000_000;
  const RATE = "0.3000";
  const IN_CREDIT = 800_000;
  const USD_PURCHASE = 2_500;
  const PURCHASE_ESTIMATE = 10_500_000;
  const USD_REFUND = 500;
  const REFUND_ESTIMATE = 2_000_000;
  const FIXED = 5_000_000;
  const show = (value: unknown) => JSON.stringify(value ?? "nothing");

  const open = async (
    holder: HarnessUser,
    kind: "asset" | "liability",
    name: string,
    amountMinor: number,
    settlementCurrency: "COP" | "USD" = "COP",
  ): Promise<string> => {
    const { accountId } = await asUser(holder, () =>
      createAccount({
        name: `Harness o6m2 ${name} ${tag}`,
        kind,
        subtype: kind === "asset" ? "bank" : "card",
        ownerUserId: holder.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency,
        amountMinor,
        balanceOn: shiftDate(today, -30),
      }),
    );
    track("accounts", accountId);
    return accountId;
  };
  const terms = async (
    holder: HarnessUser,
    accountId: string,
    { fixed, limit, dueDay }: { fixed: number | null; limit: number | null; dueDay: number },
  ): Promise<void> => {
    await asUser(holder, () =>
      upsertDebtTerms({
        accountId,
        debtKind: "revolving",
        annualRate: RATE,
        minimumPaymentCents: fixed,
        minimumPaymentPct: null,
        creditLimitCents: limit,
        statementCutOffDay: 20,
        paymentDueDay: dueDay,
        avalCents: null,
      }),
    );
    keep("debt_terms", accountId);
  };
  const category = async (holder: HarnessUser, kind: "expense" | "income"): Promise<string> => {
    const { categoryId } = await asUser(holder, () =>
      createCategory({
        scope: { ownerUserId: holder.id },
        name: `Harness o6m2 ${kind} ${tag}`,
        kind,
        parentId: null,
        color: "#B4542F",
      }),
    );
    keep("categories", categoryId);
    return categoryId;
  };
  const move = async (
    holder: HarnessUser,
    args: {
      from: string | null;
      to: string | null;
      amountCents: number;
      categoryId?: string;
      currency?: "COP" | "USD";
      estimate?: number;
      description: string;
    },
  ): Promise<string> => {
    const { transactionId } = await asUser(holder, () =>
      createTransaction({
        fromAccountId: args.from,
        toAccountId: args.to,
        amountCents: args.amountCents,
        ...(args.currency
          ? { currency: args.currency, counterAmountCents: args.estimate ?? null, counterIsEstimate: args.estimate !== undefined }
          : {}),
        occurredAt: today,
        description: `Harness o6m2 ${args.description} ${tag}`,
        externalRef: null,
        splits: args.categoryId ? [{ categoryId: args.categoryId, amountCents: args.amountCents }] : [],
        labelIds: [],
      }),
    );
    track("transactions", transactionId);
    return transactionId;
  };
  const usdOf = (pockets: DebtPocket[] | undefined) => pockets?.find((pocket) => pocket.currency === "USD");
  const copSetOf = (screen: DebtsScreenData) => screen.totals.byCurrency.find((set) => set.currency === "COP");
  const pocketFigures = (pocket: DebtPocket | undefined) =>
    pocket === undefined
      ? "no USD pocket"
      : JSON.stringify({ owedCents: pocket.owedCents, creditCents: pocket.creditCents, toBillCents: pocket.toBillCents });
  const integerFigures: [string, unknown][] = [];
  const collect = (where: string, overview: DebtOverviewRow[], screen: DebtsScreenData) => {
    const pockets = (row: string, list: DebtPocket[]) => {
      for (const pocket of list) {
        integerFigures.push([`${where} ${row} ${pocket.currency} owed`, pocket.owedCents]);
        integerFigures.push([`${where} ${row} ${pocket.currency} credit`, pocket.creditCents]);
        if (pocket.toBillCents !== null) integerFigures.push([`${where} ${row} ${pocket.currency} to bill`, pocket.toBillCents]);
      }
    };
    for (const row of [...overview, ...screen.withTerms]) {
      integerFigures.push([`${where} owed`, row.owedCents], [`${where} credit`, row.creditCents]);
      integerFigures.push([`${where} interest`, row.monthlyInterestCents], [`${where} installments`, row.dueInstallmentsCents]);
      if (row.availableCreditCents !== null) integerFigures.push([`${where} available`, row.availableCreditCents]);
      if (row.minimumPaymentCents !== null) integerFigures.push([`${where} minimum`, row.minimumPaymentCents]);
      pockets(row.accountId, row.otherOwed);
    }
    for (const debt of screen.withoutTerms) {
      integerFigures.push([`${where} no-terms owed`, debt.owedCents], [`${where} no-terms credit`, debt.creditCents]);
      pockets(debt.accountId, debt.otherOwed);
    }
    for (const set of screen.totals.byCurrency) {
      integerFigures.push([`${where} ${set.currency} total owed`, set.owedCents]);
      integerFigures.push([`${where} ${set.currency} total interest`, set.monthlyInterestCents]);
      if (set.availableCreditCents !== null) integerFigures.push([`${where} ${set.currency} total available`, set.availableCreditCents]);
      if (set.creditLimitCents !== null) integerFigures.push([`${where} ${set.currency} total limit`, set.creditLimitCents]);
    }
    if (screen.totals.nextPayment !== null) integerFigures.push([`${where} next payment`, screen.totals.nextPayment.amountCents]);
  };

  // --- Pocket to bill: a peso card in credit with a dollar purchase the issuer has not billed yet.
  const card = await createMembershipFreeUser();
  const cardBank = await open(card, "asset", "bank", 1_000_000_000);
  const cardExpense = await category(card, "expense");
  const cardIncome = await category(card, "income");
  const visa = await open(card, "liability", "visa", 0);
  await terms(card, visa, { fixed: null, limit: LIMIT, dueDay: 5 });
  await move(card, { from: cardBank, to: visa, amountCents: IN_CREDIT, description: "abono" });
  const screenWithout = await asUser(card, () => getDebtsScreenData());
  await move(card, {
    from: visa,
    to: null,
    amountCents: USD_PURCHASE,
    categoryId: cardExpense,
    currency: "USD",
    estimate: PURCHASE_ESTIMATE,
    description: "compra en dolares",
  });
  const [overviewWith, screenWith] = await asUser(card, () => Promise.all([getDebtOverview(), getDebtsScreenData()]));
  collect("pocket", overviewWith, screenWith);
  const visaRow = overviewWith.find((row) => row.accountId === visa);
  const visaScreenRow = screenWith.withTerms.find((row) => row.accountId === visa);
  assert(
    next("Pocket to bill: a COP card in credit 800000 with a USD 2500 purchase estimated at 10500000 reads its USD pocket owing 2500 with toBillCents 10500000, its COP pocket in credit 800000, on the overview and the screen"),
    visaRow?.currency === "COP" &&
      visaRow.creditCents === IN_CREDIT &&
      visaRow.owedCents === 0 &&
      usdOf(visaRow.otherOwed)?.owedCents === USD_PURCHASE &&
      usdOf(visaRow.otherOwed)?.creditCents === 0 &&
      usdOf(visaRow.otherOwed)?.toBillCents === PURCHASE_ESTIMATE &&
      visaScreenRow?.creditCents === IN_CREDIT &&
      usdOf(visaScreenRow.otherOwed)?.toBillCents === PURCHASE_ESTIMATE,
    `overview COP owed ${visaRow?.owedCents} credit ${visaRow?.creditCents}, USD ${pocketFigures(usdOf(visaRow?.otherOwed))}; screen USD ${pocketFigures(usdOf(visaScreenRow?.otherOwed))}`,
  );

  // --- Never summed: the peso set and the flat tiles read as if the dollar purchase were not there.
  const copWithout = copSetOf(screenWithout);
  const copWith = copSetOf(screenWith);
  const tiles = (screen: DebtsScreenData) =>
    JSON.stringify({
      owedCents: screen.totals.owedCents,
      monthlyInterestCents: screen.totals.monthlyInterestCents,
      availableCreditCents: screen.totals.availableCreditCents,
      creditLimitCents: screen.totals.creditLimitCents,
      cop: copSetOf(screen),
      nextPaymentCents: screen.totals.nextPayment?.amountCents ?? null,
      rowOwed: screen.withTerms.find((row) => row.accountId === visa)?.owedCents,
      rowAvailable: screen.withTerms.find((row) => row.accountId === visa)?.availableCreditCents,
    });
  assert(
    next("Never summed: with the USD purchase's toBillCents 10500000 beside it, the COP set, the flat tiles and the card's own owed and available read exactly as without the purchase"),
    usdOf(visaScreenRow?.otherOwed)?.toBillCents === PURCHASE_ESTIMATE &&
      copWithout !== undefined &&
      copWith?.owedCents === 0 &&
      copWith.availableCreditCents === LIMIT + IN_CREDIT &&
      tiles(screenWith) === tiles(screenWithout),
    `without ${tiles(screenWithout)}; with ${tiles(screenWith)}; USD ${pocketFigures(usdOf(visaScreenRow?.otherOwed))}`,
  );

  // --- Refund subtracts: a dollar refund still estimated lowers what is to bill.
  await move(card, {
    from: null,
    to: visa,
    amountCents: USD_REFUND,
    categoryId: cardIncome,
    currency: "USD",
    estimate: REFUND_ESTIMATE,
    description: "reembolso en dolares",
  });
  const [overviewRefund, screenRefund] = await asUser(card, () => Promise.all([getDebtOverview(), getDebtsScreenData()]));
  collect("refund", overviewRefund, screenRefund);
  const refundPocket = usdOf(overviewRefund.find((row) => row.accountId === visa)?.otherOwed);
  assert(
    next("Refund subtracts: a USD 500 refund estimated at 2000000 beside the purchase leaves the USD pocket owing 2000 with toBillCents 8500000"),
    refundPocket?.owedCents === USD_PURCHASE - USD_REFUND &&
      refundPocket.toBillCents === PURCHASE_ESTIMATE - REFUND_ESTIMATE &&
      copSetOf(screenRefund)?.owedCents === 0,
    `USD ${pocketFigures(refundPocket)}, COP owed ${copSetOf(screenRefund)?.owedCents}`,
  );

  // --- Billed drops out: two estimated purchases on one card; billing the first leaves only the second to bill.
  const biller = await createMembershipFreeUser();
  const billerExpense = await category(biller, "expense");
  const master = await open(biller, "liability", "master", 0);
  await terms(biller, master, { fixed: null, limit: LIMIT, dueDay: 5 });
  const first = await move(biller, {
    from: master,
    to: null,
    amountCents: USD_PURCHASE,
    categoryId: billerExpense,
    currency: "USD",
    estimate: PURCHASE_ESTIMATE,
    description: "primera compra en dolares",
  });
  const second = await move(biller, {
    from: master,
    to: null,
    amountCents: 1_000,
    categoryId: billerExpense,
    currency: "USD",
    estimate: 4_200_000,
    description: "segunda compra en dolares",
  });
  const billedFirst = await asUser(biller, () =>
    recordBilledAmount({ transactionId: first, accountId: master, currency: "COP", billedCents: 10_600_000 }),
  );
  const afterFirst = usdOf((await asUser(biller, () => getDebtOverview())).find((row) => row.accountId === master)?.otherOwed);
  const billedSecond = await asUser(biller, () =>
    recordBilledAmount({ transactionId: second, accountId: master, currency: "COP", billedCents: 4_300_000 }),
  );
  const [overviewBilled, screenBilled] = await asUser(biller, () => Promise.all([getDebtOverview(), getDebtsScreenData()]));
  collect("billed", overviewBilled, screenBilled);
  const afterBoth = usdOf(overviewBilled.find((row) => row.accountId === master)?.otherOwed);
  assert(
    next("Billed drops out: billing one of two estimated USD purchases leaves toBillCents 4200000, the other's estimate alone; billing both leaves no USD pocket or toBillCents null"),
    billedFirst &&
      billedSecond &&
      afterFirst?.owedCents === 1_000 &&
      afterFirst.toBillCents === 4_200_000 &&
      (afterBoth === undefined || afterBoth.toBillCents === null),
    `billed ${billedFirst}/${billedSecond}; after the first ${pocketFigures(afterFirst)}; after both ${pocketFigures(afterBoth)}`,
  );

  // --- No-terms row: the same card with no terms carries the same pocket figures.
  const bare = await createMembershipFreeUser();
  const bareBank = await open(bare, "asset", "bank", 1_000_000_000);
  const bareExpense = await category(bare, "expense");
  const bareCard = await open(bare, "liability", "sin condiciones", 0);
  await move(bare, { from: bareBank, to: bareCard, amountCents: IN_CREDIT, description: "abono" });
  await move(bare, {
    from: bareCard,
    to: null,
    amountCents: USD_PURCHASE,
    categoryId: bareExpense,
    currency: "USD",
    estimate: PURCHASE_ESTIMATE,
    description: "compra en dolares",
  });
  const [overviewBare, screenBare] = await asUser(bare, () => Promise.all([getDebtOverview(), getDebtsScreenData()]));
  collect("no terms", overviewBare, screenBare);
  const bareRow = screenBare.withoutTerms.find((debt) => debt.accountId === bareCard);
  assert(
    next("No-terms row: a COP card with no terms in credit 800000 with the same USD purchase reads USD owing 2500, toBillCents 10500000, COP credit 800000"),
    bareRow?.currency === "COP" &&
      bareRow.creditCents === IN_CREDIT &&
      bareRow.owedCents === 0 &&
      usdOf(bareRow.otherOwed)?.owedCents === USD_PURCHASE &&
      usdOf(bareRow.otherOwed)?.toBillCents === PURCHASE_ESTIMATE &&
      copSetOf(screenBare)?.owedCents === 0,
    `${bareRow === undefined ? "no row" : `COP owed ${bareRow.owedCents} credit ${bareRow.creditCents}, USD ${pocketFigures(usdOf(bareRow.otherOwed))}`}`,
  );

  // --- Next payment skips credit: the fund's only due card is in credit.
  const credited = await createMembershipFreeUser();
  const creditedBank = await open(credited, "asset", "bank", 1_000_000_000);
  const creditedCard = await open(credited, "liability", "a favor", 0);
  await terms(credited, creditedCard, { fixed: FIXED, limit: LIMIT, dueDay: 5 });
  await move(credited, { from: creditedBank, to: creditedCard, amountCents: 15_000_000, description: "abono" });
  const [overviewCredited, screenCredited] = await asUser(credited, () => Promise.all([getDebtOverview(), getDebtsScreenData()]));
  collect("credited", overviewCredited, screenCredited);
  assert(
    next("Next payment skips credit: a fund whose only card, due on the 5th, holds 15000000 in its favour has no next payment"),
    screenCredited.withTerms.some((row) => row.accountId === creditedCard && row.creditCents === 15_000_000) &&
      screenCredited.totals.nextPayment === null,
    `next payment ${show(screenCredited.totals.nextPayment)}`,
  );

  // --- Next payment skips zero, and D2: a card paid down to exactly 0 owes no minimum and is no next payment.
  const zeroed = await createMembershipFreeUser();
  const zeroedBank = await open(zeroed, "asset", "bank", 1_000_000_000);
  const zeroCard = await open(zeroed, "liability", "en cero", FIXED);
  await terms(zeroed, zeroCard, { fixed: FIXED, limit: LIMIT, dueDay: 5 });
  await move(zeroed, { from: zeroedBank, to: zeroCard, amountCents: FIXED, description: "pago total" });
  const [overviewZero, screenZero, statementZero] = await asUser(zeroed, () =>
    Promise.all([getDebtOverview(), getDebtsScreenData(), getCurrentStatement(zeroCard)]),
  );
  collect("zero", overviewZero, screenZero);
  integerFigures.push(["zero statement minimum", statementZero?.minimumPaymentCents]);
  const zeroRow = overviewZero.find((row) => row.accountId === zeroCard);
  assert(
    next("Next payment skips zero: a fund whose only card sits at a balance of exactly 0 has no next payment"),
    zeroRow?.owedCents === 0 && zeroRow.creditCents === 0 && screenZero.totals.nextPayment === null,
    `row ${show(zeroRow && { owed: zeroRow.owedCents, credit: zeroRow.creditCents })}, next payment ${show(screenZero.totals.nextPayment)}`,
  );
  assert(
    next("D2: a card at a balance of exactly 0 whose terms fix a minimum of 5000000 has a minimum of 0, on the overview, the screen and the current statement"),
    zeroRow?.owedCents === 0 &&
      zeroRow.creditCents === 0 &&
      zeroRow.minimumPaymentCents === 0 &&
      screenZero.withTerms.find((row) => row.accountId === zeroCard)?.minimumPaymentCents === 0 &&
      statementZero?.balanceCents === 0 &&
      statementZero.minimumPaymentCents === 0,
    `overview minimum ${zeroRow?.minimumPaymentCents} at owed ${zeroRow?.owedCents}, statement minimum ${statementZero?.minimumPaymentCents} at balance ${statementZero?.balanceCents}`,
  );

  // --- Next payment owing: a card in credit due first, a card owing with no minimum due a week later.
  const two = await createMembershipFreeUser();
  const twoBank = await open(two, "asset", "bank", 1_000_000_000);
  const earlyCard = await open(two, "liability", "a favor primero", 0);
  const lateCard = await open(two, "liability", "debe despues", 3_000_000);
  // Due today is the earliest a due date can fall; the same day of the month a week on is always later.
  const earlyDay = Number(today.slice(8, 10));
  const lateDate = shiftDate(today, 7);
  await terms(two, earlyCard, { fixed: FIXED, limit: LIMIT, dueDay: earlyDay });
  await terms(two, lateCard, { fixed: null, limit: LIMIT, dueDay: Number(lateDate.slice(8, 10)) });
  await move(two, { from: twoBank, to: earlyCard, amountCents: 2_000_000, description: "abono" });
  const [overviewTwo, screenTwo] = await asUser(two, () => Promise.all([getDebtOverview(), getDebtsScreenData()]));
  collect("two", overviewTwo, screenTwo);
  const earlyRow = overviewTwo.find((row) => row.accountId === earlyCard);
  const lateRow = overviewTwo.find((row) => row.accountId === lateCard);
  const nextTwo = screenTwo.totals.nextPayment;
  assert(
    next("Next payment owing: card A in credit due today, card B owing 3000000 with no minimum due a week later; the next payment is B's, on B's date, at B's minimum (0) plus its installments (0)"),
    earlyRow?.nextDueDate === today &&
      earlyRow.creditCents === 2_000_000 &&
      lateRow?.nextDueDate === lateDate &&
      lateRow.owedCents === 3_000_000 &&
      lateRow.minimumPaymentCents === null &&
      nextTwo?.accountId === lateCard &&
      nextTwo.date === lateDate &&
      nextTwo.amountCents === 0 &&
      nextTwo.currency === "COP",
    `A due ${earlyRow?.nextDueDate} credit ${earlyRow?.creditCents}; B due ${lateRow?.nextDueDate} owed ${lateRow?.owedCents} minimum ${lateRow?.minimumPaymentCents}; next payment ${show(nextTwo)}`,
  );

  // --- D14: a currency whose only cards carry no limit has no credit set.
  const dollars = await createMembershipFreeUser();
  const usdCard = await open(dollars, "liability", "en dolares", 40_000, "USD");
  await terms(dollars, usdCard, { fixed: null, limit: null, dueDay: 5 });
  const [overviewUsd, screenUsd] = await asUser(dollars, () => Promise.all([getDebtOverview(), getDebtsScreenData()]));
  collect("usd", overviewUsd, screenUsd);
  const usdTotals = sumDebtCreditTotals(overviewUsd);
  const usdSet = screenUsd.totals.byCurrency.find((set) => set.currency === "USD");
  assert(
    next("D14: sumDebtCreditTotals over the overview's USD rows, none with a limit, answers no USD entry, and the screen's USD set has no limit and no available credit"),
    overviewUsd.some((row) => row.accountId === usdCard && row.currency === "USD" && row.creditLimitCents === null) &&
      !usdTotals.some((totals) => totals.currency === "USD") &&
      usdSet?.owedCents === 40_000 &&
      usdSet.creditLimitCents === null &&
      usdSet.availableCreditCents === null,
    `credit totals ${show(usdTotals)}; USD set ${show(usdSet)}`,
  );

  // --- Integer cents: every figure the debts reads handed out above.
  const notInteger = integerFigures.filter(([, value]) => !Number.isSafeInteger(value));
  assert(
    next("Integer cents: every owed, credit, to-bill, available, interest, minimum and next-payment figure above is a safe integer"),
    integerFigures.length > 0 && notInteger.length === 0,
    `${integerFigures.length} figures, not integer: ${JSON.stringify(notInteger.slice(0, 6))}`,
  );

  // --- The movement names the planned payment it settled (RF-161, the listing half).
  const payer = await createMembershipFreeUser();
  const payerBank = await open(payer, "asset", "bank", 50_000_000);
  const payerExpense = await category(payer, "expense");
  const PAYMENT_NAME = `Harness o6m2 arriendo ${tag}`;
  const { plannedPaymentId } = await asUser(payer, () =>
    createPlannedPayment({
      fromAccountId: payerBank,
      toAccountId: null,
      amountCents: 123_400,
      categoryId: payerExpense,
      dueDate: today,
      remindOn: null,
      description: PAYMENT_NAME,
    }),
  );
  keep("planned_payments", plannedPaymentId);
  // The movement carries a description of its own, so the name the row reads can only come from the payment.
  const settle = () =>
    asUser(payer, () =>
      settlePlannedPayment({
        plannedPaymentId,
        fromAccountId: payerBank,
        toAccountId: null,
        amountCents: 123_400,
        categoryId: payerExpense,
        occurredAt: today,
        description: `Harness o6m2 movimiento del pago ${tag}`,
      }),
    );
  const settled = await settle();
  const settledId = settled.settled ? settled.transactionId : null;
  if (settledId) track("transactions", settledId);
  const unrelated = await move(payer, { from: payerBank, to: null, amountCents: 5_000, categoryId: payerExpense, description: "mercado" });
  const foreignTarget = await move(payer, { from: payerBank, to: null, amountCents: 7_000, categoryId: payerExpense, description: "farmacia" });

  const named = settledId ? await asUser(payer, () => getTransactionById(settledId)) : null;
  assert(
    next("Row names its payment: getTransactionById on the movement that settled a planned payment carries settledPlannedPayment with that payment's id and description"),
    named !== null &&
      named.settledPlannedPayment?.id === plannedPaymentId &&
      named.settledPlannedPayment.description === PAYMENT_NAME,
    `settled ${show(settled)}; row's settledPlannedPayment ${show(named?.settledPlannedPayment)}, expected ${plannedPaymentId} «${PAYMENT_NAME}»`,
  );

  const listed = await asUser(payer, () => listTransactions({}, { limit: 20 }));
  const listedUnrelated = listed.find((row) => row.id === unrelated);
  const byIdUnrelated = await asUser(payer, () => getTransactionById(unrelated));
  assert(
    next("Others null: a movement no planned payment settled carries settledPlannedPayment null, in the list and by id"),
    listedUnrelated !== undefined &&
      byIdUnrelated !== null &&
      (listedUnrelated.settledPlannedPayment ?? null) === null &&
      (byIdUnrelated.settledPlannedPayment ?? null) === null,
    `listed ${show(listedUnrelated?.settledPlannedPayment)}, by id ${show(byIdUnrelated?.settledPlannedPayment)}`,
  );

  // --- One round trip: the list costs what the same list with no row costs, and what one plain read costs.
  const trips = async (run: () => Promise<unknown>): Promise<number> => {
    const started = roundTrips();
    await run();
    return roundTrips() - started;
  };
  const baseRead = await asUser(payer, () => trips(() => listAccounts({ archived: false })));
  const emptyList = await asUser(payer, () => trips(() => listTransactions({ id: randomUUID() }, { limit: 20 })));
  const fullList = await asUser(payer, () => trips(() => listTransactions({}, { limit: 20 })));
  const byIdTrips = settledId ? await asUser(payer, () => trips(() => getTransactionById(settledId))) : -1;
  const listedSettled = listed.find((row) => row.id === settledId);
  assert(
    next("One round trip: listTransactions({}, {limit: 20}) over three movements, one of them settling a payment, costs what an empty listing and one plain read cost, and so does getTransactionById; the settling row names its payment"),
    listed.length >= 3 &&
      listedSettled?.settledPlannedPayment?.id === plannedPaymentId &&
      fullList === emptyList &&
      emptyList === baseRead &&
      byIdTrips === baseRead,
    `${listed.length} rows; trips: list ${fullList}, empty list ${emptyList}, listAccounts ${baseRead}, by id ${byIdTrips}; settling row ${show(listedSettled?.settledPlannedPayment)}`,
  );

  // --- Unreadable payment: a payment in a stranger's scope that points at this fund's movement never shows.
  const stranger = await createMembershipFreeUser();
  const strangerBank = await open(stranger, "asset", "bank", 50_000_000);
  const strangerClaims = JSON.stringify({ sub: stranger.id, role: "authenticated", aud: "authenticated" });
  // Written as the owner: no write path of the app links a payment to a movement outside its scope, and the
  // read must hold whatever row the table holds.
  const [foreignPayment] = await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${strangerClaims}, true)`;
    return tx<{ id: string }[]>`
      insert into planned_payments (from_account_id, amount_cents, due_date, description, status, settled_transaction_id)
      values (${strangerBank}, 7000, ${today}, ${`Harness o6m2 ajeno ${tag}`}, 'done', ${foreignTarget})
      returning id`;
  });
  track("planned_payments", foreignPayment.id);
  const ownView = await asUser(payer, () => getTransactionById(foreignTarget));
  const strangerView = settledId ? await asUser(stranger, () => getTransactionById(settledId)) : "no movement";
  assert(
    next("Unreadable payment: a movement whose settling payment lies in another scope reads settledPlannedPayment null for its own fund, and a stranger reading the fund's settling movement gets no row"),
    ownView !== null &&
      "settledPlannedPayment" in ownView &&
      ownView.settledPlannedPayment === null &&
      strangerView === null,
    `own fund reads ${ownView === null ? "no row" : show(ownView.settledPlannedPayment)} (field present: ${ownView !== null && "settledPlannedPayment" in ownView}); stranger reads ${show(strangerView)}`,
  );
  // Dropped here: the purge deletes the movement it points at, and the scope trigger would hand the unlinked row to
  // whoever deleted it, which then blocks that identity's own drop.
  await fixtureSql`delete from planned_payments where id = ${foreignPayment.id}`;

  // --- After RF-161: deleting the settling movement returns the payment to pending; settling it again is named again.
  const deleted = settledId ? await asUser(payer, () => deleteTransaction({ transactionId: settledId })) : "no movement";
  const afterDelete = (await asUser(payer, () => listPlannedPayments())).find((row) => row.id === plannedPaymentId);
  const resettled = await settle();
  const resettledId = resettled.settled ? resettled.transactionId : null;
  if (resettledId) track("transactions", resettledId);
  const renamed = resettledId ? await asUser(payer, () => getTransactionById(resettledId)) : null;
  assert(
    next("After RF-161: deleting the settling movement leaves the payment pending and unlinked; a fresh movement settling it again names it"),
    deleted === "done" &&
      afterDelete?.status === "pending" &&
      afterDelete.settledTransactionId === null &&
      resettledId !== null &&
      resettledId !== settledId &&
      renamed?.settledPlannedPayment?.id === plannedPaymentId &&
      renamed.settledPlannedPayment.description === PAYMENT_NAME,
    `delete ${deleted}; payment ${show(afterDelete && { status: afterDelete.status, settled: afterDelete.settledTransactionId })}; resettle ${show(resettled)}; new row ${show(renamed?.settledPlannedPayment)}`,
  );
}

// O6-M3: a backup restores a card opened in debt with the opening it had, never signed twice (RF-142, RF-52); an asset
// opened negative stays refused; a commit handed an errored row writes nothing and says so in the import's own words
// (RF-51); a blank-currency re-import keeps a dollar purchase's second amount (RF-122, RF-123); and new movements land
// through the batch, never the row-by-row fallback (RNF-15). Every holder is fresh, so each fund reads only its own rows.
async function o6m3BackupRestoreSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const OPENING = 15_000_000;
  const BANK_OPENING = 900_000_000;
  const USD_CENTS = 2_500;
  const ESTIMATE_CENTS = 10_500_000;
  const PESO_CENTS = 4_000_000;
  const HAS_ERRORS = "data.import.errors.hasErrors";
  const show = (value: unknown) => JSON.stringify(value ?? "nothing");
  const refOf = (suffix: string) => `o6m3-${tag}-${suffix}`;
  const cardName = `Harness o6m3 tarjeta ${tag}`;
  const bankName = `Harness o6m3 banco ${tag}`;
  const categoryName = `Harness o6m3 categoria ${tag}`;

  type Opened = { cardId: string; bankId: string; categoryId: string };
  const openFund = async (holder: HarnessUser): Promise<Opened> =>
    asUser(holder, async () => {
      const { categoryId } = await createCategory({
        scope: { ownerUserId: holder.id },
        name: categoryName,
        kind: "expense",
        parentId: null,
        color: CATEGORY_COLORS[0],
      });
      track("categories", categoryId);
      const open = async (name: string, kind: "asset" | "liability", subtype: string, amountMinor: number) => {
        const { accountId } = await createAccount({
          name,
          kind,
          subtype,
          ownerUserId: holder.id,
          groupId: null,
          isShared: false,
          institution: null,
          lastFour: null,
          settlementCurrency: "COP",
          amountMinor,
          balanceOn: shiftDate(today, -60),
        } as never);
        track("accounts", accountId);
        return accountId;
      };
      return {
        categoryId,
        cardId: await open(cardName, "liability", "card", OPENING),
        bankId: await open(bankName, "asset", "bank", BANK_OPENING),
      };
    });

  const source = await createMembershipFreeUser();
  const fund = await openFund(source);
  await asUser(source, async () => {
    const book = async (from: string, amountCents: number, suffix: string, foreign?: { counterAmountCents: number; counterIsEstimate: boolean }) => {
      const { transactionId } = await createTransaction({
        fromAccountId: from,
        toAccountId: null,
        amountCents,
        ...(foreign ? { currency: "USD", ...foreign } : {}),
        occurredAt: shiftDate(today, -5),
        description: `Harness o6m3 ${suffix} ${tag}`,
        externalRef: refOf(suffix),
        splits: [{ categoryId: fund.categoryId, amountCents }],
        labelIds: [],
      } as never);
      track("transactions", transactionId);
    };
    await book(fund.cardId, USD_CENTS, "usd", { counterAmountCents: ESTIMATE_CENTS, counterIsEstimate: true });
    await book(fund.cardId, PESO_CENTS, "peso");
    await book(fund.bankId, PESO_CENTS, "bank");
  });

  // ---- 4b: an account created by the form carries its id as its stable key.
  const keyed = await fixtureSql<{ id: string; external_ref: string | null }[]>`
    select id::text as id, external_ref from accounts where id in (${fund.cardId}, ${fund.bankId}) order by id`;
  console.log(
    `REPORT  4b: select id::text, external_ref from accounts where id in (card, bank) → ${show(keyed)}`,
  );
  assert(
    next("4b: an account created through createAccount reads external_ref equal to its own id as text"),
    keyed.length === 2 && keyed.every((row) => row.external_ref === row.id),
    show(keyed),
  );

  const labels: ReverseSheetLabels = {
    entityBySheetName: new Map(SHEET_ENTITIES.map((entity) => [`sheets.${entity}`, entity] as const)),
    columnKeyByHeader: new Map(
      SHEET_ENTITIES.map(
        (entity) =>
          [entity, new Map(sheetDescriptors[entity].columns.map((column) => [`columns.${column.key}`, column.key] as const))] as const,
      ),
    ),
  };
  const sheetLabels = {
    sheetName: (entity: string) => `sheets.${entity}`,
    columnHeader: (key: string) => `columns.${key}`,
  };
  type Rows = Record<string, unknown>[];
  const fileOf = async (data: { accounts?: Rows; categories?: Rows; transactions?: Rows }) =>
    new Uint8Array(await buildWorkbook({ data: data as never, labels: sheetLabels }).xlsx.writeBuffer());

  // A file in, the commit input out, each row as the pipeline left it: its errors ride along.
  const prepare = async (user: HarnessUser, bytes: Uint8Array) => {
    const parsed = await parseWorkbook({ buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, labels });
    const importScope = await asUser(user, () => readImportScope());
    const recordsOf = (entity: (typeof SHEET_ENTITIES)[number]) => (parsed[entity] ?? []).map((row) => row.record as RawRow);
    const refs = buildEffectiveRefs(importScope, recordsOf);
    const rows = (entity: (typeof SHEET_ENTITIES)[number]) =>
      (parsed[entity] ?? []).map((row, index) =>
        processRow(entity, row.record as RawRow, index, row.sheetRow, refs, importScope.existingRefs[entity]),
      );
    const [categories, accounts, transactions] = [rows("categories"), rows("accounts"), rows("transactions")];
    const errors = [...categories, ...accounts, ...transactions].flatMap((row) => row.errors.map((e) => `${e.key}@${e.column ?? ""}`));
    const input: CommitInput = {
      members: [],
      categories: categories.map((row) => ({ ...row, object: row.object as never })),
      accounts: accounts.map((row) => ({ ...row, object: row.object as never })),
      recurringRules: [],
      transactions: transactions.map((row) => ({ ...row, object: row.object as never })),
      adjustments: [],
    };
    return { input, errors, accounts };
  };
  type Committed = { outcome?: { inserted: number; updated: number }; error?: unknown; trips: number };
  const commitAs = async (user: HarnessUser, input: CommitInput): Promise<Committed> => {
    const before = roundTrips();
    try {
      const outcome = await asUser(user, () => withUserDb((tx) => commitImport(tx, input, { userId: user.id, groupId: null })));
      return { outcome, trips: roundTrips() - before };
    } catch (error) {
      return { error, trips: roundTrips() - before };
    }
  };
  const said = (result: Committed) =>
    result.error === undefined
      ? "ok"
      : `threw ${(result.error as Error)?.name} «${(result.error as Error)?.message}» (${refusal(result.error)})`;
  const openings = (user: HarnessUser) =>
    fixtureSql<{ name: string; opening: string }[]>`
      select name, initial_balance_cents::text as opening from accounts where owner_user_id = ${user.id} order by name`;
  const openingOf = async (user: HarnessUser, name: string) => (await openings(user)).find((row) => row.name === name)?.opening ?? null;
  const balances = (user: HarnessUser) =>
    fixtureSql<{ name: string; currency: string; balance: string }[]>`
      select a.name, b.currency, b.balance_cents::text as balance
      from account_balances b join accounts a on a.id = b.id
      where a.owner_user_id = ${user.id}
      order by a.name, b.currency`;
  const owned = async (user: HarnessUser) => {
    const [row] = await fixtureSql<{ accounts: number; categories: number; movements: number }[]>`
      select (select count(*)::int from accounts where owner_user_id = ${user.id}) as accounts,
        (select count(*)::int from categories where owner_user_id = ${user.id}) as categories,
        (select count(*)::int from transactions t join accounts a on a.id = coalesce(t.from_account_id, t.to_account_id)
          where a.owner_user_id = ${user.id}) as movements`;
    return row;
  };
  const trackOwned = async (user: HarnessUser) => {
    for (const r of await fixtureSql<{ id: string }[]>`select id from accounts where owner_user_id = ${user.id}`) track("accounts", r.id);
    for (const r of await fixtureSql<{ id: string }[]>`select id from categories where owner_user_id = ${user.id}`) track("categories", r.id);
  };
  const storedMovements = (user: HarnessUser) =>
    fixtureSql<{ ref: string; currency: string; amount: string; counter: string | null; estimate: boolean }[]>`
      select t.external_ref as ref, t.currency, t.amount_cents::text as amount,
        t.counter_amount_cents::text as counter, t.counter_is_estimate as estimate
      from transactions t
      join accounts a on a.id = coalesce(t.from_account_id, t.to_account_id)
      where a.owner_user_id = ${user.id}
      order by t.external_ref`;

  // ---- The fund's own backup, as the export writes it.
  const exported = await asUser(source, () => readExport({ entityKeys: ["accounts", "categories", "transactions"] }));
  const accountRows = (exported.accounts ?? []).filter((row) => [cardName, bankName].includes(String(row.name))) as Rows;
  const categoryRows = (exported.categories ?? []).filter((row) => String(row.name) === categoryName) as Rows;
  const movementRows = (exported.transactions ?? []).filter((row) => String(row.externalRef).startsWith(`o6m3-${tag}-`)) as Rows;
  const exportedCard = accountRows.find((row) => row.name === cardName);
  assert(
    next("RF-142: the export writes a card opened at 150000 owed as -15000000 cents, the shape an older backup already carries"),
    accountRows.length === 2 && categoryRows.length === 1 && movementRows.length === 3 && exportedCard?.amount === -OPENING,
    `accounts ${accountRows.length}, categories ${categoryRows.length}, movements ${movementRows.length}; card amount ${show(exportedCard?.amount)}`,
  );
  const original = await fileOf({ accounts: accountRows, categories: categoryRows, transactions: movementRows });
  const positive = await fileOf({
    accounts: accountRows.map((row) => (row.name === cardName ? { ...row, amount: OPENING } : row)),
    categories: categoryRows,
    transactions: movementRows,
  });
  const sourceBalances = await balances(source);

  // ---- Liability negative restores: the backup into a fund that has never seen it.
  const clean = await createMembershipFreeUser();
  const first = await prepare(clean, original);
  const firstCommit = await commitAs(clean, first.input);
  await trackOwned(clean);
  const cleanBalances = await balances(clean);
  assert(
    next("Liability negative restores: a backup holding a card opened at -150000 imports into a new fund with its opening -15000000 and every balance as it was"),
    first.errors.length === 0 &&
      said(firstCommit) === "ok" &&
      (await openingOf(clean, cardName)) === String(-OPENING) &&
      (await openingOf(clean, bankName)) === String(BANK_OPENING) &&
      sourceBalances.length > 0 &&
      JSON.stringify(cleanBalances) === JSON.stringify(sourceBalances),
    `file errors [${first.errors.join(",")}]; commit ${said(firstCommit)}; openings ${show(await openings(clean))}; balances source ${show(sourceBalances)} restored ${show(cleanBalances)}`,
  );

  // ---- No double sign on the update path: the same backup, then the unsigned one, over the restored card.
  const again = await prepare(clean, original);
  const againCommit = await commitAs(clean, again.input);
  const afterSigned = await openingOf(clean, cardName);
  const unsigned = await prepare(clean, positive);
  const unsignedCommit = await commitAs(clean, unsigned.input);
  const afterUnsigned = await openingOf(clean, cardName);
  assert(
    next("No double sign, update: re-importing the backup over the restored card, signed or not, updates it and leaves its opening at -15000000"),
    again.errors.length === 0 &&
      again.accounts.find((row) => row.externalRef === exportedCard?.externalRef)?.status === "update" &&
      said(againCommit) === "ok" &&
      againCommit.outcome?.inserted === 0 &&
      afterSigned === String(-OPENING) &&
      unsigned.errors.length === 0 &&
      said(unsignedCommit) === "ok" &&
      afterUnsigned === String(-OPENING) &&
      JSON.stringify(await balances(clean)) === JSON.stringify(sourceBalances),
    `signed: errors [${again.errors.join(",")}], commit ${said(againCommit)} ${show(againCommit.outcome)}, opening ${afterSigned}; unsigned: errors [${unsigned.errors.join(",")}], commit ${said(unsignedCommit)}, opening ${afterUnsigned}`,
  );

  // ---- Liability positive restores: a sheet that wrote the card's debt without its minus.
  const fromPositive = await createMembershipFreeUser();
  const positiveRun = await prepare(fromPositive, positive);
  const positiveCommit = await commitAs(fromPositive, positiveRun.input);
  await trackOwned(fromPositive);
  assert(
    next("Liability positive restores: a sheet with 150000 on a card imports it with its opening -15000000"),
    positiveRun.errors.length === 0 && said(positiveCommit) === "ok" && (await openingOf(fromPositive, cardName)) === String(-OPENING),
    `file errors [${positiveRun.errors.join(",")}]; commit ${said(positiveCommit)}; openings ${show(await openings(fromPositive))}`,
  );

  // ---- An errored row reaches the commit: nothing is written, and the refusal is the import's own.
  const bankAt = (name: string, ref: string, amount: number) => ({
    ...accountRows.find((row) => row.name === bankName)!,
    name,
    externalRef: refOf(ref),
    amount,
  });
  const doomed = await createMembershipFreeUser();
  const lone = await prepare(doomed, await fileOf({ accounts: [bankAt(`Harness o6m3 negativo ${tag}`, "negative", -10_000)] }));
  const loneCommit = await commitAs(doomed, lone.input);
  const loneLeft = await owned(doomed);
  assert(
    next("Asset negative refused: an asset row opened at -100 reaches the commit with accounts.errors.amountInvalid on amount"),
    lone.errors.length === 1 && lone.errors[0] === "accounts.errors.amountInvalid@amount",
    `file errors [${lone.errors.join(",")}]`,
  );
  assert(
    next("Errored row refused: commitImport handed one errored account row throws ActionError data.import.errors.hasErrors and writes no row"),
    loneCommit.error instanceof ActionError &&
      (loneCommit.error as ActionError).message === HAS_ERRORS &&
      loneLeft.accounts === 0 &&
      loneLeft.categories === 0 &&
      loneLeft.movements === 0,
    `${said(loneCommit)}; left ${show(loneLeft)}`,
  );

  const beside = await prepare(
    doomed,
    await fileOf({ accounts: [bankAt(`Harness o6m3 limpia ${tag}`, "clean", 10_000), bankAt(`Harness o6m3 negativa ${tag}`, "negative-2", -10_000)] }),
  );
  const besideCommit = await commitAs(doomed, beside.input);
  const strayMovement = { ...movementRows.find((row) => row.externalRef === refOf("bank"))!, externalRef: refOf("stray"), fromAccount: `Harness o6m3 nadie ${tag}` };
  const cleanAccountErroredMovement = await prepare(
    doomed,
    await fileOf({ accounts: [bankAt(`Harness o6m3 limpia dos ${tag}`, "clean-2", 10_000)], categories: categoryRows, transactions: [strayMovement] }),
  );
  const movementCommit = await commitAs(doomed, cleanAccountErroredMovement.input);
  await trackOwned(doomed);
  const besideLeft = await owned(doomed);
  assert(
    next("All or nothing: a clean row beside an errored one, in the same sheet or another, is not written either; each commit refuses with hasErrors"),
    beside.errors.length === 1 &&
      cleanAccountErroredMovement.errors.length > 0 &&
      cleanAccountErroredMovement.errors.every((error) => error.endsWith("@fromAccount")) &&
      besideCommit.error instanceof ActionError &&
      (besideCommit.error as ActionError).message === HAS_ERRORS &&
      movementCommit.error instanceof ActionError &&
      (movementCommit.error as ActionError).message === HAS_ERRORS &&
      besideLeft.accounts === 0 &&
      besideLeft.categories === 0 &&
      besideLeft.movements === 0,
    `same sheet: errors [${beside.errors.join(",")}], ${said(besideCommit)}; across sheets: errors [${cleanAccountErroredMovement.errors.join(",")}], ${said(movementCommit)}; left ${show(besideLeft)}`,
  );

  // ---- C6, C7: an old sheet's blank currency over a stored dollar purchase.
  const blankCurrency = movementRows
    .filter((row) => row.externalRef === refOf("usd"))
    .map((row) => ({ ...row, currency: null, counterAmount: null, counterIsEstimate: null }));
  const storedBefore = (await storedMovements(source)).find((row) => row.ref === refOf("usd"));
  const blank = await prepare(source, await fileOf({ transactions: blankCurrency }));
  const blankCommit = await commitAs(source, blank.input);
  const storedAfter = (await storedMovements(source)).find((row) => row.ref === refOf("usd"));
  assert(
    next("C6 / C7: a blank-currency re-import over a dollar purchase keeps its 105000 on the card and its estimate mark as stored"),
    storedBefore?.counter === String(ESTIMATE_CENTS) &&
      storedBefore.estimate === true &&
      blank.errors.length === 0 &&
      blank.input.transactions.length === 1 &&
      blank.input.transactions[0].status === "update" &&
      said(blankCommit) === "ok" &&
      blankCommit.outcome?.updated === 1 &&
      JSON.stringify(storedAfter) === JSON.stringify(storedBefore),
    `before ${show(storedBefore)}; file errors [${blank.errors.join(",")}]; commit ${said(blankCommit)} ${show(blankCommit.outcome)}; after ${show(storedAfter)}`,
  );

  // ---- C8: new movements land through the batch, whose round trips do not grow with the file.
  const batcher = await createMembershipFreeUser();
  await openFund(batcher);
  const movement = (suffix: string, foreign: boolean) => ({
    externalRef: refOf(suffix),
    fromAccount: cardName,
    toAccount: null,
    amount: foreign ? USD_CENTS : PESO_CENTS,
    currency: foreign ? "USD" : "COP",
    counterAmount: foreign ? ESTIMATE_CENTS : null,
    counterIsEstimate: foreign ? true : null,
    category: categoryName,
    occurredAt: shiftDate(today, -3),
    description: `Harness o6m3 lote ${suffix} ${tag}`,
    adjustment: null,
  });
  const batchOf = (prefix: string, size: number) =>
    Array.from({ length: size }, (_, i) => movement(`${prefix}-${i}`, i === 0));
  const small = await prepare(batcher, await fileOf({ transactions: batchOf("small", 3) }));
  const smallCommit = await commitAs(batcher, small.input);
  const large = await prepare(batcher, await fileOf({ transactions: batchOf("large", 12) }));
  const largeCommit = await commitAs(batcher, large.input);
  await trackOwned(batcher);
  const batched = await storedMovements(batcher);
  const counterOf = (ref: string) => batched.find((row) => row.ref === ref)?.counter ?? null;
  assert(
    next("C8: importing 3 or 12 new movements runs the batch: the same round trips either way, every movement written, the dollar ones with their 105000"),
    small.errors.length === 0 &&
      large.errors.length === 0 &&
      said(smallCommit) === "ok" &&
      said(largeCommit) === "ok" &&
      smallCommit.outcome?.inserted === 3 &&
      largeCommit.outcome?.inserted === 12 &&
      batched.length === 15 &&
      smallCommit.trips === largeCommit.trips &&
      counterOf(refOf("small-0")) === String(ESTIMATE_CENTS) &&
      counterOf(refOf("large-0")) === String(ESTIMATE_CENTS),
    `3 rows: ${said(smallCommit)} in ${smallCommit.trips} trips; 12 rows: ${said(largeCommit)} in ${largeCommit.trips} trips; stored ${batched.length}; dollar counters ${counterOf(refOf("small-0"))}, ${counterOf(refOf("large-0"))}; errors [${[...small.errors, ...large.errors].join(",")}]`,
  );
}

// O7-M11b: what oleada-6's mutants left unproven. Each card's foreign pocket reads its own estimate to bill, one
// per currency (RF-122, RF-124); a movement two planned payments point at still reads as one row naming one of
// them (RF-161); and an errored row in any bucket refuses the whole commit, written by nobody (RF-51).
async function o7m11bSurvivorsSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const show = (value: unknown) => JSON.stringify(value ?? "nothing");
  const LIMIT = 100_000_000;

  const open = async (holder: HarnessUser, kind: "asset" | "liability", name: string, amountMinor: number): Promise<string> => {
    const { accountId } = await asUser(holder, () =>
      createAccount({
        name: `Harness o7m11b ${name} ${tag}`,
        kind,
        subtype: kind === "asset" ? "bank" : "card",
        ownerUserId: holder.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor,
        balanceOn: shiftDate(today, -30),
      }),
    );
    track("accounts", accountId);
    return accountId;
  };
  const expenseOf = async (holder: HarnessUser): Promise<string> => {
    const { categoryId } = await asUser(holder, () =>
      createCategory({ scope: { ownerUserId: holder.id }, name: `Harness o7m11b gasto ${tag}`, kind: "expense", parentId: null, color: "#B4542F" }),
    );
    keep("categories", categoryId);
    return categoryId;
  };
  const buyInDollars = async (holder: HarnessUser, card: string, categoryId: string, amountCents: number, estimate: number, what: string) => {
    const { transactionId } = await asUser(holder, () =>
      createTransaction({
        fromAccountId: card,
        toAccountId: null,
        amountCents,
        currency: "USD",
        counterAmountCents: estimate,
        counterIsEstimate: true,
        occurredAt: today,
        description: `Harness o7m11b ${what} ${tag}`,
        externalRef: null,
        splits: [{ categoryId, amountCents }],
        labelIds: [],
      }),
    );
    track("transactions", transactionId);
    return transactionId;
  };
  const pocketOf = (pockets: DebtPocket[] | undefined, currency: string) => pockets?.find((pocket) => pocket.currency === currency);

  // ---- O7: two cards in one fund, neither with terms, each with a dollar purchase of its own estimate.
  const twoCards = await createMembershipFreeUser();
  const twoExpense = await expenseOf(twoCards);
  const cardA = await open(twoCards, "liability", "tarjeta A", 0);
  const cardB = await open(twoCards, "liability", "tarjeta B", 0);
  await buyInDollars(twoCards, cardA, twoExpense, 2_500, 10_500_000, "compra A");
  await buyInDollars(twoCards, cardB, twoExpense, 1_000, 4_200_000, "compra B");
  const twoScreen = await asUser(twoCards, () => getDebtsScreenData());
  const usdA = pocketOf(twoScreen.withoutTerms.find((debt) => debt.accountId === cardA)?.otherOwed, "USD");
  const usdB = pocketOf(twoScreen.withoutTerms.find((debt) => debt.accountId === cardB)?.otherOwed, "USD");
  assert(
    next("O7: two cards, each with a USD purchase (A 2500 estimated at 10500000, B 1000 at 4200000), each read only their own toBillCents on the debts screen"),
    usdA?.owedCents === 2_500 && usdA.toBillCents === 10_500_000 && usdB?.owedCents === 1_000 && usdB.toBillCents === 4_200_000,
    `A USD ${show(usdA)}; B USD ${show(usdB)}`,
  );

  // ---- O8: one card with a dollar and a euro pocket, each estimated apart.
  // The selector offers COP and USD only, but the column holds any ISO code (RF-121); the read must hold whatever
  // the table holds, so the euro purchase is booked as a dollar one and its currency rewritten as the owner.
  const twoPockets = await createMembershipFreeUser();
  const pocketsExpense = await expenseOf(twoPockets);
  const multi = await open(twoPockets, "liability", "dos bolsillos", 0);
  await asUser(twoPockets, () =>
    upsertDebtTerms({
      accountId: multi,
      debtKind: "revolving",
      annualRate: "0.3000",
      minimumPaymentCents: null,
      minimumPaymentPct: null,
      creditLimitCents: LIMIT,
      statementCutOffDay: 20,
      paymentDueDay: 5,
      avalCents: null,
    }),
  );
  keep("debt_terms", multi);
  await buyInDollars(twoPockets, multi, pocketsExpense, 2_500, 10_500_000, "compra en dolares");
  const euro = await buyInDollars(twoPockets, multi, pocketsExpense, 1_000, 4_800_000, "compra en euros");
  await fixtureSql`update transactions set currency = 'EUR' where id = ${euro}`;
  const [multiOverview, multiScreen] = await asUser(twoPockets, () => Promise.all([getDebtOverview(), getDebtsScreenData()]));
  const overviewPockets = multiOverview.find((row) => row.accountId === multi)?.otherOwed ?? [];
  const screenPockets = multiScreen.withTerms.find((row) => row.accountId === multi)?.otherOwed ?? [];
  const pocketsRead = (pockets: DebtPocket[]) =>
    pockets.length === 2 &&
    pocketOf(pockets, "USD")?.owedCents === 2_500 &&
    pocketOf(pockets, "USD")?.toBillCents === 10_500_000 &&
    pocketOf(pockets, "EUR")?.owedCents === 1_000 &&
    pocketOf(pockets, "EUR")?.toBillCents === 4_800_000;
  assert(
    next("O8: a COP card with a USD 2500 purchase estimated at 10500000 and a EUR 1000 one at 4800000 reads two pockets, each with its own owed and toBillCents, on the overview and the screen"),
    pocketsRead(overviewPockets) && pocketsRead(screenPockets),
    `overview ${show(overviewPockets)}; screen ${show(screenPockets)}`,
  );

  // ---- X3: two planned payments point at one movement; the movement still reads as one row naming one of them.
  // No write path of the app links a second payment to a movement, and nothing in the schema forbids it: the
  // link's only index, planned_payments_settled_transaction_id_idx, is not unique.
  const payer = await createMembershipFreeUser();
  const payerBank = await open(payer, "asset", "banco", 50_000_000);
  const payerExpense = await expenseOf(payer);
  const { plannedPaymentId } = await asUser(payer, () =>
    createPlannedPayment({
      fromAccountId: payerBank,
      toAccountId: null,
      amountCents: 123_400,
      categoryId: payerExpense,
      dueDate: today,
      remindOn: null,
      description: `Harness o7m11b arriendo ${tag}`,
    }),
  );
  keep("planned_payments", plannedPaymentId);
  const settled = await asUser(payer, () =>
    settlePlannedPayment({
      plannedPaymentId,
      fromAccountId: payerBank,
      toAccountId: null,
      amountCents: 123_400,
      categoryId: payerExpense,
      occurredAt: today,
      description: `Harness o7m11b movimiento del pago ${tag}`,
    }),
  );
  const settledId = settled.settled ? settled.transactionId : null;
  if (settledId) track("transactions", settledId);
  const payerClaims = JSON.stringify({ sub: payer.id, role: "authenticated", aud: "authenticated" });
  const [secondPayment] = settledId
    ? await fixtureSql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${payerClaims}, true)`;
        return tx<{ id: string }[]>`
          insert into planned_payments (from_account_id, amount_cents, due_date, description, status, settled_transaction_id)
          values (${payerBank}, 123400, ${shiftDate(today, -1)}, ${`Harness o7m11b segundo pago ${tag}`}, 'done', ${settledId})
          returning id`;
      })
    : [];
  if (secondPayment) track("planned_payments", secondPayment.id);
  const readOrError = async <T>(run: () => Promise<T>): Promise<{ value: T | null; error: string }> => {
    try {
      return { value: await asUser(payer, run), error: "" };
    } catch (error) {
      return { value: null, error: rootMessage(error) };
    }
  };
  const doubleListed = await readOrError(() => listTransactions({}, { limit: 20 }));
  const doubleById = settledId ? await readOrError(() => getTransactionById(settledId)) : { value: null, error: "no movement" };
  const linkedRows = (doubleListed.value ?? []).filter((row) => row.id === settledId);
  const both = new Set([plannedPaymentId, secondPayment?.id]);
  const listedName = linkedRows[0]?.settledPlannedPayment?.id;
  assert(
    next("X3: a movement two planned payments point at lists once and reads by id, both naming the same one of the two payments"),
    secondPayment !== undefined &&
      doubleListed.error === "" &&
      doubleById.error === "" &&
      linkedRows.length === 1 &&
      listedName !== undefined &&
      both.has(listedName) &&
      doubleById.value?.settledPlannedPayment?.id === listedName,
    `second payment ${show(secondPayment)}; list ${doubleListed.error || `${linkedRows.length} rows naming ${show(listedName)}`}; by id ${doubleById.error || show(doubleById.value?.settledPlannedPayment)}`,
  );
  // Dropped here: the purge deletes the movement it points at, and the scope trigger would hand the unlinked row to
  // whoever deleted it, which then blocks that identity's own drop.
  if (secondPayment) await fixtureSql`delete from planned_payments where id = ${secondPayment.id}`;

  // ---- G3, G4, G5, G7: an errored row in the members, recurring rules, categories or adjustments bucket.
  const HAS_ERRORS = "data.import.errors.hasErrors";
  const cleanAccount = (i: number): CommitInput["accounts"][number] => ({
    status: "new",
    index: 0,
    sheetRow: 2,
    externalRef: `o7m11b-${tag}-a${i}`,
    placeholderId: `00000000-0000-4000-8000-${String(700 + i).padStart(12, "0")}`,
    object: {
      name: `Harness o7m11b limpia ${i} ${tag}`,
      kind: "asset",
      subtype: "bank",
      placement: "personal",
      institution: null,
      settlementCurrency: "COP",
      amount: "1000.00",
      balanceOn: shiftDate(today, -20),
    },
  });
  // The shape the pipeline hands back for a row a gate refused: its errors, and no object to write.
  const erroredRow = (i: number) => ({
    status: "new" as const,
    index: 0,
    sheetRow: 2,
    externalRef: `o7m11b-${tag}-e${i}`,
    placeholderId: null,
    object: null as never,
    errors: [{ key: "data.import.errors.required", column: "name", value: "" }],
  });
  // The control: the same clean account alone is written, so the refusals below are the errored row's doing.
  const control = await createMembershipFreeUser();
  let controlOutcome = "ok";
  try {
    await asUser(control, () =>
      withUserDb((tx) =>
        commitImport(tx, { members: [], categories: [], accounts: [cleanAccount(9)], recurringRules: [], transactions: [], adjustments: [] }, { userId: control.id, groupId: null }),
      ),
    );
  } catch (error) {
    controlOutcome = `threw ${rootMessage(error)}`;
  }
  const controlAccounts = await fixtureSql<{ id: string }[]>`select id from accounts where owner_user_id = ${control.id}`;
  for (const r of controlAccounts) track("accounts", r.id);
  assert(
    next("G control: the clean account alone commits and is written"),
    controlOutcome === "ok" && controlAccounts.length === 1,
    `${controlOutcome}; ${controlAccounts.length} accounts written`,
  );
  const buckets = ["members", "recurringRules", "categories", "adjustments"] as const;
  const refusedBy: string[] = [];
  for (const [i, bucket] of buckets.entries()) {
    const holder = await createMembershipFreeUser();
    const input: CommitInput = {
      members: [],
      categories: [],
      accounts: [cleanAccount(i)],
      recurringRules: [],
      transactions: [],
      adjustments: [],
      [bucket]: [erroredRow(i)],
    };
    let outcome = "ok";
    try {
      await asUser(holder, () => withUserDb((tx) => commitImport(tx, input, { userId: holder.id, groupId: null })));
    } catch (error) {
      outcome = error instanceof ActionError && error.message === HAS_ERRORS ? "hasErrors" : `threw ${rootMessage(error)}`;
    }
    const [left] = await fixtureSql<{ accounts: number; categories: number; rules: number; movements: number }[]>`
      select (select count(*)::int from accounts where owner_user_id = ${holder.id}) as accounts,
        (select count(*)::int from categories where owner_user_id = ${holder.id}) as categories,
        (select count(*)::int from recurring_rules where owner_user_id = ${holder.id}) as rules,
        (select count(*)::int from transactions where owner_user_id = ${holder.id}) as movements`;
    for (const r of await fixtureSql<{ id: string }[]>`select id from accounts where owner_user_id = ${holder.id}`) track("accounts", r.id);
    assert(
      next(`G: an errored row in the ${bucket} bucket beside a clean account makes commitImport refuse with ${HAS_ERRORS} and write nothing`),
      outcome === "hasErrors" && left.accounts === 0 && left.categories === 0 && left.rules === 0 && left.movements === 0,
      `${outcome}; left ${show(left)}`,
    );
    if (outcome === "hasErrors") refusedBy.push(bucket);
  }
  console.log(`REPORT  o7m11b: commits refused in words by the ${refusedBy.join(", ") || "no"} bucket(s).`);
}

// O6-M7 (RF-162, RF-51): the database refuses a movement dated before the opening of an account it names (MO001) and an
// opening moved past a movement (MO002). The words come from `handleServerError` alone, through every action that writes
// a movement; the import preview refuses the same row on `occurredAt`, and the commit names it if a row slips past.
async function o6m7OpeningRefusalsSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const OPENING = shiftDate(today, -10);
  const BEFORE = shiftDate(today, -11);
  const MOVEMENT_KEY = "errors.movementBeforeOpening";
  const OPENING_KEY = "accounts.errors.openingAfterMovement";
  const IMPORT_KEY = "data.import.errors.beforeOpening";
  // The statements `readImportScope` put on the wire under the harness before this module (oleada-6 at ab45f478); it
  // reads one more column and no more.
  const SCOPE_TRIPS = 24;
  const show = (value: unknown) => JSON.stringify(value ?? "nothing");

  type Said = { serverError?: string; validationErrors?: unknown; data?: Record<string, unknown> } | undefined;
  type Call = (input: Record<string, unknown>) => Promise<Said>;
  const movements = (await import("@/app/actions/transactions")) as unknown as {
    createTransactionAction: Call;
    updateTransactionAction: Call;
  };
  const planning = (await import("@/app/actions/planned-payments")) as unknown as { settlePlannedPaymentAction: Call };
  const installments = (await import("@/app/actions/installment-plans")) as unknown as { recordDebtPaymentAction: Call };
  const cashActions = (await import("@/app/actions/cash")) as unknown as { withdrawCashAction: Call };
  const inbox = (await import("@/app/actions/ingest")) as unknown as { acceptDeliveryAction: Call };
  const said = (result: { serverError?: string; validationErrors?: unknown } | undefined) => `serverError = ${result?.serverError ?? "none"}, validation = ${show(result?.validationErrors)}`;

  const user = await createMembershipFreeUser();
  const open = async (name: string, kind: "asset" | "liability", subtype: string, balanceOn: string, currency: "COP" | "USD" = "COP") => {
    const { accountId } = await asUser(user, () =>
      createAccount({
        name: `Harness o6m7 ${name} ${tag}`,
        kind,
        subtype,
        ownerUserId: user.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: currency,
        amountMinor: 100_000_000,
        balanceOn,
      } as never),
    );
    track("accounts", accountId);
    return accountId;
  };
  const bank = await open("banco", "asset", "bank", OPENING);
  const later = await open("banco tardio", "asset", "bank", shiftDate(today, -2));
  const card = await open("tarjeta", "liability", "card", OPENING);
  const dollars = await open("dolares", "asset", "bank", OPENING, "USD");
  const cashSource = await open("origen efectivo", "asset", "bank", OPENING);
  const lonely = await open("con movimiento", "asset", "bank", OPENING);
  const { categoryId } = await asUser(user, () =>
    createCategory({ scope: { ownerUserId: user.id }, name: `Harness o6m7 categoria ${tag}`, kind: "expense", parentId: null, color: CATEGORY_COLORS[0] }),
  );
  track("categories", categoryId);

  const expense = (over: Record<string, unknown> = {}) => ({
    fromAccountId: bank,
    toAccountId: null,
    amount: "100",
    occurredAt: shiftDate(today, -5),
    description: `Harness o6m7 gasto ${tag}`,
    splits: [{ categoryId, amount: "100" }],
    labelIds: [],
    ...over,
  });
  const create = (over: Record<string, unknown> = {}) => asUser(user, () => movements.createTransactionAction(expense(over)));
  const stored = async (account: string) =>
    fixtureSql<{ id: string; occurred_at: string }[]>`
      select id, occurred_at::text as occurred_at from transactions where from_account_id = ${account} or to_account_id = ${account}`;
  const trackStored = async (account: string) => {
    for (const row of await stored(account)) track("transactions", row.id);
  };

  // ---- Create, and the day itself.
  const refusedCreate = await create({ occurredAt: BEFORE });
  const onTheDay = await create({ occurredAt: OPENING, description: `Harness o6m7 dia ${tag}` });
  await trackStored(bank);
  assert(
    next("createTransactionAction dated the day before the opening answers errors.movementBeforeOpening and writes nothing"),
    refusedCreate?.serverError === MOVEMENT_KEY && (await stored(bank)).every((row) => row.occurred_at !== BEFORE),
    said(refusedCreate),
  );
  assert(
    next("createTransactionAction dated the opening day itself is booked"),
    onTheDay?.serverError === undefined && onTheDay?.data?.ok === true && (await stored(bank)).some((row) => row.occurred_at === OPENING),
    said(onTheDay),
  );
  const transferToLater = await create({ toAccountId: later, splits: [], occurredAt: shiftDate(today, -5), description: `Harness o6m7 traslado ${tag}` });
  assert(
    next("A transfer is refused when only its destination account opens after the day"),
    transferToLater?.serverError === MOVEMENT_KEY && (await stored(later)).length === 0,
    said(transferToLater),
  );

  // ---- Update.
  const booked = await create({ description: `Harness o6m7 editar ${tag}` });
  const bookedId = booked?.data?.transactionId as string | undefined;
  await trackStored(bank);
  const [bookedStamp] = await fixtureSql<{ stamp: string }[]>`select updated_at::text as stamp from transactions where id = ${bookedId ?? randomUUID()}`;
  const moved = await asUser(user, () =>
    movements.updateTransactionAction({ transactionId: bookedId, expectedUpdatedAt: bookedStamp?.stamp, ...expense({ occurredAt: BEFORE, description: `Harness o6m7 editar ${tag}` }) }),
  );
  const [afterMove] = await fixtureSql<{ occurred_at: string }[]>`select occurred_at::text as occurred_at from transactions where id = ${bookedId ?? randomUUID()}`;
  assert(
    next("updateTransactionAction moving the date before the opening answers the same key and keeps the stored day"),
    bookedId !== undefined && moved?.serverError === MOVEMENT_KEY && afterMove?.occurred_at === shiftDate(today, -5),
    `${said(moved)}; stored day ${afterMove?.occurred_at}`,
  );

  // ---- The other writers.
  const { plannedPaymentId } = await asUser(user, () =>
    createPlannedPayment({
      fromAccountId: bank,
      toAccountId: null,
      amountCents: 5_000,
      categoryId,
      dueDate: today,
      remindOn: null,
      description: `Harness o6m7 por pagar ${tag}`,
    }),
  );
  track("planned_payments", plannedPaymentId);
  const settled = await asUser(user, () => planning.settlePlannedPaymentAction({ plannedPaymentId, occurredAt: BEFORE }));
  assert(
    next("settlePlannedPaymentAction dated before the opening answers the same key and leaves the payment pending"),
    settled?.serverError === MOVEMENT_KEY && (await readColumn<string>("planned_payments", "id", plannedPaymentId, "status")) === "pending",
    `${said(settled)}; status ${await readColumn("planned_payments", "id", plannedPaymentId, "status")}`,
  );

  const paid = await asUser(user, () =>
    installments.recordDebtPaymentAction({ fromAccountId: bank, toAccountId: card, amount: "100", occurredAt: BEFORE }),
  );
  assert(
    next("recordDebtPaymentAction dated before the opening answers the same key"),
    paid?.serverError === MOVEMENT_KEY && (await stored(card)).length === 0,
    said(paid),
  );

  // A withdrawal is dated today, so the opening has to be the one in the future.
  await fixtureSql`update accounts set initial_balance_on = ${shiftDate(today, 3)}::date where id = ${cashSource}`;
  const withdrawn = await asUser(user, () => cashActions.withdrawCashAction({ sourceAccountId: cashSource, amount: "100" }));
  assert(
    next("withdrawCashAction from an account that opens after today answers the same key and moves no cash"),
    withdrawn?.serverError === MOVEMENT_KEY && (await stored(cashSource)).length === 0,
    said(withdrawn),
  );

  const claims = JSON.stringify({ sub: user.id, role: "authenticated", aud: "authenticated" });
  const deliveryId = await fixtureSql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    const [row] = await tx<{ id: string }[]>`
      insert into ingest_deliveries (external_ref, raw_text, shape_hash)
      values (${`harness-o6m7-${tag}`}, ${`Harness o6m7 mensaje ${tag}`}, ${createHash("sha256").update(`o6m7-${tag}`).digest("hex")})
      returning id`;
    return row.id;
  });
  const accepted = await asUser(user, () =>
    inbox.acceptDeliveryAction({
      deliveryId,
      fromAccountId: bank,
      toAccountId: null,
      amount: "100",
      occurredAt: BEFORE,
      description: `Harness o6m7 bandeja ${tag}`,
      splits: [{ categoryId, amount: "100" }],
      labelIds: [],
    }),
  );
  assert(
    next("acceptDeliveryAction dated before the opening answers the same key and leaves the proposal pending"),
    accepted?.serverError === MOVEMENT_KEY && (await readColumn<string>("ingest_deliveries", "id", deliveryId, "status")) === "pending",
    `${said(accepted)}; status ${await readColumn("ingest_deliveries", "id", deliveryId, "status")}`,
  );

  // ---- The opening moved past a movement.
  await asUser(user, () => movements.createTransactionAction(expense({ fromAccountId: lonely, description: `Harness o6m7 solo ${tag}` })));
  await trackStored(lonely);
  const stamp = async () => (await fixtureSql<{ stamp: string }[]>`select updated_at::text as stamp from accounts where id = ${lonely}`)[0].stamp;
  const editOpening = async (balanceOn: string) =>
    asUser(user, async () =>
      updateAccountAction({
        accountId: lonely,
        expectedUpdatedAt: await stamp(),
        name: `Harness o6m7 con movimiento ${tag}`,
        kind: "asset",
        subtype: "bank",
        isShared: false,
        institution: "",
        lastFour: "",
        settlementCurrency: "COP",
        amount: "1000000",
        balanceOn,
      }),
    );
  const openingOf = async () => (await fixtureSql<{ day: string }[]>`select initial_balance_on::text as day from accounts where id = ${lonely}`)[0].day;
  const pastMovement = await editOpening(shiftDate(today, -3));
  const openingAfterRefusal = String(await openingOf());
  assert(
    next("updateAccountAction moving the opening past a movement answers accounts.errors.openingAfterMovement and keeps the day"),
    pastMovement?.serverError === OPENING_KEY && openingAfterRefusal === OPENING,
    `${said(pastMovement)}; opening ${openingAfterRefusal}`,
  );
  const upToMovement = await editOpening(shiftDate(today, -5));
  assert(
    next("updateAccountAction moving the opening up to the day of its first movement is saved"),
    upToMovement?.serverError === undefined && (await openingOf()) === shiftDate(today, -5),
    `${said(upToMovement)}; opening ${await openingOf()}`,
  );

  // ---- What is not these two codes reads as before.
  const crossCurrency = await create({ fromAccountId: bank, toAccountId: dollars, splits: [], description: `Harness o6m7 divisas ${tag}` });
  assert(
    next("A transfer between a peso and a dollar account still answers transactions.errors.currencyMismatch"),
    crossCurrency?.serverError === "transactions.errors.currencyMismatch",
    said(crossCurrency),
  );
  const strangerAccount = await create({ fromAccountId: randomUUID(), description: `Harness o6m7 ajena ${tag}` });
  assert(
    next("A movement from an account that does not exist still answers errors.notFound, never the opening words"),
    strangerAccount?.serverError === "errors.notFound",
    said(strangerAccount),
  );

  // ---- The import preview.
  const importScope = await asUser(user, () => readImportScope());
  const scoped = (id: string) => importScope.accounts.find((account) => account.id === id) as unknown as { initialBalanceOn?: string } | undefined;
  assert(
    next("The import scope hands the pipeline each account's opening day"),
    scoped(bank)?.initialBalanceOn === OPENING && scoped(later)?.initialBalanceOn === shiftDate(today, -2),
    `bank ${scoped(bank)?.initialBalanceOn}, later ${scoped(later)?.initialBalanceOn}`,
  );
  const tripsBefore = roundTrips();
  await asUser(user, () => readImportScope());
  const scopeTrips = roundTrips() - tripsBefore;
  assert(next("The import scope read spends the round trips it spent before"), scopeTrips === SCOPE_TRIPS, `${scopeTrips} round trips, expected ${SCOPE_TRIPS}`);

  const bankName = `Harness o6m7 banco ${tag}`;
  const row = (account: string, occurredAt: string, over: Record<string, string | number | boolean | null> = {}): RawRow => ({
    externalRef: null,
    fromAccount: account,
    toAccount: null,
    amount: 100,
    currency: null,
    category: `Harness o6m7 categoria ${tag}`,
    occurredAt,
    description: `Harness o6m7 fila ${tag}`,
    adjustment: null,
    ...over,
  });
  const preview = (entityRows: RawRow[], newAccounts: RawRow[] = []) => {
    const refs = buildEffectiveRefs(importScope, (entity) => (entity === "accounts" ? newAccounts : []));
    const processed = entityRows.map((raw, index) => processRow("transactions", raw, index, index + 2, refs, importScope.existingRefs.transactions));
    const accountRows = newAccounts.map((raw, index) => processRow("accounts", raw, index, index + 2, refs, importScope.existingRefs.accounts));
    return { processed, accountRows, errorRows: [...processed, ...accountRows].filter((r) => r.errors.length > 0).length };
  };
  const words = (r: { errors: { key: string; column: string | null }[] }) => r.errors.map((e) => `${e.key}@${e.column}`);
  const wanted = [`${IMPORT_KEY}@occurredAt`];

  const before = preview([row(bankName, BEFORE)]);
  const onDay = preview([row(bankName, OPENING)]);
  assert(
    next("Preview: a row dated the day before an existing account's opening is refused on occurredAt and counted; the opening day is clean"),
    JSON.stringify(words(before.processed[0])) === JSON.stringify(wanted) &&
      before.processed[0].object === null &&
      before.errorRows === 1 &&
      onDay.processed[0].errors.length === 0 &&
      onDay.errorRows === 0,
    `before ${show(words(before.processed[0]))}, on the day ${show(words(onDay.processed[0]))}`,
  );
  const lateBank = `Harness o6m7 banco tardio ${tag}`;
  const lateTransfer = preview([row(bankName, shiftDate(today, -5), { toAccount: lateBank, category: null })]);
  assert(
    next("Preview: a transfer is refused when its second account is the one that opens after the day"),
    JSON.stringify(words(lateTransfer.processed[0])) === JSON.stringify(wanted),
    show(words(lateTransfer.processed[0])),
  );

  const freshName = `Harness o6m7 nueva ${tag}`;
  const fresh: RawRow = {
    externalRef: `o6m7-${tag}`,
    name: freshName,
    kind: "asset",
    subtype: "bank",
    placement: "personal",
    institution: null,
    amount: 1000,
    balanceOn: shiftDate(today, -4),
    settlementCurrency: "COP",
  };
  const freshBefore = preview([row(freshName, shiftDate(today, -6))], [fresh]);
  const freshOnDay = preview([row(freshName, shiftDate(today, -4))], [fresh]);
  assert(
    next("Preview: a movement earlier than the opening of an account created in the same file is refused on occurredAt and counted; on the day it is clean"),
    freshBefore.accountRows.every((r) => r.errors.length === 0) &&
      JSON.stringify(words(freshBefore.processed[0])) === JSON.stringify(wanted) &&
      freshBefore.errorRows === 1 &&
      freshOnDay.errorRows === 0,
    `before ${show(words(freshBefore.processed[0]))}, on the day ${show(words(freshOnDay.processed[0]))}`,
  );

  // ---- The commit, handed a row the preview did not stop.
  const clean = onDay.processed[0];
  const slipped = { ...clean, sheetRow: 7, object: { ...(clean.object as object), occurredAt: BEFORE } as never };
  const commitInput: CommitInput = { members: [], categories: [], accounts: [], recurringRules: [], transactions: [slipped], adjustments: [] };
  let commitError: unknown;
  try {
    await asUser(user, () => withUserDb((tx) => commitImport(tx, commitInput, { userId: user.id, groupId: null })));
  } catch (error) {
    commitError = error;
  }
  let named: { entity?: string; sheetRow?: number; reasonKey?: string } = {};
  try {
    named = JSON.parse((commitError as Error).message);
  } catch {
    named = {};
  }
  const landed = await fixtureSql<{ n: number }[]>`
    select count(*)::int as n from transactions where owner_user_id = ${user.id} and description = ${`Harness o6m7 fila ${tag}`}`;
  assert(
    next("Commit: a row dated before the opening that slipped past the preview is refused naming its row with data.import.errors.beforeOpening"),
    clean.errors.length === 0 &&
      commitError instanceof ActionError &&
      named.entity === "transactions" &&
      named.sheetRow === 7 &&
      named.reasonKey === IMPORT_KEY &&
      landed[0].n === 0,
    `${show(named)}; rows written ${landed[0].n}; ${commitError === undefined ? "no error" : refusal(commitError)}`,
  );

  await fixtureSql`delete from ingest_deliveries where owner_user_id = ${user.id}`;
}

// The detail's pockets carry the same estimate the overview does: a purchase adds, a refund takes away.
async function detailPocketToBillSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const PURCHASE_ESTIMATE = 10_500_000;
  const REFUND_ESTIMATE = 2_000_000;
  const holder = await createMembershipFreeUser();
  const open = async (kind: "asset" | "liability", name: string, amountMinor: number): Promise<string> => {
    const { accountId } = await asUser(holder, () =>
      createAccount({
        name: `Harness detail ${name} ${tag}`,
        kind,
        subtype: kind === "asset" ? "bank" : "card",
        ownerUserId: holder.id,
        groupId: null,
        isShared: false,
        institution: null,
        lastFour: null,
        settlementCurrency: "COP",
        amountMinor,
        balanceOn: shiftDate(today, -30),
      }),
    );
    track("accounts", accountId);
    return accountId;
  };
  const category = async (kind: "expense" | "income"): Promise<string> => {
    const { categoryId } = await asUser(holder, () =>
      createCategory({ scope: { ownerUserId: holder.id }, name: `Harness detail ${kind} ${tag}`, kind, parentId: null, color: "#B4542F" }),
    );
    track("categories", categoryId);
    return categoryId;
  };
  const usd = async (from: string | null, to: string | null, amountCents: number, estimate: number, categoryId: string, label: string) => {
    const { transactionId } = await asUser(holder, () =>
      createTransaction({
        fromAccountId: from,
        toAccountId: to,
        amountCents,
        currency: "USD",
        counterAmountCents: estimate,
        counterIsEstimate: true,
        occurredAt: today,
        description: `Harness detail ${label} ${tag}`,
        externalRef: null,
        splits: [{ categoryId, amountCents }],
        labelIds: [],
      }),
    );
    track("transactions", transactionId);
  };
  const toBill = async (card: string) => {
    const detail = await asUser(holder, () => getDebtDetail(card));
    return detail?.account.balances.find((pocket) => pocket.currency === "USD")?.toBillCents;
  };

  const card = await open("liability", "tarjeta", 0);
  const expense = await category("expense");
  const income = await category("income");
  const none = (await asUser(holder, () => getDebtDetail(card)))?.account.balances.find((pocket) => pocket.currency === "USD");
  await usd(card, null, 2_500, PURCHASE_ESTIMATE, expense, "compra");
  const purchaseOnly = await toBill(card);
  await usd(null, card, 500, REFUND_ESTIMATE, income, "reembolso");
  const withRefund = await toBill(card);
  assert(
    next("Detail pocket to bill: nothing pending is null, a USD purchase estimated at 10500000 reads 10500000, and a USD refund estimated at 2000000 beside it reads 8500000"),
    none === undefined && purchaseOnly === PURCHASE_ESTIMATE && withRefund === PURCHASE_ESTIMATE - REFUND_ESTIMATE,
    `no pocket ${none === undefined}, purchase ${purchaseOnly}, with refund ${withRefund}`,
  );
}

// O7-M3 (RF-155, O7-Q2 a): «Revisar el mes» reads last month's items by its four rules in one
// statement, marks each «Está bien» once, and quick entry's words flag rides the create path.
async function o7m3MonthReviewSuite(): Promise<void> {
  console.log("");
  const tag = randomUUID().slice(0, 8);
  const today = todayInBogota();
  const month = shiftMonth(today, -1);
  const day = (n: number, back = 1) => `${shiftMonth(today, -back)}-${String(n).padStart(2, "0")}`;
  const holder = await createMembershipFreeUser();
  const stranger = await createMembershipFreeUser();
  const movements = (await import("@/app/actions/transactions")) as unknown as {
    createTransactionAction: (input: Record<string, unknown>) => Promise<{ serverError?: string; data?: { transactionId: string } } | undefined>;
  };
  const review = (await import("@/app/actions/month-review")) as unknown as {
    markReviewedAction: (input: Record<string, unknown>) => Promise<{ serverError?: string } | undefined>;
  };

  const open = async (name: string, amountMinor: number): Promise<string> => {
    const { accountId } = await asUser(holder, () =>
      createAccount({
        name: `Harness o7m3 ${name} ${tag}`, kind: "asset", subtype: "bank", ownerUserId: holder.id, groupId: null,
        isShared: false, institution: null, lastFour: null, settlementCurrency: "COP", amountMinor, balanceOn: day(1, 9),
      }),
    );
    track("accounts", accountId);
    return accountId;
  };
  const category = async (name: string): Promise<string> => {
    const { categoryId } = await asUser(holder, () =>
      createCategory({ scope: { ownerUserId: holder.id }, name: `Harness o7m3 ${name} ${tag}`, kind: "expense", parentId: null, color: "#B4542F" }),
    );
    track("categories", categoryId);
    return categoryId;
  };
  const spend = async (account: string, categoryId: string, amountCents: number, occurredAt: string, extra: Record<string, unknown> = {}) => {
    const { transactionId } = await asUser(holder, () =>
      createTransaction({
        fromAccountId: account, toAccountId: null, amountCents, occurredAt, description: `Harness o7m3 ${tag}`,
        externalRef: null, splits: [{ categoryId, amountCents }], labelIds: [], ...extra,
      }),
    );
    track("transactions", transactionId);
    return transactionId;
  };

  const bank = await open("banco", 500_000_000);
  const counted = await open("cuadre", 50_000_000);
  const other = await open("otra", 50_000_000);
  const usual = await category("mercado");
  const thin = await category("ropa");
  const plain = await category("varios");

  // Above usual: three splits of 100.000 in the six months before, then 400.000 in the month.
  await spend(bank, usual, 10_000_000, day(10, 4));
  await spend(bank, usual, 10_000_000, day(10, 3));
  await spend(bank, usual, 10_000_000, day(10, 2));
  const big = await spend(bank, usual, 40_000_000, day(10));
  // Not enough history: two splits in the window and one seven months back.
  await spend(bank, thin, 10_000_000, day(5, 8));
  await spend(bank, thin, 10_000_000, day(5, 3));
  await spend(bank, thin, 10_000_000, day(5, 2));
  await spend(bank, thin, 40_000_000, day(5));
  // Currency apart: a USD split against the COP history raises nothing.
  await spend(bank, usual, 40_000_000, day(12), { currency: "USD", counterAmountCents: 160_000_000, counterIsEstimate: true });
  // Twins: two equal expenses on one account and day; the same amount on another day, or on the
  // same day from another account, is not one.
  const twinA = await spend(bank, plain, 5_000_000, day(15));
  const twinB = await spend(bank, plain, 5_000_000, day(15));
  await spend(bank, plain, 5_000_000, day(16));
  await spend(other, plain, 5_000_000, day(15));
  // From words: quick entry's flag through the action; a form save without it stores false.
  const said = await asUser(holder, () => movements.createTransactionAction({
    fromAccountId: bank, toAccountId: null, amount: "25000", occurredAt: day(20), description: `Harness o7m3 palabras ${tag}`,
    splits: [{ categoryId: plain, amount: "25000" }], labelIds: [], amountFromWords: true,
  }));
  const plainSaid = await asUser(holder, () => movements.createTransactionAction({
    fromAccountId: bank, toAccountId: null, amount: "26000", occurredAt: day(21), description: `Harness o7m3 formulario ${tag}`,
    splits: [{ categoryId: plain, amount: "26000" }], labelIds: [],
  }));
  const words = said?.data?.transactionId ?? "";
  const formMade = plainSaid?.data?.transactionId ?? "";
  for (const id of [words, formMade]) if (id) track("transactions", id);
  const flags = await fixtureSql<{ id: string; amount_from_words: boolean }[]>`
    select id, amount_from_words from transactions where id in (${words || randomUUID()}, ${formMade || randomUUID()})`;
  const flagOf = (id: string) => flags.find((row) => row.id === id)?.amount_from_words;
  assert(
    next("O7-M3 words flag: createTransactionAction with amountFromWords true stores true; without it stores false"),
    flagOf(words) === true && flagOf(formMade) === false,
    `with ${flagOf(words)}, without ${flagOf(formMade)}`,
  );
  // Gap: a count booked in the month.
  const booked = await asUser(holder, () =>
    reconcileAccount({ accountId: counted, reconciledOn: day(25), realMagnitudeCents: 52_000_000, expectedDerivedCents: 50_000_000 }),
  );
  const gapRows = await fixtureSql<{ id: string }[]>`select id from transactions where from_account_id = ${counted} or to_account_id = ${counted}`;
  for (const row of gapRows) track("transactions", row.id);

  // One statement costs what any one-statement read costs under the session's settle.
  const unitBefore = roundTrips();
  await asUser(holder, () => listDueReminders(3));
  const unit = roundTrips() - unitBefore;
  const before = roundTrips();
  const read = await asUser(holder, () => getMonthReview(month));
  const readTrips = roundTrips() - before;
  const rules = read.items.map((item) => item.rule).sort();
  const above = read.items.filter((item) => item.rule === "above_usual");
  const twins = read.items.filter((item) => item.rule === "twin");
  const fromWords = read.items.filter((item) => item.rule === "from_words");
  const gaps = read.items.filter((item) => item.rule === "reconciliation_gap");
  assert(
    next("O7-M3 items: one above usual (400.000 against a usual of 100.000), one twin with both ids, one from words, one gap with its count; nothing for thin history, another currency or another day"),
    read.items.length === 4 &&
      above.length === 1 && above[0].transactionIds[0] === big && above[0].usualCents === 10_000_000 && above[0].amountCents === 40_000_000 &&
      twins.length === 1 && [...twins[0].transactionIds].sort().join() === [twinA, twinB].sort().join() &&
      fromWords.length === 1 && fromWords[0].transactionIds[0] === words &&
      gaps.length === 1 && gaps[0].countedCents === 52_000_000 && booked !== undefined &&
      read.items.every((item) => !item.reviewed && item.canMark),
    `rules ${rules.join(",")}; above ${JSON.stringify(above.map((i) => [i.amountCents, i.usualCents]))}; twins ${twins.map((i) => i.transactionIds.length)}; gap ${gaps.map((i) => i.countedCents)}`,
  );
  assert(
    next("O7-M3 first month: the month of the holder's oldest movement"),
    read.firstMonth === shiftMonth(today, -8),
    `firstMonth ${read.firstMonth}`,
  );
  assert(next("O7-M3 one trip: getMonthReview costs what one statement costs"), readTrips === unit, `${readTrips} trips, one statement ${unit}`);

  const empty = await asUser(holder, () => getMonthReview(shiftMonth(today, -5)));
  const strangers = await asUser(stranger, () => getMonthReview(month));
  assert(
    next("O7-M3 none: a month with nothing standing out has no item, and another person reads none of the holder's"),
    empty.items.length === 0 && strangers.items.length === 0 && strangers.firstMonth === null,
    `quiet month ${empty.items.length}, stranger ${strangers.items.length}, stranger first ${strangers.firstMonth}`,
  );

  const pendingBefore = await asUser(holder, () => getMonthReviewPending());
  await asUser(holder, () => markReviewed({ transactionIds: twins[0].transactionIds, rule: "twin" }));
  await asUser(holder, () => markReviewed({ transactionIds: twins[0].transactionIds, rule: "twin" }));
  const marks = await fixtureSql<{ n: number }[]>`
    select count(*)::int as n from transaction_reviews where transaction_id in (${twinA}, ${twinB}) and rule = 'twin'`;
  const tripsBefore = roundTrips();
  const pendingAfter = await asUser(holder, () => getMonthReviewPending());
  const pendingTrips = roundTrips() - tripsBefore;
  const reread = await asUser(holder, () => getMonthReview(month));
  assert(
    next("O7-M3 mark: marking a twin twice stores one mark per id, the item reads reviewed, and the pending count of movements drops from 5 to 3 (the twin holds two) in one statement's trips"),
    marks[0].n === 2 && reread.items.find((item) => item.rule === "twin")?.reviewed === true &&
      pendingBefore?.count === 5 && pendingBefore.month === month && pendingAfter?.count === 3 && pendingTrips === unit,
    `marks ${marks[0].n}, pending ${pendingBefore?.count} → ${pendingAfter?.count} (${pendingTrips} trips)`,
  );
  const strangerPending = await asUser(stranger, () => getMonthReviewPending());
  const refused = await asUser(stranger, () => review.markReviewedAction({ transactionIds: [big], rule: "above_usual" }));
  assert(
    next("O7-M3 refused: a person who cannot write the movement is told «review.errors.cannotMark», and with nothing pending Inicio reads null"),
    refused?.serverError === "review.errors.cannotMark" && strangerPending === null,
    `serverError ${refused?.serverError}, stranger pending ${JSON.stringify(strangerPending)}`,
  );

  // A twin group past any form's size is still marked in one «Está bien».
  const many: string[] = [];
  for (let n = 0; n < 21; n += 1) many.push(await spend(bank, plain, 7_000_000, day(18)));
  const crowd = (await asUser(holder, () => getMonthReview(month))).items.find(
    (item) => item.rule === "twin" && item.transactionIds.includes(many[0]),
  );
  const crowdMarked = await asUser(holder, () =>
    review.markReviewedAction({ transactionIds: crowd?.transactionIds ?? [], rule: "twin" }),
  );
  const crowdMarks = await fixtureSql<{ n: number }[]>`
    select count(*)::int as n from transaction_reviews where transaction_id in ${fixtureSql(many)} and rule = 'twin'`;
  assert(
    next("O7-M3 crowd: a twin group of 21 is one item, and one «Está bien» through the action marks all 21"),
    crowd?.transactionIds.length === 21 && crowdMarked?.serverError === undefined && crowdMarks[0].n === 21,
    `ids ${crowd?.transactionIds.length}, serverError ${crowdMarked?.serverError}, marks ${crowdMarks[0].n}`,
  );
}

// RF-155, O7-Q1 a: a fellow who reads the leader's personal account sees its item on the screen,
// unmarkable, and Inicio's count never names it: a line they could never clear.
async function o7m3ReaderPendingSuite(userId: string, fellow: HarnessUser): Promise<void> {
  const today = todayInBogota();
  const month = shiftMonth(today, -1);
  const { accountId } = await createAccount({
    name: "Harness o7m3 ajena", kind: "asset", subtype: "bank", ownerUserId: userId, groupId: null,
    isShared: false, institution: null, lastFour: null, settlementCurrency: "COP", amountMinor: 10_000_000,
    balanceOn: `${shiftMonth(today, -2)}-01`,
  });
  track("accounts", accountId);
  const { categoryId } = await createCategory({
    scope: { ownerUserId: userId }, name: "Harness o7m3 ajena", kind: "expense", parentId: null, color: "#B4542F",
  });
  track("categories", categoryId);
  const pendingBefore = await asUser(fellow, () => getMonthReviewPending());
  const { transactionId } = await createTransaction({
    fromAccountId: accountId, toAccountId: null, amountCents: 2_500_000, occurredAt: `${month}-14`,
    description: "Harness o7m3 ajena palabras", externalRef: null, splits: [{ categoryId, amountCents: 2_500_000 }],
    labelIds: [], amountFromWords: true,
  });
  track("transactions", transactionId);
  const seen = (await asUser(fellow, () => getMonthReview(month))).items.find((item) =>
    item.transactionIds.includes(transactionId),
  );
  const pendingAfter = await asUser(fellow, () => getMonthReviewPending());
  assert(
    next("O7-M3 reader: a fellow sees the leader's from-words item as unmarkable, and their Inicio count stays where it was"),
    seen?.rule === "from_words" && seen.canMark === false && (pendingAfter?.count ?? 0) === (pendingBefore?.count ?? 0),
    `seen ${seen?.rule} canMark ${seen?.canMark}, pending ${pendingBefore?.count ?? 0} → ${pendingAfter?.count ?? 0}`,
  );
}

// `YYYY-MM` of the month `delta` months from `base`'s.
function shiftMonth(base: string, delta: number): string {
  return addCivilMonths(`${base.slice(0, 7)}-01`, delta).slice(0, 7);
}

