import "server-only";

import { desc, eq, sql } from "drizzle-orm";

import { insertRow } from "@/db/insert-row";
import { goalContributions, savingsGoals, transactions } from "@/db/schema";
import { withUserDb } from "@/db/session";
import { BASE_CURRENCY } from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
import { TIME_ZONE } from "@/lib/locales";

export type GoalProgress = {
  id: string;
  name: string;
  targetAmountCents: number;
  targetDate: string | null;
  accountId: string | null;
  // What the meta and the apartado are counted in, derived and never stored
  // (RF-121, RF-124): the settlement currency of the account the goal names,
  // the fund's when it is the fund's, else its owner's own.
  currency: string;
  savedCents: number;
  remainingCents: number;
  reachedTarget: boolean;
  // Whole percent of the meta already set aside, capped at 100.
  progressPct: number;
  // What is left to set aside each month to land on the target date; null when
  // the goal names no date or has already reached its meta.
  requiredMonthlyCents: number | null;
  // Behind the straight line from the day the goal opened to its target date.
  behindPace: boolean;
};

/**
 * Every non-archived goal with its progress in ONE round trip (RF-87, RNF-09):
 * `saved_cents` sums the goal's own aportes, and only the ones set aside in the
 * goal's currency, so no meta is measured against two currencies added together
 * (RF-124) — which is what the `goal_progress` view, blind to the currency,
 * cannot do. An aporte earmarking a movement is in that movement's currency; a
 * virtual one is in the goal's, and so is one whose movement the caller cannot
 * read, which joins as null rather than dropping out of the sum. Remaining
 * floors at zero so an overshot goal reads as reached, not negative. `archived` swaps the
 * listing onto the archived side (RF-120); the view knows nothing of the flag,
 * so an archived goal's progress keeps deriving from its aportes. Scope is the
 * policy's job: `withUserDb` shows only the caller's readable goals.
 *
 * The pace rides along from the same read, in exact numeric arithmetic and back
 * as integer cents: the monthly figure spreads what remains over the whole months
 * still ahead — at least one, so a goal due this month asks for all of it — and a
 * goal counts as behind when what it has set aside sits under the straight line
 * from the day it opened to the day it is due, or that day has already come and
 * gone (D5): a goal opened today has spent none of its own line, but a target
 * date at or before today leaves no line left to spend, so it reads behind from
 * its first day rather than waiting for one to pass. Neither is stored (RNF-07).
 *
 * The rows come back in the reading order of the artboard — atrasada, al día,
 * cumplida, sin fecha, and by name inside each band — so the desktop table and
 * the phone cards list the same goals in the same order.
 */
export async function listGoalsWithProgress(options?: {
  archived?: boolean;
}): Promise<GoalProgress[]> {
  const archivedFilter = options?.archived
    ? sql`g.archived_at is not null`
    : sql`g.archived_at is null`;

  const today = todayInBogota();
  // The goal's own opening day, read in the zone every civil date here is in.
  const openedOn = sql`(g.created_at at time zone ${TIME_ZONE})::date`;

  return withUserDb(async (tx) => {
    const rows = await tx.execute<{
      id: string;
      name: string;
      target_amount_cents: string;
      target_date: string | null;
      account_id: string | null;
      currency: string;
      saved_cents: string;
      progress_pct: number;
      required_monthly_cents: string | null;
      behind_pace: boolean;
    }>(sql`
      with goals as (
        select
          g.id,
          g.name,
          g.target_amount_cents,
          g.target_date,
          g.account_id,
          cur.code as currency,
          gp.saved_cents,
          least(round(gp.saved_cents * 100.0 / g.target_amount_cents), 100)::int
            as progress_pct,
          case
            when g.target_date is null or gp.saved_cents >= g.target_amount_cents
              then null
            else ceil(
              (g.target_amount_cents - gp.saved_cents)::numeric
              / greatest(ceil((g.target_date - ${today}::date) / 30.0), 1)
            )::bigint
          end as required_monthly_cents,
          case
            when g.target_date is null or gp.saved_cents >= g.target_amount_cents
              then false
            -- D5: a target date already due or past leaves no straight line to
            -- ride — the goal owes its whole meta today, opened today or not.
            when g.target_date <= ${today}::date
              then true
            -- Cross-multiplied so the comparison stays in exact integers: saved
            -- over the whole span against the meta over the days already spent.
            else gp.saved_cents * greatest(g.target_date - ${openedOn}, 0)
              < g.target_amount_cents * greatest(${today}::date - ${openedOn}, 0)
          end as behind_pace
        from savings_goals g
        left join accounts a on a.id = g.account_id
        left join groups gr on gr.id = g.group_id
        left join app_users u on u.id = g.owner_user_id
        -- The scope is an XOR, so at most one of the fund's and the owner's ever
        -- answers. The last leg is the one case none of them can: another member's
        -- personal goal naming no account, whose owner's row app_users_select_self
        -- keeps out of reach — it reads in the base currency rather than in none.
        cross join lateral (select coalesce(
          a.settlement_currency, gr.currency, u.settlement_currency, ${BASE_CURRENCY}
        ) as code) cur
        cross join lateral (
          select coalesce(sum(gc.amount_cents), 0)::bigint as saved_cents
          from goal_contributions gc
          left join transactions t on t.id = gc.transaction_id
          where gc.goal_id = g.id and coalesce(t.currency, cur.code) = cur.code
        ) gp
        where ${archivedFilter}
      )
      select *
      from goals
      -- The reading order of the artboard, ranked over the same derivation the
      -- ritmo column reads: atrasada, al día, cumplida, sin fecha.
      order by
        case
          when saved_cents >= target_amount_cents then 2
          when target_date is null then 3
          when behind_pace then 0
          else 1
        end,
        name
    `);

    return rows.map((row) => {
      // A bigint sum arrives from the driver as a string; the ledger keeps cents a number.
      const targetAmountCents = Number(row.target_amount_cents);
      const savedCents = Number(row.saved_cents);

      return {
        id: row.id,
        name: row.name,
        targetAmountCents,
        targetDate: row.target_date,
        accountId: row.account_id,
        currency: row.currency,
        savedCents,
        remainingCents: Math.max(targetAmountCents - savedCents, 0),
        reachedTarget: savedCents >= targetAmountCents,
        progressPct: row.progress_pct,
        requiredMonthlyCents:
          row.required_monthly_cents === null
            ? null
            : Number(row.required_monthly_cents),
        behindPace: row.behind_pace,
      };
    });
  });
}

