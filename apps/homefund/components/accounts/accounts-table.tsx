"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import {
  Badge,
  DataTable,
  Flex,
  PersonalMark,
  Money,
  RowMenu,
  Text,
  type DataColumn,
} from "@/components/ui";
import type { AccountRow } from "@/db/queries/accounts";

// The em dash a cell with nothing to name reads as (SPEC-A3), not a word a
// translator would ever change.
const NO_VALUE = "—";

// The tracks of the Cuentas artboard, in order.
const WIDTHS = {
  name: "minmax(0, 1fr)",
  institution: "196px",
  lastFour: "132px",
  kind: "108px",
  balance: "168px",
  menu: "36px",
} as const;

/**
 * The dense Cuentas of `private/design-desktop/SPEC-A3.md` (RF-114): every
 * account's balance arrives already derived from `account_balances` and only
 * reads through `Money` here — no figure is computed on the client, and a
 * liability's own negative cents carries the minus through. `archived` decides
 * whether a row offers to archive or to restore it, mirroring the phone's card.
 */
export function AccountsTable({
  rows,
  archived,
  hasGroup,
  empty,
  onEdit,
  onReconcile,
  onArchive,
  onRestore,
  onDelete,
  onHandOver,
}: {
  rows: AccountRow[];
  archived: boolean;
  // Only a personal, live account of a caller who has a group has anywhere to
  // go (RF-60, RF-61), mirroring the phone's card.
  hasGroup: boolean;
  empty?: ReactNode;
  onEdit: (row: AccountRow) => void;
  onReconcile: (row: AccountRow) => void;
  onArchive: (row: AccountRow) => void;
  onRestore: (row: AccountRow) => void;
  onDelete: (row: AccountRow) => void;
  onHandOver: (row: AccountRow) => void;
}) {
  const t = useTranslations("accounts");
  const tKey = useTranslations();

  function absent(): ReactNode {
    return (
      <Text size="2" color="gray">
        {NO_VALUE}
      </Text>
    );
  }

  const columns: DataColumn<AccountRow>[] = [
    {
      key: "name",
      header: t("nameLabel"),
      width: WIDTHS.name,
      cell: (row) => (
        <Flex direction="column" gap="1" minWidth="0">
          <Flex align="center" gap="2" minWidth="0">
            <Text size="2" weight="medium" truncate>
              {row.name}
            </Text>
            {row.ownerUserId && <PersonalMark label={t("ownerPersonal")} />}
          </Flex>
          {/* One scope, never both: a personal account names its owner, a
              group account the group (RF-60). */}
          <Text size="2" color="gray">
            {row.ownerUserId ? t("ownerPersonal") : t("ownerFund")}
          </Text>
        </Flex>
      ),
    },
    {
      key: "institution",
      header: t("institutionLabel"),
      width: WIDTHS.institution,
      cell: (row) =>
        row.institution ? (
          <Text size="2" color="gray" truncate>
            {row.institution}
          </Text>
        ) : (
          absent()
        ),
    },
    {
      key: "lastFour",
      header: t("lastFourLabel"),
      width: WIDTHS.lastFour,
      align: "end",
      numeric: true,
      cell: (row) =>
        row.lastFour ? (
          <Text size="2" color="gray">
            {row.lastFour}
          </Text>
        ) : (
          absent()
        ),
    },
    {
      key: "kind",
      header: t("kindLabel"),
      width: WIDTHS.kind,
      cell: (row) => (
        <Badge color={row.kind === "liability" ? "red" : "green"}>
          {t(row.kind === "liability" ? "kindLiability" : "kindAsset")}
        </Badge>
      ),
    },
    {
      key: "balance",
      header: t("balanceLabel"),
      width: WIDTHS.balance,
      align: "end",
      numeric: true,
      // The query already derived these from movements, never a stored column
      // (RF-114), and ordered the settlement currency first (RF-121). The cell
      // leads with it and names every other currency the account holds under it,
      // the same cut the phone's card makes; no cell here adds two currencies
      // together (RF-124). The figure carries its own minus, so no expense tone
      // is borrowed to draw one.
      cell: (row) => {
        const [settlement, ...others] = row.balances;

        return (
          <Flex direction="column" gap="1" align="end">
            {settlement && (
              <Money
                minor={settlement.balanceCents}
                currency={settlement.currency}
                tone="plain"
              />
            )}
            {others.map((balance) => (
              <Text key={balance.currency} size="1" color="gray">
                {t.rich("balanceInCurrency", {
                  amount: () => (
                    <Money
                      minor={balance.balanceCents}
                      currency={balance.currency}
                      tone="plain"
                      size="inherit"
                    />
                  ),
                  currency: balance.currency,
                })}
              </Text>
            ))}
          </Flex>
        );
      },
    },
    {
      key: "menu",
      header: "",
      width: WIDTHS.menu,
      align: "end",
      cell: (row) => (
        <RowMenu
          rowName={row.name}
          items={[
            // An archived row is read-only: the way back is all it offers.
            ...(archived
              ? [
                  {
                    key: "restore",
                    label: tKey("common.restore"),
                    onSelect: () => onRestore(row),
                  },
                ]
              : [
                  {
                    key: "edit",
                    label: tKey("common.edit"),
                    onSelect: () => onEdit(row),
                  },
                  ...(row.canWrite
                    ? [
                        {
                          key: "reconcile",
                          label: t("reconcile"),
                          onSelect: () => onReconcile(row),
                        },
                      ]
                    : []),
                  {
                    key: "archive",
                    label: tKey("common.archive"),
                    onSelect: () => onArchive(row),
                  },
                  ...(hasGroup && row.ownerUserId !== null
                    ? [
                        {
                          key: "handOver",
                          label: t("handOver"),
                          onSelect: () => onHandOver(row),
                        },
                      ]
                    : []),
                ]),
            {
              key: "delete",
              label: tKey("common.delete"),
              tone: "danger" as const,
              onSelect: () => onDelete(row),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <DataTable
      label={t("title")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      empty={empty}
    />
  );
}
