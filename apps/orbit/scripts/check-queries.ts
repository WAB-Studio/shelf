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
  currentMonthRange,
  lastSixMonthStarts,
  todayInBogota,
} from "@/lib/dates";
import { pgErrorCode } from "@/lib/db-error";
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
         'liability', 'tarjeta', -1200000, ${fixture.openedOn})`;

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
        subtype: "tarjeta",
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
        subtype: "tarjeta",
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
        subtype: "bancaria",
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
        subtype: "bancaria",
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
             where group_id = ${groupId} and subtype = 'efectivo') as account_id,
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
      return {
        ok: kind === "transfer" && Number(stored) === 500000,
        detail: `movement ${result.transactionId}, cash account created = ${result.createdCashAccount}, kind = ${kind}, amount_cents = ${stored}`,
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
          where group_id = ${scope.groupId} and subtype = 'efectivo' and archived_at is null`;

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
            subtype: "bancaria",
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
         where group_id = ${paletteGroupId} and subtype = 'efectivo') as account_id`;
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
      subtype: kind === "asset" ? "bancaria" : "tarjeta",
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
      subtype: kind === "asset" ? "bancaria" : "tarjeta",
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
  await roundTripSuite(scope, userId);
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
