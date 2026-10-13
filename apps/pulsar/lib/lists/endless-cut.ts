import { tailOf } from "./tail";

type CutRow = { month: string; past: boolean; current: boolean; planned: number | null };

// A goal with no end shows its months up to the current one (last 12), then the coming months
// with an amount set by hand; those at the goal's rhythm fold into one line, those with none are `empty`.
export function endlessCut<T extends CutRow>(
  rows: readonly T[],
  opts: { all: boolean; rhythm: number | null },
): { shown: T[]; hidden: number; line: { planned: number } | null; empty: T[] } {
  if (opts.all) return { shown: [...rows], hidden: 0, line: null, empty: [] };
  const tail = tailOf(rows.filter((row) => row.past || row.current), false);
  const coming = rows.filter((row) => !row.past && !row.current);
  const handSet = coming.filter((row) => row.planned !== null && row.planned !== opts.rhythm);
  const folds = opts.rhythm !== null && coming.some((row) => row.planned === opts.rhythm);
  return {
    shown: [...tail.shown, ...handSet],
    hidden: tail.hidden,
    line: folds && opts.rhythm !== null ? { planned: opts.rhythm } : null,
    empty: coming.filter((row) => row.planned === null),
  };
}
