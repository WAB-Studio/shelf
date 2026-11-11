import "server-only";

import { listMembers } from "@/db/queries/group-members";
import { getUserGroup } from "@/db/queries/groups";
import {
  getFundCashBalances,
  getFundSpending,
  getMemberContributions,
  getSpendingByMaker,
  getUnassignedIncome,
} from "@/db/queries/reports/contributions";
import type {
  FundCashBalance,
  FundSpending,
  MemberContribution,
  SpendingByMaker,
  UnassignedIncome,
} from "@/db/queries/reports/contributions";
import { getExpensesByCategory } from "@/db/queries/reports/expenses-by-category";
import type { CategoryExpense } from "@/db/queries/reports/expenses-by-category";
import { getSixMonthFlow } from "@/db/queries/reports/monthly-flow";
import type { MonthFlow } from "@/db/queries/reports/monthly-flow";
import { getSessionUser } from "@/db/session";
import { currentMonthStart, monthRange } from "@/lib/dates";

// A contribution row carrying the member's display name, with the caller's own
// row flagged so the component can label it (RF-66). One row per member AND
// currency, as the query answers.
export type MemberContributionNamed = MemberContribution & {
  name: string | null;
  isSelf: boolean;
};

export type ReportsData = {
  expensesByCategory: CategoryExpense[];
  sixMonthFlow: MonthFlow[];
  contributions: MemberContributionNamed[];
  // What the fund's cash accounts hold now, to read beside what was put in and
  // what the fund spent in the month.
  fundCash: FundCashBalance[];
  // What the fund's accounts spent in the month, categorised or not.
  fundSpending: FundSpending[];
  // Incomes into the fund that name no member: «Sin asignar» in Aportes (RF-167).
  unassigned: UnassignedIncome[];
  // Who spent how much in the month, by «Lo hizo» (RF-182); the member's name is null for the household.
  spendingByMaker: (SpendingByMaker & { name: string | null })[];
  hasGroup: boolean;
};

/**
 * The reports screen's read-model: the chosen month's expenses by category, the
 * six-month flow trend and each member's contribution to the group pot (RF-34,
 * RF-35, RF-66). Scope is never a parameter — RLS inside each query restricts
 * the rows. The five independent reads fan out in one `Promise.all`; the roster
 * is chained off the group inside the same fan-out. The group's
 * pot is never a contributor, so no group row appears (RF-67).
 *
 * Every one of the three carries the currency it counts, and the screen draws a
 * band per currency off it: nothing here adds two (RF-124).
 */
export async function getReportsData(monthStart: string = currentMonthStart()): Promise<ReportsData> {
  // Only a grouped caller has both contributions and a roster to name them; the
  // roster chains off the group inside the fan-out, so it adds no wave of its own.
  const groupAndMembers = getUserGroup().then(async (found) => ({
    group: found,
    members: found ? await listMembers(found.id, { archived: "all" }) : [],
  }));

  const [expensesByCategory, sixMonthFlow, contributionRows, fundCash, fundSpending, unassigned, makerRows, { group, members }, sessionUser] =
    await Promise.all([
      getExpensesByCategory(monthRange(monthStart)),
      getSixMonthFlow(monthStart),
      getMemberContributions(monthRange(monthStart)),
      getFundCashBalances(monthRange(monthStart)),
      getFundSpending(monthRange(monthStart)),
      getUnassignedIncome(monthRange(monthStart)),
      getSpendingByMaker(monthRange(monthStart)),
      groupAndMembers,
      getSessionUser(),
    ]);

  const nameByMemberId = new Map(members.map((member) => [member.id, member.name]));


  const contributions: MemberContributionNamed[] = contributionRows.map((row) => ({
    ...row,
    name: nameByMemberId.get(row.memberId) ?? null,
    isSelf: row.userId === sessionUser?.id,
  }));

  return {
    expensesByCategory,
    sixMonthFlow,
    contributions,
    fundCash,
    fundSpending,
    unassigned,
    spendingByMaker: makerRows.map((row) => ({
      ...row,
      name: row.memberId ? (nameByMemberId.get(row.memberId) ?? null) : null,
    })),
    hasGroup: group !== null,
  };
}
