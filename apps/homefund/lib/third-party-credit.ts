// One month of a credit somebody else pays (RF-212): what the payer sent to the person, what the person paid
// the lender, and the latest day of each. Summed from the transfers and never stored.
export type CreditMonth = {
  month: string;
  paidCents: number;
  paidOn: string | null;
  lenderCents: number;
  lenderOn: string | null;
};

export const HISTORY_MONTHS = 24;

/** The `AAAA-MM` of a civil date. */
export function monthOf(day: string): string {
  return day.slice(0, 7);
}

function nextMonth(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, "0")}`;
}

/**
 * Every month from the first one the credit has a trace in to the current one, newest first, the quiet ones
 * as zeros: a month in which nobody paid is the figure a person came to read. Capped at `HISTORY_MONTHS`.
 */
export function creditHistory(rows: CreditMonth[], firstMonth: string, currentMonth: string): CreditMonth[] {
  const byMonth = new Map(rows.map((row) => [row.month, row]));
  const start = [firstMonth, ...rows.map((row) => row.month)].reduce((a, b) => (a < b ? a : b));
  const months: CreditMonth[] = [];
  for (let month = start; month <= currentMonth; month = nextMonth(month)) {
    months.push(byMonth.get(month) ?? { month, paidCents: 0, paidOn: null, lenderCents: 0, lenderOn: null });
  }
  return months.reverse().slice(0, HISTORY_MONTHS);
}

export type SideState = "none" | "partial" | "done";

/**
 * Whether one side of the month's installment moved: «done» once the month's transfers reach the installment
 * the lender asks, «partial» below it. With no installment declared, any transfer is done.
 */
export function sideState(cents: number, installmentCents: number | null): SideState {
  if (cents <= 0) return "none";
  return installmentCents === null || cents >= installmentCents ? "done" : "partial";
}
