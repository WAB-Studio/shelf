import { monthOf, nextMonth, previousMonth } from "./months";

export type MonthParam =
  | { kind: "this" }
  | { kind: "coming"; month: string }
  | { kind: "past"; month: string }
  | { kind: "redirect" };

// `?mes=YYYY-MM` names a month other than this one. A malformed value, an
// array, a month before the one the first goal was opened in or past the
// forward limit leaves the screen for `/mes` itself (RP-142). Months are
// "YYYY-MM" throughout and compare as strings; `firstMonth` is null while
// nothing was opened, and then no past month exists.
// The months either side of `month` ("YYYY-MM"): `prev` is null on the first
// goal's month, `next` null on the forward limit.
export function monthSteps({
  month,
  firstMonth,
  lastMonth,
}: {
  month: string;
  firstMonth: string | null;
  lastMonth: string;
}): { prev: string | null; next: string | null } {
  return {
    prev: firstMonth === null || month <= firstMonth ? null : previousMonth(`${month}-01`).slice(0, 7),
    next: month >= lastMonth ? null : nextMonth(`${month}-01`).slice(0, 7),
  };
}

export function parseMonthParam(
  raw: string | string[] | undefined,
  today: string,
  firstMonth: string | null,
  lastMonth: string,
): MonthParam {
  if (raw === undefined) return { kind: "this" };
  if (typeof raw !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) return { kind: "redirect" };

  const thisMonth = monthOf(today).slice(0, 7);
  if (raw === thisMonth) return { kind: "this" };
  if (raw > thisMonth) return raw <= lastMonth ? { kind: "coming", month: raw } : { kind: "redirect" };
  return firstMonth !== null && raw >= firstMonth ? { kind: "past", month: raw } : { kind: "redirect" };
}
