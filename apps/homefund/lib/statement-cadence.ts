import { addCivilDays, monthRange, shiftMonth } from "@/lib/dates";

export const STATEMENT_CADENCES = ["monthly", "quarterly"] as const;
export type StatementCadence = (typeof STATEMENT_CADENCES)[number];

// The days a bank gets after a period closes to issue its statement, before HomeFund asks for it (RF-259).
export const REQUEST_GRACE_DAYS = 3;

/**
 * Bancolombia hands its savings statement every three months; the form offers quarterly where the institution
 * says so and the cadence is still unset.
 */
export function suggestsQuarterly(account: { institution: string | null; subtype: string }): boolean {
  return account.subtype === "bank" && /bancolombia/i.test(account.institution ?? "");
}

export type StatementPeriod = { start: string; end: string };

// The calendar period (a month, or a quarter from January) that ends `back` periods before the one `today` is in.
function periodBefore(cadence: StatementCadence, today: string, back: number): StatementPeriod {
  const month = today.slice(0, 7);
  const width = cadence === "monthly" ? 1 : 3;
  // The first month of the period today sits in; a quarter starts in January, April, July or October.
  const here = cadence === "monthly" ? month : shiftMonth(month, -((Number(month.slice(5)) - 1) % 3));
  const start = shiftMonth(here, -width * back);
  const last = shiftMonth(start, width - 1);
  return { start: `${start}-01`, end: addCivilDays(monthRange(`${last}-01`).endExclusive, -1) };
}

/**
 * The latest period that closed far enough back for the bank to have issued its statement: the one ending
 * more than `REQUEST_GRACE_DAYS` days ago.
 */
export function latestClosedPeriod(cadence: StatementCadence, today: string): StatementPeriod {
  const first = periodBefore(cadence, today, 1);
  return addCivilDays(first.end, REQUEST_GRACE_DAYS) < today ? first : periodBefore(cadence, today, 2);
}

export type StatementRequestInput = {
  // What the person turned on; no account has one until they do, because a statement is optional (RF-259).
  statementCadence: StatementCadence | null;
  // The last day of the period they answered «Ahora no» to.
  dismissedThrough: string | null;
  addedOn: string;
  openedOn: string;
  latestReconciledOn: string | null;
  latestStatementCutOff: string | null;
};

/**
 * The period whose statement HomeFund asks the person for, or null (RF-259). It is asked for once per period: it stays
 * until a statement cut inside or after the period, or a count on or after its last day, exists, or the person says
 * «Ahora no»; an account added after the period closed is never asked for the statement of a time before it was here.
 */
export function statementRequest(account: StatementRequestInput, today: string): (StatementPeriod & { cadence: StatementCadence }) | null {
  const cadence = account.statementCadence;
  if (cadence === null) return null;

  const period = latestClosedPeriod(cadence, today);
  if (account.dismissedThrough !== null && account.dismissedThrough >= period.end) return null;
  if (account.addedOn > addCivilDays(period.end, REQUEST_GRACE_DAYS) || account.openedOn > period.end) return null;
  if (account.latestStatementCutOff !== null && account.latestStatementCutOff >= period.start) return null;
  if (account.latestReconciledOn !== null && account.latestReconciledOn >= period.end) return null;

  return { ...period, cadence };
}

export type StatementRequest = StatementPeriod & { accountId: string; name: string; cadence: StatementCadence };

/** The statements HomeFund asks for across a list of accounts, in the order the accounts come (RF-259). */
export function openStatementRequests(
  accounts: (StatementRequestInput & { id: string; name: string })[],
  today: string,
): StatementRequest[] {
  return accounts.flatMap((account) => {
    const request = statementRequest(account, today);
    return request ? [{ ...request, accountId: account.id, name: account.name }] : [];
  });
}
