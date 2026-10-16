"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import {
  ColorSwatch,
  DataTable,
  Flex,
  RowMenu,
  Text,
  type DataColumn,
  type DataSection,
} from "@/components/ui";
import type { LabelManagementRow } from "@/db/queries/labels";

// The tracks of the Etiquetas artboard, in order.
const WIDTHS = {
  label: "minmax(0, 1fr)",
  scope: "168px",
  movements: "128px",
  budgets: "128px",
  menu: "36px",
} as const;

/**
 * A managed label plus what the screen already resolved: `scopeLabel` names
 * the section it came from ("Personal" or the group's own name) and
 * `canManage` closes the row menu on a group row for anyone but the leader
 * (RF-57), exactly as the mobile cards close it today.
 */
export type LabelTableRow = LabelManagementRow & {
  scopeLabel: string;
  canManage: boolean;
};

/**
 * The dense Etiquetas of `private/design-desktop/SPEC-A3.md` (RF-70, RF-116):
 * one section per scope, personal and the group's, each row carrying the two
 * counts the query already derived — `movementCount` and `budgetCount` — so a
 * label nobody uses reads 0 in both, never an em dash.
 */
export function LabelsTable<Row extends LabelTableRow>({
  sections,
  empty,
  onEdit,
  onDelete,
}: {
  sections: DataSection<Row>[];
  empty?: ReactNode;
  onEdit: (row: Row) => void;
  onDelete: (row: Row) => void;
}) {
  const t = useTranslations("labels");
  const tKey = useTranslations();

  const columns: DataColumn<Row>[] = [
    {
      key: "label",
      header: t("tableLabel"),
      width: WIDTHS.label,
      cell: (row) => (
        <Flex align="center" gap="2" minWidth="0">
          {row.color && <ColorSwatch color={row.color} label={row.name} />}
          <Text size="2" weight="medium" truncate>
            {row.name}
          </Text>
        </Flex>
      ),
    },
    {
      key: "scope",
      header: t("tableScope"),
      width: WIDTHS.scope,
      cell: (row) => (
        <Text size="2" color="gray" truncate>
          {row.scopeLabel}
        </Text>
      ),
    },
    {
      key: "movements",
      header: t("tableMovements"),
      width: WIDTHS.movements,
      align: "end",
      numeric: true,
      cell: (row) => <Text size="2">{row.movementCount}</Text>,
    },
    {
      key: "budgets",
      header: t("tableBudgets"),
      width: WIDTHS.budgets,
      align: "end",
      numeric: true,
      cell: (row) => <Text size="2">{row.budgetCount}</Text>,
    },
    {
      key: "menu",
      header: "",
      width: WIDTHS.menu,
      align: "end",
      cell: (row) =>
        row.canManage ? (
          <RowMenu
            rowName={row.name}
            items={[
              {
                key: "edit",
                label: tKey("common.edit"),
                onSelect: () => onEdit(row),
              },
              {
                key: "delete",
                label: tKey("common.delete"),
                tone: "danger",
                onSelect: () => onDelete(row),
              },
            ]}
          />
        ) : null,
    },
  ];

  return (
    <DataTable
      label={t("title")}
      columns={columns}
      sections={sections}
      rowKey={(row) => row.id}
      empty={empty}
    />
  );
}
