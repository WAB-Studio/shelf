import type { PartOfSpeech } from "@/lib/dictionary/format";
import type { Sense } from "@/lib/dictionary/index-build";
import type { WordAnswer } from "@/lib/dictionary/lookup";
import { answerRanked, answerSenses, pickSense } from "@/lib/review/sense";
import { readSenseChoice } from "@/lib/review/store";
import { splitAroundWord } from "@/lib/word/mark-word";

import { cardBack, cardFront } from "./card";
import { isPhraseRow } from "./outcome";
import { openLookups, readAll } from "./record";
import { buildWordStory } from "./story";
import { readWordStudy, type StudyRow } from "./summary";
import { previewTranslations, splitTranslations } from "./translation-line";

export { cardBack, cardFront };

// `#html:true` because a card's lines are told apart by `<br>`; what a person typed is escaped.
const HEADER = ["#separator:Comma", "#html:true"];

function field(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function html(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/\r?\n/g, "<br>");
}

// What the card carries beside the row: the sense the app draws for the word and the reader's own sentence the
// app shows with it. The sense is absent for a phrase and for a word the dictionary on the device cannot answer.
export type CardExtras = { sense: Sense | null; sentence: { text: string; forms: string[] } | null };

export type CardLabels = { pos: (pos: PartOfSpeech) => string };

// Without a sense a word keeps three translations of its logged line, as the app shows them; a phrase
// keeps its translation whole, and a definition is prose that never splits.
function plainBack(row: StudyRow): string | null {
  if (row.lastTranslation === null || isPhraseRow(row)) return cardBack(row);
  return previewTranslations(splitTranslations(row.lastTranslation)).shown.join(", ") || row.lastTranslation;
}

function sentenceHtml({ text, forms }: NonNullable<CardExtras["sentence"]>): string {
  return splitAroundWord(text, forms)
    .map((piece) => (piece.hit ? `<b>${html(piece.text)}</b>` : html(piece.text)))
    .join("");
}

/**
 * The back of one card (RL-92), the same as the app's: the sense drawn, its part of speech, up to three of its
 * translations and its definition; for a phrase, its translation; and under it the reader's own sentence when the
 * app shows one. `null` when the group has no back.
 */
export function cardBackHtml(row: StudyRow, extras: CardExtras | undefined, labels: CardLabels): string | null {
  const sense = extras?.sense ?? null;
  const lines: string[] = [];
  if (sense !== null) {
    lines.push(html(labels.pos(sense.pos)), html(previewTranslations(sense.translations).shown.join(", ")));
    if (sense.definition !== null) lines.push(html(sense.definition));
  } else {
    const plain = plainBack(row);
    if (plain === null) return null;
    lines.push(html(plain));
  }
  const sentence = extras?.sentence ?? null;
  return sentence === null ? lines.join("<br>") : `${lines.join("<br>")}<br><br>${sentenceHtml(sentence)}`;
}

type AnkiCsv = { csv: string; cards: number; skipped: number; pending: number };

/**
 * One Anki-importable CSV (RL-92): the header, then a line per group that has a back, in the order given. `pending`
 * counts the groups still waiting for their answer (RL-76), left out until it comes; `skipped` counts the answered
 * groups with no back. Every field is quoted, so commas and quotes survive the import; a line break inside a card is
 * `<br>`.
 */
export function buildAnkiCsv(
  rows: readonly StudyRow[],
  labels: CardLabels,
  extras: ReadonlyMap<string, CardExtras> = new Map(),
): AnkiCsv {
  const answered = rows.filter((row) => !row.pending);
  const cards = answered.flatMap((row) => {
    const back = cardBackHtml(row, extras.get(row.key), labels);
    return back === null ? [] : [`${field(html(cardFront(row)))},${field(back)}`];
  });
  return {
    csv: [...HEADER, ...cards].join("\n") + "\n",
    cards: cards.length,
    skipped: answered.length - cards.length,
    pending: rows.length - answered.length,
  };
}

// The dictionary's answers for the words that have a card, or `null` with no copy of it on the device.
type AnswersFor = (words: string[]) => Promise<Map<string, WordAnswer> | null>;

/**
 * Reads the record and builds the file. The sense each word draws is the one the reader tapped, else the default
 * of the review (RL-85, RL-91). `plain` is true when words went out with the line the record kept, because the
 * device holds no copy of the dictionary to draw a sense from.
 */
export async function buildAnkiExport(
  labels: CardLabels,
  answersFor: AnswersFor = async () => null,
): Promise<AnkiCsv & { plain: boolean }> {
  const { rows } = await readWordStudy();
  const words = rows.filter((row) => !row.pending && !isPhraseRow(row) && cardBack(row) !== null);
  const [answers, lookups] = await Promise.all([answersFor(words.map((row) => row.key)), readAll()]);
  const choices =
    answers === null ? [] : await Promise.all(words.map((row) => readSenseChoice(row.key).catch(() => null)));
  const recorded = [...lookups, ...openLookups()];
  const extras = new Map<string, CardExtras>();
  words.forEach((row, at) => {
    const answer = answers?.get(row.key);
    const sense = answer === undefined ? null : pickSense(answerSenses(answer), choices[at] ?? null, answerRanked(answer));
    const story = buildWordStory(recorded, row.key);
    const sentence = story.phrases[0];
    extras.set(row.key, { sense, sentence: sentence === undefined ? null : { text: sentence, forms: story.forms } });
  });
  return { ...buildAnkiCsv(rows, labels, extras), plain: answers === null && words.length > 0 };
}

export async function readAnkiCounts(): Promise<{ cards: number; skipped: number; pending: number; words: number }> {
  const { rows, total } = await readWordStudy();
  const answered = rows.filter((row) => !row.pending);
  const cards = answered.filter((row) => cardBack(row) !== null).length;
  return { cards, skipped: answered.length - cards, pending: rows.length - answered.length, words: total };
}
