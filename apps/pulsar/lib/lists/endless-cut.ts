import { LIST_TAIL, tailOf } from "./tail";

type CutRow = { month: string; past: boolean; current: boolean; planned: number | null };

// A goal with no end always folds its months; one with an end folds only when the list outgrows the tail.
export function foldsMonths(horizon: string | null, rows: readonly unknown[]): boolean {
  return horizon === null || rows.length > LIST_TAIL;
}

// A goal with no end shows four pieces: its months up to the current one (last 12, `upTo`), the month
// after it (`next`, always a row, amount or not), the coming months with an amount set by hand (`handSet`),
// and a line for those at the goal's rhythm; those with none are `empty`. `next` is never counted in the last three.
// `seeAll` says whether «ver todo» is drawn: something is hidden or counted in `rest`.
// With `ends` the line and `empty` give way to `rest`, the count of months after `handSet`; the last month is a
// partial one and never counts as an amount of its own.
export function endlessCut<T extends CutRow>(
  rows: readonly T[],
  opts: { all: boolean; rhythm: number | null; ends?: { lastDay: string } },
): {
  shown: T[];
  upTo: T[];
  next: T | null;
  handSet: T[];
  hidden: number;
  line: { planned: number } | null;
  empty: T[];
  rest: { count: number; lastDay: string } | null;
  seeAll: boolean;
} {
  if (opts.all) return { shown: [...rows], upTo: [...rows], next: null, handSet: [], hidden: 0, line: null, empty: [], rest: null, seeAll: false };
  const tail = tailOf(rows.filter((row) => row.past || row.current), false);
  const coming = rows.filter((row) => !row.past && !row.current);
  const next = rows.some((row) => row.current) ? (coming[0] ?? null) : null;
  const beyond = next === null ? coming : coming.slice(1);
  const last = rows.at(-1);
  const handSet = beyond.filter(
    (row) => row.planned !== null && row.planned !== opts.rhythm && !(opts.ends && row === last),
  );
  const restCount = beyond.length - handSet.length;
  const folds = opts.rhythm !== null && beyond.some((row) => row.planned === opts.rhythm);
  const rest = opts.ends && restCount > 0 ? { count: restCount, lastDay: opts.ends.lastDay } : null;
  return {
    shown: [...tail.shown, ...(next ? [next] : []), ...handSet],
    upTo: tail.shown,
    next,
    handSet,
    hidden: tail.hidden,
    line: !opts.ends && folds && opts.rhythm !== null ? { planned: opts.rhythm } : null,
    empty: opts.ends ? [] : beyond.filter((row) => row.planned === null),
    rest,
    seeAll: tail.hidden > 0 || rest !== null,
  };
}
