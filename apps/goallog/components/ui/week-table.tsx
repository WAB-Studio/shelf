import { Check } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";

import type { MarkState } from "./mark";
import styles from "./week-table.module.css";

export type WeekTableColumn = {
  key: string;
  label: string;
  // A column with `href` is a link in its header; `hrefLabel` names it.
  href?: string;
  hrefLabel?: string;
  // Said beside the label only where the column is wide enough to hold both;
  // narrower, it stays in the header for a screen reader and the fill still
  // marks the day.
  mark?: string;
  today?: boolean;
};

// `none` is a day nothing asked for: a quiet «·» that still has a name. A
// `null` cell has no name at all (a day before the commitment was written).
export type WeekTableCell = { state: MarkState | "none"; label: string };

// The «hechos» of a day, split where the phone's narrow cell breaks it:
// «3» over «de 8».
export type WeekTableTally = { figure: string; rest: string; percent: number };

type WeekTableGroup = {
  key: string;
  label: string;
  // A line under the label, for what the group itself says.
  note?: ReactNode;
  rows: readonly {
    key: string;
    name: string;
    detail?: string;
    // Draws the detail as a sentence (Archivo, muted) instead of a mono figure.
    sentence?: boolean;
    cells: readonly (WeekTableCell | null)[];
  }[];
};

function join(...names: (string | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}

// A day asked is a 44px square tile with one of the four marks in it; a day nothing asked is a quiet «·».
function Dot({ cell }: { cell: WeekTableCell }) {
  if (cell.state === "none") {
    return <span className={styles.none} role="img" aria-label={cell.label} data-part="week-dot" data-state="none" />;
  }
  return (
    <span className={styles.tile}>
      <span
        className={join(styles.dot, styles[cell.state])}
        role="img"
        aria-label={cell.label}
        data-part="week-dot"
        data-state={cell.state}
      >
        {cell.state === "declared" || cell.state === "evidence" ? <Check className={styles.check} strokeWidth={3} aria-hidden /> : null}
      </span>
    </span>
  );
}

// The day's «5 de 6» with its bar under it: the share done, drawn as length.
function Tally({ cell }: { cell: WeekTableTally }) {
  return (
    <>
      <span className={styles.tallyFigure}>{cell.figure}</span>
      {" "}
      <span className={styles.tallyRest}>{cell.rest}</span>
      <span className={styles.tallyBar} aria-hidden>
        <span className={styles.tallyFill} style={{ inlineSize: `${cell.percent}%` }} />
      </span>
    </>
  );
}

// «lun 26» as two lines, «lun» over «26».
function DayHead({ column }: { column: WeekTableColumn }) {
  const [weekday, date] = column.label.split(" ");
  const stack = (
    <>
      <span>{weekday}</span>
      {" "}
      <span>{date}</span>
    </>
  );
  return column.href ? (
    <Link href={column.href} aria-label={column.hrefLabel} className={styles.dayLink}>
      {stack}
    </Link>
  ) : (
    <span className={styles.dayLink}>{stack}</span>
  );
}

// `SemanaEscritorio.dc.html`: commitments down, days across.
export function WeekTable({
  caption,
  columns,
  groups,
  footer,
}: {
  caption: string;
  columns: readonly WeekTableColumn[];
  groups: readonly WeekTableGroup[];
  footer?: { label: string; cells: readonly (WeekTableTally | null)[] };
}) {
  const shade = (column: number) => (columns[column]?.today ? styles.today : undefined);

  return (
    <table className={styles.table}>
      <caption className={styles.hidden}>{caption}</caption>
      <thead>
        <tr>
          <td className={join(styles.nameColumn, styles.head)} />
          {columns.map((column, index) => (
            <th key={column.key} scope="col" className={join(styles.day, shade(index), styles.head)}>
              <span className={styles.headBox}>
                <DayHead column={column} />
                {column.mark ? <span className={styles.mark}> {column.mark}</span> : null}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {groups.map((group) => (
          <Fragment key={group.key}>
            <tr>
              <th scope="rowgroup" className={styles.group}>
                {group.label}
                {group.note ? <span className={styles.groupNote}>{group.note}</span> : null}
              </th>
              {columns.map((column, index) => (
                <td key={column.key} className={join(styles.gap, shade(index))} />
              ))}
            </tr>
            {group.rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className={styles.name}>
                  {row.detail ? (
                    <span className={styles.nameStack}>
                      <span>{row.name}</span>
                      <span className={row.sentence ? styles.sentence : styles.detail}>{row.detail}</span>
                    </span>
                  ) : (
                    row.name
                  )}
                </th>
                {columns.map((column, index) => {
                  const cell = row.cells[index] ?? null;
                  return (
                    <td key={column.key} className={join(styles.cell, shade(index))}>
                      {cell ? (
                        <Dot cell={cell} />
                      ) : (
                        <span className={styles.none} aria-hidden />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
      {footer ? (
        <tfoot>
          <tr>
            <th scope="row" className={styles.footLabel}>
              {footer.label}
            </th>
            {columns.map((column, index) => (
              <td key={column.key} className={join(styles.footCell, shade(index))}>
                {footer.cells[index] ? <Tally cell={footer.cells[index]} /> : null}
              </td>
            ))}
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}

// `SemanaPlegada.dc.html`: the table narrowed to the phone. The seven days sit
// once under the header; each commitment is a name over its seven marks, in
// the day's own column.
export function WeekFold({
  columns,
  groups,
  footer,
}: {
  columns: readonly WeekTableColumn[];
  groups: readonly WeekTableGroup[];
  footer?: { label: ReactNode; cells: readonly (WeekTableTally | null)[] };
}) {
  const shade = (column: number) => (columns[column]?.today ? styles.foldToday : undefined);

  return (
    <div className={styles.fold}>
      <div className={styles.foldHead}>
        {columns.map((column, index) => (
          <div key={column.key} className={join(styles.foldDay, shade(index), columns[index]?.today ? styles.foldTop : undefined)}>
            <DayHead column={column} />
            {column.mark ? <span className={styles.hidden}>{column.mark}</span> : null}
          </div>
        ))}
      </div>
      {groups.map((group) => (
        <section key={group.key} className={styles.foldGroup}>
          <h2 className={styles.foldGroupLabel}>{group.label}</h2>
          {group.note ? <div className={styles.foldGroupNote}>{group.note}</div> : null}
          {group.rows.map((row) => (
            <div key={row.key} className={styles.foldRow}>
              <p className={styles.foldName}>{row.name}</p>
              {row.detail ? <p className={row.sentence ? styles.foldSentence : styles.foldDetail}>{row.detail}</p> : null}
              <div className={styles.foldMarks}>
                {columns.map((column, index) => {
                  const cell = row.cells[index] ?? null;
                  return (
                    <div key={column.key} className={join(styles.foldCell, shade(index))}>
                      {cell ? <Dot cell={cell} /> : <span className={styles.none} aria-hidden />}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      ))}
      {footer ? (
        <div className={styles.foldFoot}>
          <p className={join(styles.foldGroupLabel, typeof footer.label === "string" ? undefined : styles.foldSum)}>{footer.label}</p>
          <div className={styles.foldMarks}>
            {columns.map((column, index) => {
              const cell = footer.cells[index];
              return (
                <div key={column.key} className={join(styles.foldTally, shade(index), columns[index]?.today ? styles.foldBottom : undefined)}>
                  {cell ? <Tally cell={cell} /> : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
