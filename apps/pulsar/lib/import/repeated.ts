import type { ImportDraftV1 } from "./draft";

// Accents count: «Inglés» and «Ingles» differ, but one «é» composed or decomposed is the same.
function key(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLocaleLowerCase("es");
}

export function repeatedGoals(draft: ImportDraftV1, openNames: string[]): number[] {
  const open = new Set(openNames.map(key));
  const out: number[] = [];
  draft.goals.forEach((g, i) => {
    if (open.has(key(g.name))) out.push(i);
  });
  return out;
}
