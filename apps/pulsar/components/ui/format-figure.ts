import type { ReactNode } from "react";

import { formatCount, formatTime, isTimeUnit, type TimeWords } from "@/lib/units/time";

// One run of a time's text: a figure set in mono, or the quiet word after it.
export type TimeToken = { text: string; figure: boolean };

// A time is handed back as tokens, not a string: the primitive sets each
// word in the unit's quiet, so it has to know where the figures end.
export type TimeFigure = { kind: "time"; tokens: readonly TimeToken[] };

// A grouped number in "es": digits, with "." or a narrow space between groups.
const FIGURE = /(\d+(?:[.  ]\d{3})*)/;

// `formatTime` already settles a zero part, an exact hour and the grouping;
// cutting its text keeps every one of those rules in `lib/units/time.ts`.
function timeTokens(text: string): TimeToken[] {
  return text
    .split(FIGURE)
    .map((piece, index) => ({ text: piece.trim(), figure: index % 2 === 1 }))
    .filter((token) => token.text !== "");
}

export function isTimeFigure(value: unknown): value is TimeFigure {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "time";
}

// A goal's measure is a bare sum (RP-14, `lib/queries/goal.ts`'s own
// `measureTotal`): past a few hundred it read `1000039`, all one run of
// digits with nothing to break it into groups. A plain number is the only
// shape this ever needs to dress; anything else a caller hands in — a
// string already worded, a fragment with a mark inside it — is a figure's
// business already settled by whoever built it, so it draws as is. A number
// in a unit of time (RP-35) reads in hours and minutes instead.
//
// A file of its own, never `figure.tsx` itself: that file imports its own
// `.module.css`, which only a bundler resolves — `figure.test.ts` runs under
// plain `node:test`, so the one function worth proving in isolation has to
// live somewhere a CSS import cannot follow it in.
export function formatFigureValue(
  value: ReactNode,
  unit?: string,
  words?: TimeWords,
): ReactNode | TimeFigure {
  if (typeof value !== "number") return value;
  if (unit !== undefined && words !== undefined && isTimeUnit(unit)) {
    return { kind: "time", tokens: timeTokens(formatTime(value, words)) };
  }
  // The one grouping every count reads in: «2.100» beside «6.000», never «2100».
  return formatCount(value);
}
