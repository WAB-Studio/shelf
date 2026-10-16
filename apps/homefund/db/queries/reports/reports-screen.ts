import "server-only";

import { listMembers } from "@/db/queries/group-members";
import { getUserGroup } from "@/db/queries/groups";
import { getMemberContributions } from "@/db/queries/reports/contributions";
import type { MemberContribution } from "@/db/queries/reports/contributions";
import { getExpensesByCategory } from "@/db/queries/reports/expenses-by-category";
import type { CategoryExpense } from "@/db/queries/reports/expenses-by-category";
import { getSixMonthFlow } from "@/db/queries/reports/monthly-flow";
import type { MonthFlow } from "@/db/queries/reports/monthly-flow";
import { getSessionUser } from "@/db/session";
import { currentMonthRange } from "@/lib/dates";

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
  hasGroup: boolean;
};

/**
 * The reports screen's read-model: this month's expenses by category, the
 * six-month flow trend and each member's contribution to the group pot (RF-34,
 * RF-35, RF-66). Scope is never a parameter — RLS inside each query restricts
 * the rows. The five independent reads fan out in one `Promise.all`; the roster
 * is a conditional second trip, taken only once a group is known. The group's
 * pot is never a contributor, so no group row appears (RF-67).
 *
 * Every one of the three carries the currency it counts, and the screen draws a
 * band per currency off it: nothing here adds two (RF-124).
 */
export async function getReportsData(): Promise<ReportsData> {
  const [expensesByCategory, sixMonthFlow, contributionRows, group, sessionUser] =
    await Promise.all([
      getExpensesByCategory(currentMonthRange()),
      getSixMonthFlow(),
      getMemberContributions(currentMonthRange()),
      getUserGroup(),
      getSessionUser(),
    ]);

  // Only a grouped caller has both contributions and a roster to name them.
  const members = group ? await listMembers(group.id, { archived: false }) : [];
  const nameByUserId = new Map(
    members
      .filter((member) => member.userId !== null)
      .map((member) => [member.userId as string, member.name]),
  );

  const contributions: MemberContributionNamed[] = contributionRows.map((row) => ({
    ...row,
    name: nameByUserId.get(row.userId) ?? null,
    isSelf: row.userId === sessionUser?.id,
  }));

  return {
    expensesByCategory,
    sixMonthFlow,
    contributions,
    hasGroup: group !== null,
  };
}
