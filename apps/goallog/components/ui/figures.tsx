import { Fragment } from "react";

import styles from "./figures.module.css";

// A run of digits, with the separators that join them inside one figure («1.250», «2,5», «16:00», «5/7»).
const FIGURE = /(\d[\d.,:/]*\d|\d)/;

// docs/goallog/DESIGN.md «a figure is set in mono, a sentence in Archivo»: a catalogue sentence drawn with its
// figures in mono, for the strings whose numbers arrive already written into the words («4 de 4 esta semana»).
export function Figures({ text }: { text: string }) {
  const parts = text.split(FIGURE);
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className={styles.fig}>
            {part}
          </span>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}
