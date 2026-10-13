import { tailOf } from "./tail";

type CutRow = { month: string; past: boolean; current: boolean; planned: number | null };

// A goal with no end shows four pieces: its months up to the current one (last 12, `upTo`), the month
// after it (`next`, always a row, amount or not), the coming months with an amount set by hand (`handSet`),
// and a line for those at the goal's rhythm; those with none are `empty`. `next` is never counted in the last three.
export function endlessCut<T extends CutRow>(
  rows: readonly T[],
  opts: { all: boolean; rhythm: number | null },
): {
  shown: T[];
  upTo: T[];
  next: T | null;
  handSet: T[];
  hidden: number;
  line: { planned: number } | null;
  empty: T[];
} {
  if (opts.all) return { shown: [...rows], upTo: [...rows], next: null, handSet: [], hidden: 0, line: null, empty: [] };
  const tail = tailOf(rows.filter((row) => row.past || row.current), false);
  const coming = rows.filter((row) => !row.past && !row.current);
  const next = rows.some((row) => row.current) ? (coming[0] ?? null) : null;
  const beyond = next === null ? coming : coming.slice(1);
  const handSet = beyond.filter((row) => row.planned !== null && row.planned !== opts.rhythm);
  const folds = opts.rhythm !== null && beyond.some((row) => row.planned === opts.rhythm);
  return {
    shown: [...tail.shown, ...(next ? [next] : []), ...handSet],
    upTo: tail.shown,
    next,
    handSet,
    hidden: tail.hidden,
    line: folds && opts.rhythm !== null ? { planned: opts.rhythm } : null,
    empty: beyond.filter((row) => row.planned === null),
  };
}
