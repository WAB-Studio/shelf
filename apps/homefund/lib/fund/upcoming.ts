import type { PlannedPaymentRow } from "@/db/queries/planned-payments";
import type { RecurringRuleRow } from "@/db/queries/recurring-rules";
import type { RecurringCharge } from "@/db/queries/spending-patterns";
import { addCivilDays, shiftMonth } from "@/lib/dates";
import { scopedCategoryName, type ScopeMark } from "@/lib/fund/category-names";
import type { CategoryScope } from "@/lib/fund/category-scope";
import { isExpectedIncome } from "@/lib/fund/glance";

// One line of «Lo que viene»: what a person has coming, whichever table it sits in.
export type UpcomingItem =
  | { kind: "payment" | "income"; date: string; payment: PlannedPaymentRow }
  | { kind: "rule"; date: string; rule: RecurringRuleRow }
  | { kind: "subscription"; date: string; charge: RecurringCharge };

// Same date: what is owed first, then what repeats, then the estimates.
const KIND_ORDER: Record<UpcomingItem["kind"], number> = {
  payment: 0,
  income: 1,
  rule: 2,
  subscription: 3,
};

// A name read the way the subscription finder reads it: without case, accents, digits or punctuation.
export function plainName(name: string | null): string {
  return (name ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every pending payment, every rule and every running subscription as one list, soonest first. A found
 * subscription that a rule already generates is the rule, so it is listed once; a stopped one is not coming.
 */
export function upcomingItems({
  payments,
  rules,
  charges,
}: {
  payments: PlannedPaymentRow[];
  rules: RecurringRuleRow[];
  charges: RecurringCharge[];
}): UpcomingItem[] {
  const ruled = new Set(
    rules.map((rule) => `${rule.fromAccountId ?? ""}|${plainName(rule.description)}`),
  );

  const items: UpcomingItem[] = [
    ...payments.map((payment): UpcomingItem => ({
      kind: isExpectedIncome(payment) ? "income" : "payment",
      date: payment.dueDate,
      payment,
    })),
    ...rules.map((rule): UpcomingItem => ({ kind: "rule", date: rule.nextRunOn, rule })),
    ...charges
      .filter((charge) => charge.active && !ruled.has(`${charge.accountId}|${plainName(charge.name)}`))
      .map((charge): UpcomingItem => ({ kind: "subscription", date: charge.nextExpected, charge })),
  ];

  return items.sort(
    (a, b) => a.date.localeCompare(b.date) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );
}

// What a line shows in a few words: its name, its figure and its day, whichever table it came from.
export function previewOf(item: UpcomingItem): {
  key: string;
  name: string | null;
  amountCents: number;
  currency: string;
} {
  if (item.kind === "rule") {
    return { key: item.rule.id, name: item.rule.description, amountCents: item.rule.amountCents, currency: item.rule.currency };
  }
  if (item.kind === "subscription") {
    const { charge } = item;
    return { key: `${charge.accountId}:${charge.currency}:${charge.name}`, name: charge.name, amountCents: charge.typicalCents, currency: charge.currency };
  }
  const { payment } = item;
  return { key: payment.id, name: payment.description, amountCents: payment.amountCents, currency: payment.currency };
}

// The day a month holds when the rule anchors on `day`: a 31 lands on the last day of a short month.
function dayIn(month: string, day: number): string {
  const [year, number] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

/**
 * Where a rule's next run falls once the coming one is skipped: one period on, by the same arithmetic the
 * night's run advances it with (the day anchor kept, clamped to the month's length).
 */
export function dateAfterSkip(rule: {
  frequency: "weekly" | "monthly" | "yearly";
  intervalN: number;
  dayOfMonth: number | null;
  nextRunOn: string;
}): string {
  if (rule.frequency === "weekly") return addCivilDays(rule.nextRunOn, 7 * rule.intervalN);

  const months = rule.frequency === "yearly" ? 12 * rule.intervalN : rule.intervalN;
  const anchor = rule.dayOfMonth ?? Number(rule.nextRunOn.slice(8, 10));
  return dayIn(shiftMonth(rule.nextRunOn.slice(0, 7), months), anchor);
}

type CategoryNode = {
  id: string;
  name: string;
  scope: CategoryScope;
  kind: "expense" | "income";
  children: readonly { id: string; name: string }[];
};

/**
 * The categories a plan may name: those of the account's scope and the direction's kind, each parent followed
 * by its subcategories read as «Mercado › Lácteos». The write guard asks for the same scope and kind, so
 * nothing offered here is refused later.
 */
export function pickableCategories(
  categories: readonly CategoryNode[],
  scope: CategoryScope | null,
  kind: "expense" | "income",
  mark: ScopeMark,
): { id: string; name: string }[] {
  return categories
    .filter((category) => category.kind === kind && (scope === null || category.scope === scope))
    .flatMap((category) => [
      { id: category.id, name: scopedCategoryName(category.name, category.scope, mark) },
      ...category.children.map((child) => ({
        id: child.id,
        name: scopedCategoryName(`${category.name} › ${child.name}`, category.scope, mark),
      })),
    ]);
}
