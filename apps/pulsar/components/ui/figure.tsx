import { Fragment, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import type { MessageKey } from "@/i18n/translator";
import type { TimeWords } from "@/lib/units/time";

import { formatFigureValue, isTimeFigure, type TimeFigure } from "./format-figure";
import styles from "./figure.module.css";

// The catalogue's «h» and «min» (`messages/es/units.json`), shaped the way
// `lib/units/time.ts` takes them.
export function useTimeWords(): TimeWords {
  const t = useTranslations("units");
  const root = useTranslations();
  return {
    h: (h) => t("h", { h }),
    min: (min) => t("min", { min }),
    join: (h, min) => t("join", { h, min }),
    // The catalogue's `words` agree with the count in ICU plural; a word it
    // lacks (the unit is free text) prints as typed.
    unit: (unit, n) => {
      const word = unit.trim().toLowerCase();
      const key = `units.words.${word}` as MessageKey;
      return /^\p{L}+$/u.test(word) && root.has(key) ? root(key, { count: n }) : unit;
    },
  };
}

// Each figure in mono, each word after it in the caller's quiet class. The
// spaces are flex-collapsed where the parent is a flex box and keep the
// text reading «12 h 30 min» wherever it is copied or read aloud.
export function TimeParts({ time, unitClass }: { time: TimeFigure; unitClass: string }) {
  return time.tokens.map((token, index) => (
    <Fragment key={index}>
      {index > 0 ? " " : null}
      {token.figure ? token.text : <span className={unitClass}>{token.text}</span>}
    </Fragment>
  ));
}

// docs/pulsar/DESIGN.md: hours, counts, minutes, dates and quantities are the
// log's substance, so they are set in mono and their unit sits beside them in
// quiet. `measure` is the 26px figure; `meta` the 12px one inside a row. A
// time (RP-35) carries its own «h» and «min», so its unit word is not drawn.
// `bare` drops a word unit for a caller that says it once elsewhere; a time
// keeps its «h» and «min», which are part of the figure.
export function Figure({
  value,
  unit,
  variant = "measure",
  bare = false,
  breakUnit,
}: {
  value: ReactNode;
  unit?: string;
  variant?: "measure" | "meta";
  bare?: boolean;
  // Lets a word unit drop under its figure when the line runs out («de 60 /
  // búsquedas»): the figure flows as text, so a no-break space before it keeps
  // it with the word it follows. A time keeps its line.
  breakUnit?: boolean;
}) {
  const words = useTimeWords();
  const size = variant === "meta" ? styles.meta : styles.measure;
  const formatted = formatFigureValue(value, unit, words);
  const wordUnit = unit && !bare && !isTimeFigure(formatted) ? unit : null;
  const breaks = Boolean(breakUnit && wordUnit);
  return (
    <span className={`${styles.figure} ${size} ${wordUnit ? styles.worded : ""} ${breaks ? styles.breaks : ""}`}>
      {isTimeFigure(formatted) ? <TimeParts time={formatted} unitClass={styles.unit} /> : formatted}
      {/* A no-break space for copy and a screen reader to hear «20 páginas»; it draws no width, the spacer's padding does. */}
      {wordUnit ? <span className={styles.space}>{breaks ? " " : "\u00a0"}</span> : null}
      {wordUnit ? (
        <span className={styles.unit}>{typeof value === "number" ? (words.unit?.(wordUnit, value) ?? wordUnit) : wordUnit}</span>
      ) : null}
    </span>
  );
}
