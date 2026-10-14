import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { isValidElement, type ReactNode } from "react";

import { isTimeUnit, type TimeWords } from "@/lib/units/time";

import { TimeParts, useTimeWords } from "./figure";
import { formatFigureValue, isTimeFigure } from "./format-figure";
import styles from "./table.module.css";

// docs/pulsar/DESIGN.md, the review (RP-17): one set of props, two faces. The
// phone draws `Revision.dc.html`'s stack of ruled rows; past the kit's 700px
// breakpoint the same rows become `RevisionEscritorio.dc.html`'s real
// `<table>`. Both are always in the markup and CSS shows one, so a screen
// never switches markup itself.
export type TableRow = {
  key: string;
  // One per column, in `columns`' order. In a figure column, `null` or
  // `undefined` is a week not yet reached and draws «—».
  cells: readonly ReactNode[];
  // The phone face's trailing note: the wide face spreads it over columns
  // the phone has no room for, so the caller words it once for the phone.
  note?: ReactNode;
  // The phone's one figure when it is not the wide face's cell: the wide
  // «10 h de 12 h» reads «10 h» there, its «de 12 h» going in the note.
  phoneFigure?: ReactNode;
  // Drops the unit word after the phone's figure, for a row whose note carries
  // it after «de» (`UnidadUnaVez`'s «34 / de 60 búsquedas»): the unit once.
  phoneBare?: boolean;
  // A second line under the row label, on both faces: the week's dates.
  detail?: ReactNode;
  // Makes the row one link, a whole 48px or more tall, in ink (`MesesFilas.dc.html`).
  // The lead cell must then be plain text: it is what the link names, so a
  // link of its own there would nest. Every other cell stays text.
  href?: string;
  // `false` keeps the row on screen and off paper, on both faces. Omitted prints.
  printed?: boolean;
};

type TableProps = {
  // The phone's caption above the stack; the wide table's accessible name.
  caption: string;
  // Header strings, wide face. Column 0 is the row label on both faces.
  columns: readonly string[];
  rows: readonly TableRow[];
  // Indexes into `columns` set as figures. The first is the one figure the
  // phone shows and the one the wide face sets at the measure's size.
  figures?: readonly number[];
  // Beside the phone's figure; the wide face names it in its header. A unit
  // of time (RP-35) is spelled out in every figure cell instead, as
  // `RevisionHoras.dc.html` draws: no unit word beside them, none in the header.
  unit?: string;
  // Index into `rows`. Marked `data-current` only: the boards draw the
  // current week by its note alone, never by a fill or a weight.
  current?: number;
  // Draws the phone's stack at every width, for a table living in a narrow
  // column (`MesesListaDetalle.dc.html`'s 320px list).
  narrow?: boolean;
  // Index into `rows` of the row whose page is open beside the table: its link
  // is `aria-current`, filled, its name bold.
  open?: number;
  // Keeps the wide face's label column on one line (`ReporteMesesSemanas.dc.html`'s
  // «sem 1 · 28 jul–2 ago 2026»): the column grows to its text rather than wrap it.
  nowrapLabel?: boolean;
  // Draws the phone's stack from 1024 to 1279px, where the shell's rail leaves
  // a two-column card too narrow for the wide face; the wide face returns at 1280.
  stackInCard?: boolean;
  // Lets a row's `detail` wrap, for a state line longer than its label column.
  wrapDetail?: boolean;
  // Grows the label column to its longest `detail`, one width on every row of
  // both faces, rather than hold 112px (`RevisionConAño.dc.html`'s «28 sep–4 oct
  // 2026»). Unlinked rows only: a linked row's anchor is not on the phone's grid.
  fitDetail?: boolean;
  // Lets a `narrow` table's note wrap at a word when it does not fit beside the
  // chevron («0 de 60 / búsquedas» in the 320px list); a note that fits keeps its line.
  // Off `narrow`, an unlinked row's note drops under the label and figure when
  // even its narrowest form does not fit beside them.
  wrapNote?: boolean;
  // A note that never splits («de 7 h 15 min»): beside the label when it fits whole,
  // else dropped whole under it. Never breaks inside, never leaves its row. On a `narrow`
  // linked row the chevron rides the row's end and the anchor wraps.
  wholeNote?: boolean;
  // Folds the whole table under a link-card with this text, closed
  // (`ReportePlegado.dc.html`'s «Ver las 9 semanas»). Paper never prints it.
  fold?: string;
  // A line under the last row, kept with it on paper: it never starts a page
  // alone. The wide face holds it as the table's last row (`data-row="months-out"`),
  // the phone's stack as a block below.
  after?: ReactNode;
  // Shows `after` on paper only; the screen draws nothing for it.
  afterPrintOnly?: boolean;
  // A link before the first row, on screen only («ver menos»): under the phone's
  // caption, above the wide face's table, or under its caption with `showCaption`.
  above?: ReactNode;
  // Draws the caption over the wide face too, on screen; paper says it in the
  // section label's own suffix.
  showCaption?: boolean;
  // The table's title on paper only («estos meses con monto propio:»): the first
  // row of the wide face's head, over the column names, so it stays with the first
  // row as the head does and comes back with the head on every sheet it runs onto.
  printTitle?: ReactNode;
  // A line before the wide face's head on paper only, printed once («12 meses anteriores»):
  // it never repeats with the head on a later sheet and never closes one.
  printLead?: ReactNode;
};

