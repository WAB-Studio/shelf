// The payment schedule a bank prints for an instalment loan (RF-264), read against the loan's payments. Only the rows
// are stored; which are paid, the next one, what is left and every warning derive here from the rows and the payments.
export type ScheduleRow = {
  number: number;
  dueOn: string;
  principalCents: number;
  interestCents: number;
  insuranceCents: number;
  totalCents: number;
  // The capital still owed once this row is paid.
  remainingCents: number;
};

// A payment into the loan, in the loan's own currency: the capital that reached it and the interest the same payment
// booked as an expense of the source (RF-282), which is part of what the cuota asks and never of the loan's balance.
export type SchedulePayment = { occurredOn: string; amountCents: number; interestCents?: number };

export type RowState = "paid" | "partial" | "pending";

export type RowView = ScheduleRow & {
  state: RowState;
  // What the payments that paid the row add up to, interest included.
  paidCents: number;
  // The part of `paidCents` that was interest.
  paidInterestCents: number;
  // Not paid in full and its day is behind us.
  overdue: boolean;
};

// A cuota differs from the usual one by more than this fraction of it (RF-264).
export const DIFFERS_FRACTION = 0.05;
// A payment that falls short of a cuota by no more than this fraction of it still pays it, and a usual payment that
// falls short by no more than it still covers it: the bank rounds, and the payer sends a round figure.
export const SHORT_FRACTION = 0.01;

export type DifferingRow = { number: number; dueOn: string; totalCents: number; usualCents: number };

export type LoanScheduleSummary = {
  rows: RowView[];
  count: number;
  paidCount: number;
  // Rows something landed on that still fall short of the cuota: they are part of `remainingCount`, never of `paidCount`.
  partialCount: number;
  remainingCount: number;
  // The first row not paid in full; null once every row is.
  next: RowView | null;
  // What is still to pay of the cuotas, interest and insurance included.
  remainingTotalCents: number;
  endsOn: string;
  // The middle cuota of the whole schedule: what the loan asks in an ordinary month.
  usualCents: number;
  // Unpaid rows more than 5 % away from the usual cuota, earliest first.
  differing: DifferingRow[];
};

/** The middle of the figures, integer cents; the two middle ones average for an even count. 0 for none. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// A row is paid when what landed reaches its cuota less `SHORT_FRACTION`.
function isPaid(row: ScheduleRow, landedCents: number): boolean {
  return landedCents * 100 >= row.totalCents * (100 - SHORT_FRACTION * 100);
}

/**
 * Gives each payment, oldest first, to the oldest row not yet paid, whatever the payment's day: a cuota paid late still
 * pays the late row and never the next one. What a payment gives a row is its capital and the interest it booked: the
 * cuota is capital, interest and insurance together; what it holds above the cuota is extra capital and pays no other
 * row. A row is paid when what landed reaches its cuota less `SHORT_FRACTION`, partial when something did and pending
 * when nothing did. Once every row is paid a payment pays none.
 */
export function readSchedule(rows: ScheduleRow[], payments: SchedulePayment[], today: string): LoanScheduleSummary | null {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort((a, b) => a.number - b.number);
  const landed = new Array<number>(ordered.length).fill(0);
  const landedInterest = new Array<number>(ordered.length).fill(0);
  const inOrder = [...payments].sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));
  for (const payment of inOrder) {
    const best = ordered.findIndex((row, index) => !isPaid(row, landed[index]));
    if (best < 0) continue;
    landed[best] += payment.amountCents + (payment.interestCents ?? 0);
    landedInterest[best] += payment.interestCents ?? 0;
  }

  const views: RowView[] = ordered.map((row, index) => {
    const paidCents = landed[index];
    const state: RowState = isPaid(row, paidCents) ? "paid" : paidCents > 0 ? "partial" : "pending";
    return { ...row, state, paidCents, paidInterestCents: landedInterest[index], overdue: state !== "paid" && row.dueOn < today };
  });

  const open = views.filter((row) => row.state !== "paid");
  const usualCents = median(ordered.map((row) => row.totalCents));
  return {
    rows: views,
    count: views.length,
    paidCount: views.length - open.length,
    partialCount: open.filter((row) => row.state === "partial").length,
    remainingCount: open.length,
    next: open[0] ?? null,
    remainingTotalCents: open.reduce((sum, row) => sum + Math.max(0, row.totalCents - row.paidCents), 0),
    endsOn: ordered[ordered.length - 1].dueOn,
    usualCents,
    differing: open
      .filter((row) => Math.abs(row.totalCents - usualCents) > usualCents * DIFFERS_FRACTION)
      .map((row) => ({ number: row.number, dueOn: row.dueOn, totalCents: row.totalCents, usualCents })),
  };
}

/**
 * The row the next payment pays: the oldest not yet paid, the one the reading above gives it. Null once every row is
 * paid. A payment is split by this row, so the split and the reading always agree on which cuota it belongs to.
 */
export function rowToPay(rows: RowView[]): RowView | null {
  return rows.find((row) => row.state !== "paid") ?? null;
}

/** The summary without its rows: what a list answers where the whole schedule would be noise. */
export type LoanScheduleDigest = Omit<LoanScheduleSummary, "rows">;

export function digest(summary: LoanScheduleSummary): LoanScheduleDigest {
  return {
    count: summary.count,
    paidCount: summary.paidCount,
    partialCount: summary.partialCount,
    remainingCount: summary.remainingCount,
    next: summary.next,
    remainingTotalCents: summary.remainingTotalCents,
    endsOn: summary.endsOn,
    usualCents: summary.usualCents,
    differing: summary.differing,
  };
}

/**
 * What the person who pays the loan usually sends: the middle of their last `last` months in which something
 * arrived. Null when nothing has arrived yet, so a payer with no history is never warned.
 */
export function usualPayment(paidByMonth: number[], last = 6): number | null {
  const sent = paidByMonth.filter((cents) => cents > 0).slice(0, last);
  return sent.length === 0 ? null : median(sent);
}

export type ShortRow = { number: number; dueOn: string; totalCents: number; shortCents: number };

/** The unpaid cuotas the usual payment will not cover, earliest first: those above it by more than `SHORT_FRACTION`. */
export function uncoveredRows(summary: Pick<LoanScheduleSummary, "rows">, usualPaymentCents: number | null): ShortRow[] {
  if (usualPaymentCents === null) return [];
  return summary.rows
    .filter((row) => row.state !== "paid" && row.totalCents > usualPaymentCents * (1 + SHORT_FRACTION))
    .map((row) => ({ number: row.number, dueOn: row.dueOn, totalCents: row.totalCents, shortCents: row.totalCents - usualPaymentCents }));
}

/** What a credit somebody else pays says of its schedule: the digest, what the payer usually sends and the cuotas it will not cover. */
export type CreditScheduleDigest = LoanScheduleDigest & { personUsualCents: number | null; uncovered: ShortRow[] };

/** `paidByMonth` is what the payer sent each month, newest first. */
export function creditDigest(summary: LoanScheduleSummary, paidByMonth: number[]): CreditScheduleDigest {
  const personUsualCents = usualPayment(paidByMonth);
  return { ...digest(summary), personUsualCents, uncovered: uncoveredRows(summary, personUsualCents) };
}
