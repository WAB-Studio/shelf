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
 * The card's back (RL-72): the logged translation, else the network's
 * definition; `null` when the group has neither.
 */
export function cardBack(row: StudyRow): string | null {
  return row.lastTranslation ?? row.lastDefinition;
}

type AnkiExport = { csv: string; cards: number; skipped: number };

/**
 * One Anki-importable CSV: the header, then a line per group that has a back,
 * in the order given; `skipped` counts the groups with none. Every field is
 * quoted, so commas, quotes and newlines survive the import.
 */
export function buildAnkiCsv(rows: readonly StudyRow[]): AnkiExport {
  const cards = rows.flatMap((row) => {
    const back = cardBack(row);
    return back === null ? [] : [`${field(cardFront(row))},${field(back)}`];
  });
  return { csv: [...HEADER, ...cards].join("\n") + "\n", cards: cards.length, skipped: rows.length - cards.length };
}

export async function buildAnkiExport(): Promise<AnkiExport> {
  return buildAnkiCsv((await readWordStudy()).rows);
}

export async function readAnkiCounts(): Promise<{ cards: number; skipped: number; words: number }> {
  const { rows, total } = await readWordStudy();
  const { cards, skipped } = buildAnkiCsv(rows);
  return { cards, skipped, words: total };
}
