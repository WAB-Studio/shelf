import { readWordStudy, type StudyRow } from "./summary";

const HEADER = ["#separator:Comma", "#html:false"];

/**
 * The card's front, repeating the registro's rule: a phrase or an unlisted
 * word reached no lemma and keeps the text as typed; every other group shows
 * its lemma.
 */
export function cardFront(row: StudyRow): string {
  return row.lastOutcome === "translated" || row.lastOutcome === "unlisted" ? row.display : row.key;
}

function field(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * One Anki-importable CSV: the header, then a line per group that has a
 * logged translation, in the order given. Every field is quoted, so commas,
 * quotes and newlines inside a translation survive the import.
 */
export function buildAnkiCsv(rows: readonly StudyRow[]): { csv: string; cards: number } {
  const cards = rows.flatMap((row) =>
    row.lastTranslation === null ? [] : [`${field(cardFront(row))},${field(row.lastTranslation)}`],
  );
  return { csv: [...HEADER, ...cards].join("\n") + "\n", cards: cards.length };
}

export async function buildAnkiExport(): Promise<{ csv: string; cards: number }> {
  return buildAnkiCsv((await readWordStudy()).rows);
}
