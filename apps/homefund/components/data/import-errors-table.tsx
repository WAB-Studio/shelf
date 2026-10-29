"use client";

import { useTranslations } from "next-intl";

import { DataTable, Text, type DataColumn } from "@/components/ui";

// The em dash a cell with nothing to name reads as (SPEC-A3): here, honestly,
// only for the rare check that spans more than one cell, never for every row.
const NO_VALUE = "—";

// One error, already flattened and translated: the screen owns the entity and
// message lookups (`sheets.*`, the error's own namespace, `columns.*` for the
// header `column` already carries translated), so this table costs no lookup
// of its own. `column` and `value` are null together, for the one check that
// names no single cell (RF-51).
export type ImportErrorRow = {
  key: string;
  sheet: string;
  // The row number the file itself carries (RF-51) — what a person sees opening it
  // in Excel, never the row's position in the parsed array.
  sheetRow: number;
  column: string | null;
  value: string | null;
  problem: string;
};

const WIDTHS = {
  sheet: "150px",
  sheetRow: "70px",
  column: "150px",
  value: "150px",
  problem: "minmax(0, 1fr)",
} as const;

/**
 * The import preview's per-row errors (RF-51), flattened across every sheet
 * into one table over the same all-or-nothing confirm the screen already
 * gates: one errored row anywhere still writes nothing. "Columna" and "valor"
 * trace back through the pipeline to the cell a problem came from and the raw
 * text the person typed there; a check that spans more than one cell (an
 * account named twice, a split that does not sum to its total) draws neither,
 * rather than pin the blame on one cell that did not cause it.
 */
export function ImportErrorsTable({ rows }: { rows: ImportErrorRow[] }) {
  const t = useTranslations("data");

  const columns: DataColumn<ImportErrorRow>[] = [
    {
      key: "sheet",
      header: t("screen.reportSheet"),
      width: WIDTHS.sheet,
      cell: (row) => (
        <Text size="2" color="gray" truncate>
          {row.sheet}
        </Text>
      ),
    },
    {
      key: "sheetRow",
      header: t("screen.reportRow"),
      width: WIDTHS.sheetRow,
      numeric: true,
      cell: (row) => <Text size="2">{row.sheetRow}</Text>,
    },
    {
      key: "column",
      header: t("screen.reportColumn"),
      width: WIDTHS.column,
      cell: (row) => (
        <Text size="2" color="gray" truncate>
          {row.column ?? NO_VALUE}
        </Text>
      ),
    },
    {
      key: "value",
      header: t("screen.reportValue"),
      width: WIDTHS.value,
      cell: (row) => (
        <Text size="2" color="gray" truncate>
          {row.value ?? NO_VALUE}
        </Text>
      ),
    },
    {
      key: "problem",
      header: t("screen.reportProblem"),
      width: WIDTHS.problem,
      cell: (row) => <Text size="2">{row.problem}</Text>,
    },
  ];

  return (
    <DataTable
      label={t("screen.importHeading")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.key}
    />
  );
}