function isEmpty(cell: ReactNode): boolean {
  return cell === null || cell === undefined;
}

function figureCell(cell: ReactNode, unit: string | undefined, words: TimeWords): ReactNode {
  if (isEmpty(cell)) return <span className={styles.pending}>—</span>;
  const formatted = formatFigureValue(cell, unit, words);
  return isTimeFigure(formatted) ? <TimeParts time={formatted} unitClass={styles.unit} /> : formatted;
}

export function Table({ caption, columns, rows, figures = [], unit, current, narrow, open, nowrapLabel, stackInCard, wrapDetail, fitDetail, wrapNote, wholeNote, fold, after, afterPrintOnly, above, showCaption, printTitle, printLead }: TableProps) {
  const words = useTimeWords();
  const lead = figures[0];
  const last = columns.length - 1;
  const unitWord = unit && !isTimeUnit(unit) ? unit : undefined;

  const cellClass = (column: number): string => {
    if (column === 0) return nowrapLabel ? `${styles.label} ${styles.nowrap}` : styles.label;
    if (column === lead) return styles.lead;
    if (figures.includes(column)) return styles.figure;
    return column === last ? styles.note : styles.text;
  };

  // The board sizes each column by its role; the last one takes what is left.
  const widthClass = (column: number): string | undefined => {
    if (column === last) return undefined;
    if (column === 0) return styles.labelWidth;
    if (column === lead) return styles.leadWidth;
    if (figures.includes(column)) return styles.figureWidth;
    return styles.textWidth;
  };

  const join = (...names: (string | undefined)[]) => names.filter(Boolean).join(" ");

  const phoneRow = (row: TableRow): ReactNode => {
    const figure = lead === undefined ? null : row.phoneFigure === undefined ? row.cells[lead] : row.phoneFigure;
    return (
    <>
      <span className={styles.stackLabel}>
        {row.cells[0]}
        {row.detail ? <span className={styles.detail}>{row.detail}</span> : null}
      </span>
      {lead === undefined ? null : (
        <span className={styles.stackFigure}>
          {figureCell(figure, unit, words)}
          {unitWord && !isEmpty(figure) && !row.phoneBare ? (
            <span className={styles.unit}>{words.unit?.(unitWord, typeof figure === "number" ? figure : 2) ?? unitWord}</span>
          ) : null}
        </span>
      )}
      {row.note ? <span className={styles.stackNote}>{row.note}</span> : null}
    </>
    );
  };

  const lastPrinted = rows.findLastIndex((row) => row.printed !== false);

  const faces = (
    <>
      <div className={styles.phone}>
        <span className={styles.caption}>{caption}</span>
        {above ? <div className={styles.above}>{above}</div> : null}
        {printTitle ? <div className={styles.printTitle}>{printTitle}</div> : null}
        <ol className={styles.stack}>
          {rows.map((row, index) => (
            <li
              key={row.key}
              className={
                row.href
                  ? `${styles.stackRow} ${styles.linked}${index === open ? ` ${styles.open}` : ""}`
                  : styles.stackRow
              }
              data-current={index === current ? "" : undefined}
              data-unprinted={row.printed === false ? "" : undefined}
            >
              {row.href ? (
                <Link
                  href={row.href}
                  className={styles.rowLink}
                  aria-current={index === open ? "page" : undefined}
                >
                  {phoneRow(row)}
                  <ChevronRight size={16} strokeWidth={1.5} aria-hidden className={styles.chevron} />
                </Link>
              ) : (
                phoneRow(row)
              )}
            </li>
          ))}
        </ol>
        {after && !afterPrintOnly ? <div className={styles.after}>{after}</div> : null}
      </div>

      {above && !showCaption ? <div className={styles.wideAbove}>{above}</div> : null}
      {printLead ? <div className={styles.printLead}>{printLead}</div> : null}
      <table className={styles.wide}>
        <caption className={showCaption ? styles.wideCaption : styles.hidden}>
          {caption}
          {showCaption && above ? <span className={styles.captionAbove}>{above}</span> : null}
        </caption>
        <thead>
          {printTitle ? (
            <tr className={styles.titleRow}>
              <td colSpan={columns.length} className={styles.titleCell}>
                {printTitle}
              </td>
            </tr>
          ) : null}
          <tr>
            {columns.map((header, column) => (
              <th key={column} scope="col" className={join(styles.header, widthClass(column))}>
                {header}
                {column === lead && unitWord ? (
                  <span className={styles.headerUnit}>{words.unit?.(unitWord, 2) ?? unitWord}</span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={row.key}
              className={row.href ? styles.linkedRow : undefined}
              data-current={index === current ? "" : undefined}
              data-unprinted={row.printed === false ? "" : undefined}
              data-last={after && index === lastPrinted ? "" : undefined}
            >
              {columns.map((_, column) => (
                <td key={column} className={join(styles.cell, cellClass(column))}>
                  {column === 0 && row.href ? (
                    <Link href={row.href} className={styles.cellLink}>
                      {row.cells[column]}
                    </Link>
                  ) : column === lead && !isValidElement(row.cells[column]) ? (
                    <span className={styles.leadValue}>{figureCell(row.cells[column], unit, words)}</span>
                  ) : figures.includes(column) ? (
                    figureCell(row.cells[column], unit, words)
                  ) : (
                    row.cells[column]
                  )}
                  {column === 0 && row.detail ? (
                    <span className={styles.detailWide}>{row.detail}</span>
                  ) : null}
                </td>
              ))}
            </tr>
          ))}
          {after ? (
            <tr className={styles.afterRow} data-row="months-out" data-print-only={afterPrintOnly ? "" : undefined}>
              <td colSpan={columns.length} className={styles.afterCell}>
                {after}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </>
  );

  const className = join(styles.table, narrow ? styles.narrow : undefined, stackInCard ? styles.stackInCard : undefined, wrapDetail ? styles.wrapDetail : undefined, fitDetail ? styles.fitDetail : undefined, wrapNote ? styles.wrapNote : undefined, wholeNote ? styles.wholeNote : undefined);
  if (fold === undefined) return <div className={className}>{faces}</div>;
  return (
    <details className={join(className, styles.fold)}>
      <summary className={styles.foldSummary}>
        {fold}
        <ChevronRight size={16} strokeWidth={1.5} aria-hidden className={styles.foldChevron} />
      </summary>
      {faces}
    </details>
  );
}
