import { civilDateToDate, nextDayOfMonthOnOrAfter } from "@/lib/dates";
import { monthOf, sideState, type CreditMonth, type SideState } from "@/lib/third-party-credit";

// One credit somebody else pays, as the widget draws it (RF-215): who, whether their payment reached the lender's
// installment this month, the installment and the days to the due day. Nothing here adds two currencies.
export type WidgetCredit = {
  person: string;
  currency: string;
  paidThisMonth: SideState;
  installmentCents: number | null;
  daysUntilDue: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from `today` to the next due day on or after it (0 on the day); null when the lender names none. */
export function daysUntilDue(dueDay: number | null, today: string): number | null {
  if (dueDay === null) return null;
  const due = nextDayOfMonthOnOrAfter(dueDay, today);
  return Math.round((civilDateToDate(due).getTime() - civilDateToDate(today).getTime()) / DAY_MS);
}

export function widgetCredit(
  credit: {
    personName: string;
    currency: string;
    installmentCents: number | null;
    dueDay: number | null;
    months: CreditMonth[];
  },
  today: string,
): WidgetCredit {
  const thisMonth = credit.months.find((month) => month.month === monthOf(today));
  return {
    person: credit.personName,
    currency: credit.currency,
    paidThisMonth: sideState(thisMonth?.paidCents ?? 0, credit.installmentCents),
    installmentCents: credit.installmentCents,
    daysUntilDue: daysUntilDue(credit.dueDay, today),
  };
}
