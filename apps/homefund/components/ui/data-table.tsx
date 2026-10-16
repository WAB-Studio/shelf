"use client";

import type { CSSProperties, ReactNode } from "react";
import { ChevronDown, ChevronUp, EllipsisVertical } from "lucide-react";
import { useTranslations } from "next-intl";
import { DropdownMenu } from "@radix-ui/themes";

import { IconButton } from "./button";
import styles from "./data-table.module.css";

export type DataColumn<Row> = {
  key: string;
  header: string;
  // One CSS grid track: "96px" or "1fr". Header and rows share the template.
  width: string;
  align?: "start" | "end";
  // Figures line up column-wise: the cell reads in tabular numerals (SPEC-A3).
  numeric?: boolean;
  sort?: "asc" | "desc";
  onSort?: () => void;
  cell: (row: Row) => ReactNode;
};

export type DataSection<Row> = { key: string; label: string; rows: Row[] };

/**
 * The dense list of SPEC-A3 (RF-48, RNF-08). Grid tracks lay it out and explicit
 * ARIA roles carry the semantics, because a `<table>` switched to `display: grid`
 * loses them in the accessibility tree — this way every cell is still announced
 * with its column's header.
 *
 * State never lives here: sorting, paging and filtering are the caller's.
 */
export function DataTable<Row>({
  label,
  caption,
  columns,
  rows,
  sections,
  rowKey,
  total,
  empty,
  footer,
  minWidth,
}: {
  label: string;
  // A head inside the frame, over the column headers: what this run of rows is
  // and the one way out of it. A table that names itself takes this instead of
  // sitting in a card, which would frame and pad it twice.
  caption?: ReactNode;
  columns: DataColumn<Row>[];
  rows?: Row[];
  sections?: DataSection<Row>[];
  rowKey: (row: Row) => string;
  total?: ReactNode[];
  // Drawn in place of the rows, under the column headers and inside the same
  // frame, when every section came back empty (SPEC-A3, RF-48).
  empty?: ReactNode;
  // Drawn under the container, inside the same gutter: the pagination of
  // SPEC-A3 lines up with the table's edges without a screen padding it.
  footer?: ReactNode;
  // Floors the row grid at this width so a flexible track scrolls instead of
  // collapsing when the fixed columns alone already outrun the viewport. Unset
  // everywhere but the one screen that draws this table under `md`.
  minWidth?: string;
}) {
  const groups: DataSection<Row>[] = sections ?? [
    { key: "rows", label: "", rows: rows ?? [] },
  ];

  // The zebra runs across the whole table, not per section, so a band never
  // restarts the alternation under it.
  let position = 0;

  const isEmpty = groups.every((group) => group.rows.length === 0);

  return (
    <div className={styles.gutter}>
      <div
        role="table"
        aria-label={label}
        className={styles.container}
        style={
          {
            "--data-table-columns": columns.map((c) => c.width).join(" "),
            ...(minWidth ? { "--data-table-min-width": minWidth } : {}),
          } as CSSProperties
        }
      >
        {caption && (
          <div role="caption" className={styles.caption}>
            {caption}
          </div>
        )}

        <div role="rowgroup">
          <div role="row" className={`${styles.grid} ${styles.head}`}>
            {columns.map((column) => (
              <ColumnHeader key={column.key} column={column} />
            ))}
          </div>
        </div>

        {groups.map((group) => (
          <div role="rowgroup" key={group.key} className={styles.group}>
            {group.label && (
              <div role="row" className={styles.band}>
                <div role="cell" aria-colspan={columns.length}>
                  {group.label}
                </div>
              </div>
            )}
            {group.rows.map((row) => {
              const alternate = position++ % 2 === 1;
              return (
                <div
                  role="row"
                  key={rowKey(row)}
                  className={`${styles.grid} ${styles.row}`}
                  data-alt={alternate || undefined}
                >
                  {columns.map((column) => (
                    <div
                      role="cell"
                      key={column.key}
                      className={styles.cell}
                      data-align={column.align}
                      data-numeric={column.numeric || undefined}
                    >
                      {column.cell(row)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ))}

        {empty && isEmpty && (
          <div role="rowgroup">
            <div role="row">
              <div role="cell" aria-colspan={columns.length}>
                {empty}
              </div>
            </div>
          </div>
        )}

        {total && (
          <div role="rowgroup">
            <div role="row" className={`${styles.grid} ${styles.total}`}>
              {total.map((cell, index) => (
                <div
                  role="cell"
                  key={columns[index]?.key ?? index}
                  className={styles.cell}
                  data-align={columns[index]?.align}
                  data-numeric={columns[index]?.numeric || undefined}
                >
                  {cell}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      {footer}
    </div>
  );
}

const ARIA_SORT = { asc: "ascending", desc: "descending" } as const;

// A sortable column's label is a real button; an unsortable one is plain text.
function ColumnHeader<Row>({ column }: { column: DataColumn<Row> }) {
  const chevron =
    column.sort === "asc" ? (
      <ChevronUp size={11} aria-hidden />
    ) : column.sort === "desc" ? (
      <ChevronDown size={11} aria-hidden />
    ) : null;

  return (
    <div
      role="columnheader"
      aria-sort={column.sort ? ARIA_SORT[column.sort] : undefined}
      className={styles.headCell}
      data-align={column.align}
      data-sorted={column.sort ? "" : undefined}
    >
      {column.onSort ? (
        <button type="button" className={styles.sort} onClick={column.onSort}>
          {column.header}
          {chevron}
        </button>
      ) : (
        <>
          {column.header}
          {chevron}
        </>
      )}
    </div>
  );
}

/**
 * The actions of one row. `rowName` is required and the accessible name is built
 * from it here, so the nameless "Acciones" trigger the audit found cannot be
 * written any more.
 */
export function RowMenu({
  rowName,
  items,
}: {
  rowName: string;
  items: {
    key: string;
    label: string;
    onSelect: () => void;
    tone?: "danger";
  }[];
}) {
  const t = useTranslations("common");

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <IconButton
          type="button"
          tap
          variant="ghost"
          color="gray"
          size="2"
          aria-label={t("actionsFor", { name: rowName })}
        >
          <EllipsisVertical size={16} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        {items.map((item) => (
          <DropdownMenu.Item
            key={item.key}
            color={item.tone === "danger" ? "red" : undefined}
            onSelect={item.onSelect}
          >
            {item.label}
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
