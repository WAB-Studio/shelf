"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import {
  CategoryTile,
  DataTable,
  Flex,
  RowMenu,
  Text,
  type DataColumn,
  type DataSection,
} from "@/components/ui";

// The em dash a cell with nothing to name reads as (SPEC-A3), not a word a
// translator would ever change.
const NO_VALUE = "—";

// The tracks of the Categorías artboard, in order.
const WIDTHS = {
  category: "minmax(0, 1fr)",
  kind: "108px",
  subcategories: "150px",
  menu: "36px",
} as const;

/**
 * One row the screen already flattened: a top-level category or one of its
 * children, in the order the section draws them (RF-63). `childCount` is null
 * on a child row — nesting stops at one level, so it never has one of its own
 * — and reads as an em dash rather than a zero. `canManage` and `canAddSub`
 * arrive already decided: a group row closes both when the caller is not the
 * group's leader (RF-57), exactly as the screen closes them today.
 */
export type CategoryTableRow = {
  id: string;
  name: string;
  color: string | null;
  kind: "expense" | "income";
  parentId: string | null;
  childCount: number | null;
  canManage: boolean;
  canAddSub: boolean;
};

/**
 * The dense Categorías of `private/design-desktop/SPEC-A3.md` (RF-63, RF-116):
 * one section per scope, personal and the group's, a subcategory drawn right
 * under its parent inside that same section and never the other. The count in
 * `subcategorías` is the query's own `childCount` (RF-116) — this table never
 * recomputes it from the rows it was handed.
 */
export function CategoriesTable<Row extends CategoryTableRow>({
  sections,
  empty,
  onEdit,
  onAddSub,
  onDelete,
}: {
  sections: DataSection<Row>[];
  empty?: ReactNode;
  onEdit: (row: Row) => void;
  onAddSub: (row: Row) => void;
  onDelete: (row: Row) => void;
}) {
  const t = useTranslations("categories");
  const tKey = useTranslations();

  const columns: DataColumn<Row>[] = [
    {
      key: "category",
      header: t("tableCategory"),
      width: WIDTHS.category,
      cell: (row) => (
        <Flex
          align="center"
          gap="2"
          minWidth="0"
          pl={row.parentId ? "6" : "0"}
        >
          {row.color && <CategoryTile color={row.color} size={9} />}
          <Text
            size="2"
            weight={row.parentId ? undefined : "medium"}
            truncate
          >
            {row.name}
          </Text>
        </Flex>
      ),
    },
    {
      key: "kind",
      header: t("tableKind"),
      width: WIDTHS.kind,
      cell: (row) => (
        <Text size="2" color="gray">
          {t(row.kind === "income" ? "kindIncome" : "kindExpense")}
        </Text>
      ),
    },
    {
      key: "subcategories",
      header: t("tableSubcategories"),
      width: WIDTHS.subcategories,
      align: "end",
      numeric: true,
      cell: (row) => (
        <Text size="2" color="gray">
          {row.childCount === null ? NO_VALUE : row.childCount}
        </Text>
      ),
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
              ...(row.canAddSub
                ? [
                    {
                      key: "addSub",
                      label: t("addSub"),
                      onSelect: () => onAddSub(row),
                    },
                  ]
                : []),
              {
                key: "delete",
                label: tKey("common.delete"),
                tone: "danger" as const,
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
