import type { PlannedPaymentRow } from "@/db/queries/planned-payments";
import type { RecurringRuleRow } from "@/db/queries/recurring-rules";
import type { RecurringCharge } from "@/db/queries/spending-patterns";
import { addCivilDays, shiftMonth } from "@/lib/dates";
import { scopedCategoryName, type ScopeMark } from "@/lib/fund/category-names";
import type { CategoryScope } from "@/lib/fund/category-scope";
import { isExpectedIncome } from "@/lib/fund/glance";

// A card's next payment (RF-308): what its latest statement asks and the day it is due. With no statement of this
// period the figures are null and the day is the card's own payment day; the line says its extract is missing.
export type UpcomingCardDebt = {
  accountId: string;
  name: string;
  currency: string;
  totalCents: number | null;
  minimumCents: number | null;
};

// A loan's next cuota (RF-308): the first one its schedule has not paid in full, or what its terms say, and what of it
// is still missing.
export type UpcomingLoanDebt = {
  accountId: string;
  name: string;
  currency: string;
  amountCents: number;
  // Which cuota of how many, when a schedule says.
  number: number | null;
  count: number | null;
};

// One line of «Lo que viene»: what a person has coming, whichever table it sits in.
export type UpcomingItem =
  | { kind: "payment" | "income"; date: string; payment: PlannedPaymentRow }
  | { kind: "rule"; date: string; rule: RecurringRuleRow }
  | { kind: "subscription"; date: string; charge: RecurringCharge }
  | { kind: "card"; date: string; debt: UpcomingCardDebt }
  | { kind: "loan"; date: string; debt: UpcomingLoanDebt };

// Same date: what is owed first (a payment, then a card or a loan), then what repeats, then the estimates.
const KIND_ORDER: Record<UpcomingItem["kind"], number> = {
  payment: 0,
  card: 1,
  loan: 2,
  income: 3,
  rule: 4,
  subscription: 5,
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
  debts = [],
}: {
  payments: PlannedPaymentRow[];
  rules: RecurringRuleRow[];
  charges: RecurringCharge[];
  // Each card's and each loan's next payment, which no planned payment stands for (RF-308).
  debts?: ({ kind: "card"; date: string; debt: UpcomingCardDebt } | { kind: "loan"; date: string; debt: UpcomingLoanDebt })[];
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
    ...debts,
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
  if (item.kind === "card") {
    const { debt } = item;
    return { key: debt.accountId, name: debt.name, amountCents: debt.totalCents ?? debt.minimumCents ?? 0, currency: debt.currency };
  }
  if (item.kind === "loan") {
    const { debt } = item;
    return { key: debt.accountId, name: debt.name, amountCents: debt.amountCents, currency: debt.currency };
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