/**
 * The currency a goal's meta and aportes are written and read in, in ONE round
 * trip (RF-121). The same chain the listing derives, asked of one goal: the
 * account it names, then the scope it belongs to, and the base currency when
 * the caller may read none of them. A write that names no goal yet falls
 * through to the caller's own fund and row.
 *
 * RLS does the scoping: `groups` shows the caller their one fund and
 * `app_users` shows them only their own row.
 */
export async function resolveGoalCurrency({
  goalId = null,
  accountId = null,
}: {
  goalId?: string | null;
  accountId?: string | null;
}): Promise<string> {
  return withUserDb(async (tx) => {
    const [row] = await tx.execute<{ code: string }>(sql`
      select coalesce(
        (select a.settlement_currency from accounts a where a.id = ${accountId}::uuid),
        (select coalesce(gr.currency, u.settlement_currency)
           from savings_goals g
           left join groups gr on gr.id = g.group_id
           left join app_users u on u.id = g.owner_user_id
          where g.id = ${goalId}::uuid),
        (select gr.currency from groups gr limit 1),
        (select u.settlement_currency from app_users u limit 1),
        ${BASE_CURRENCY}
      ) as code
    `);

    return row.code;
  });
}

// The scope is resolved by the caller (owner XOR group).
export type CreateGoalArgs = {
  ownerUserId: string | null;
  groupId: string | null;
  name: string;
  targetAmountCents: number;
  targetDate: string | null;
  accountId: string | null;
  // An opening virtual aporte, seeded in the same transaction as the goal.
  initialContributionCents?: number | null;
};

export async function createGoal({
  ownerUserId,
  groupId,
  name,
  targetAmountCents,
  targetDate,
  accountId,
  initialContributionCents = null,
}: CreateGoalArgs): Promise<{ goalId: string }> {
  return withUserDb(async (tx) => {
    const [row] = await insertRow(
      tx,
      savingsGoals,
      { ownerUserId, groupId, name, targetAmountCents, targetDate, accountId },
      { returning: { id: savingsGoals.id } },
    );

    // The opening aporte rides the goal's own transaction (RNF-09): one round
    // trip to the pooler, and a virtual entry so no movement is earmarked.
    if (initialContributionCents != null) {
      await insertRow(tx, goalContributions, {
        goalId: row.id,
        transactionId: null,
        amountCents: initialContributionCents,
      });
    }

    return { goalId: row.id };
  });
}

// The scope is immutable and absent from the UPDATE grant, so an edit only
// touches these fields; the boolean reports whether the policy admitted it.
export type UpdateGoalArgs = {
  goalId: string;
  name: string;
  targetAmountCents: number;
  targetDate: string | null;
  accountId: string | null;
};

