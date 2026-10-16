import type { ImportDraftV1 } from "./draft";
import { nameKey } from "./review";

// The draft goals whose name two or more open goals share: the ones an import cannot choose between.
// Accents count: «Inglés» and «Ingles» differ, but one «é» composed or decomposed is the same.
export function repeatedGoals(draft: ImportDraftV1, openNames: string[]): number[] {
  const count = new Map<string, number>();
  for (const name of openNames) count.set(nameKey(name), (count.get(nameKey(name)) ?? 0) + 1);
  const out: number[] = [];
  draft.goals.forEach((g, i) => {
    if ((count.get(nameKey(g.name)) ?? 0) > 1) out.push(i);
  });
  return out;
}