export async function updateGoal({
  goalId,
  name,
  targetAmountCents,
  targetDate,
  accountId,
}: UpdateGoalArgs): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(savingsGoals)
      .set({ name, targetAmountCents, targetDate, accountId })
      .where(eq(savingsGoals.id, goalId))
      .returning({ id: savingsGoals.id });

    return rows.length > 0;
  });
}

// RF-120: archiving keeps the goal and its aportes, so `goal_progress` still
// sums the same rows and no derivation already recorded moves.
export async function archiveGoal({
  goalId,
}: {
  goalId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(savingsGoals)
      .set({ archivedAt: sql`now()` })
      .where(eq(savingsGoals.id, goalId))
      .returning({ id: savingsGoals.id });

    return rows.length > 0;
  });
}

// The update policy scopes by owner-or-group and carries no archived predicate,
// so an archived goal stays inside the same USING that archived it (RF-120).
export async function restoreGoal({
  goalId,
}: {
  goalId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .update(savingsGoals)
      .set({ archivedAt: null })
      .where(eq(savingsGoals.id, goalId))
      .returning({ id: savingsGoals.id });

    return rows.length > 0;
  });
}

export async function deleteGoal({
  goalId,
}: {
  goalId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .delete(savingsGoals)
      .where(eq(savingsGoals.id, goalId))
      .returning({ id: savingsGoals.id });

    return rows.length > 0;
  });
}

// Adds an aporte toward a goal (RF-87). A null `transactionId` is a virtual
// envelope entry; a movement id earmarks it, and the `assert_goal_contribution_scope`
// trigger checks that movement shares the goal's scope.
export async function addGoalContribution({
  goalId,
  transactionId = null,
  amountCents,
}: {
  goalId: string;
  transactionId?: string | null;
  amountCents: number;
}): Promise<{ contributionId: string }> {
  return withUserDb(async (tx) => {
    const [row] = await insertRow(
      tx,
      goalContributions,
      { goalId, transactionId, amountCents },
      { returning: { id: goalContributions.id } },
    );

    return { contributionId: row.id };
  });
}

// One aporte as the undo list shows it (RF-119). `occurredAt` is the day the
// money was set aside: the movement's own date when the entry earmarks one, and
// the day the entry was written when it earmarks none — every aporte carries one.
// `description` names that movement, and stays null for a virtual entry.
export type GoalContributionRow = {
  id: string;
  amountCents: number;
  // The currency of the movement the aporte earmarks; null for a virtual one,
  // which is set aside in the goal's own currency (RF-121).
  currency: string | null;
  transactionId: string | null;
  occurredAt: string;
  description: string | null;
};

/**
 * One goal's aportes, newest first, in ONE round trip (RF-119, RNF-09). The sum
 * of the ones in the goal's own currency is its saved amount:
 * `listGoalsWithProgress` sums these very rows under the same policy, so
 * progress keeps deriving and nothing is stored (RF-87, RNF-07). Scope is the policy's job — `goal_contributions_select_member`
 * admits a row only when its goal is readable, so the goal id narrows the set and
 * never widens it. A movement outside the caller's scope joins as null rather
 * than dropping its aporte, which would break that sum.
 */
export async function listGoalContributions(
  goalId: string,
): Promise<GoalContributionRow[]> {
  // Written out rather than built from the column references: a fragment in a
  // projection renders them unqualified, and both tables carry a `created_at`.
  const occurredAt = sql<string>`coalesce(
    transactions.occurred_at,
    (goal_contributions.created_at at time zone ${TIME_ZONE})::date
  )`;

  return withUserDb(async (tx) => {
    return tx
      .select({
        id: goalContributions.id,
        amountCents: goalContributions.amountCents,
        currency: transactions.currency,
        transactionId: goalContributions.transactionId,
        occurredAt,
        description: transactions.description,
      })
      .from(goalContributions)
      .leftJoin(transactions, eq(transactions.id, goalContributions.transactionId))
      .where(eq(goalContributions.goalId, goalId))
      // Newest first by the day the money was set aside; two aportes of the same
      // day fall back on the instant the row was written, which keeps them stable.
      .orderBy(desc(occurredAt), desc(goalContributions.createdAt));
  });
}

export async function removeGoalContribution({
  contributionId,
}: {
  contributionId: string;
}): Promise<boolean> {
  return withUserDb(async (tx) => {
    const rows = await tx
      .delete(goalContributions)
      .where(eq(goalContributions.id, contributionId))
      .returning({ id: goalContributions.id });

    return rows.length > 0;
  });
}
