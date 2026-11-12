"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { useOwnerLabel } from "@/components/fund/owner-mark";
import {
  DataTable,
  Flex,
  PersonalMark,
  Money,
  RowMenu,
  Text,
  type DataColumn,
  type DataSection,
} from "@/components/ui";
import type { AccountRow } from "@/db/queries/accounts";

// The em dash a cell with nothing to name reads as in the desktop design, not a word a
// translator would ever change.
const NO_VALUE = "—";

// The tracks of the Cuentas artboard, in order.
const WIDTHS = {
  name: "minmax(0, 1fr)",
  institution: "196px",
  lastFour: "148px",
  balance: "168px",
  menu: "36px",
} as const;

// What a table row draws: an account, or the free part of one that holds pockets (RF-173),
// which reads under its parent as the first of them.
type Line = { row: AccountRow; free: boolean };

/**
 * «Lo paga <persona> · le falta $X» under a credit somebody else pays (RF-216): the one place its hidden «Me debe»
 * shows, as a figure on the credit and never as an account. Nothing for any other account.
 */
export function PaidByLine({ account }: { account: AccountRow }) {
  const t = useTranslations("accounts");
  const credit = account.thirdParty;
  if (!credit) return null;

  return (
    <Text size="2" color="gray">
      {credit.personOwesCents > 0
        ? t.rich("paidBy", {
            person: credit.personName,
            amount: () => (
              <Money
                minor={credit.personOwesCents}
                currency={account.settlementCurrency}
                tone="plain"
                size="inherit"
                signed={false}
              />
            ),
          })
        : t("paidByNothingOwed", { person: credit.personName })}
    </Text>
  );
}

/**
 * The dense Cuentas of the desktop design (RF-114): every
 * account's balance arrives already derived from `account_balances` and only
 * reads through `Money` here — no figure is computed on the client, and a
 * liability's own negative cents carries the minus through. `archived` decides
 * whether a row offers to archive or to restore it, mirroring the phone's card.
 */
export function AccountsTable({
  sections,
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
  // One band per type, each with the figure it adds up to; the caller drops the empty ones.
  sections: { key: string; label: string; aside?: ReactNode; rows: AccountRow[] }[];
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

  const ownerOf = useOwnerLabel();
  const ownerLabel = (row: AccountRow) =>
    row.foreignOwner ? ownerOf(row.ownerName) : t("ownerPersonal");

  // The free line shows the parent's own balance and nothing else, so only the name and balance cells draw it.
  const linesOf = (rows: AccountRow[]): Line[] =>
    rows.flatMap((row) =>
      row.totalBalances ? [{ row, free: false }, { row, free: true }] : [{ row, free: false }],
    );
  const bands: DataSection<Line>[] = sections.map((section) => ({
    ...section,
    rows: linesOf(section.rows),
  }));
  // Each cell of the other columns draws the account itself; the free line leaves them empty.
  const ofAccount =
    (cell: (row: AccountRow) => ReactNode) =>
    ({ row, free }: Line): ReactNode =>
      free ? null : cell(row);

  const columns: DataColumn<Line>[] = [
    {
      key: "name",
      header: t("nameLabel"),
      width: WIDTHS.name,
      cell: ({ row, free }) =>
        free ? (
          <Flex pl="5">
            <Text size="2" color="gray">
              {t("freePart")}
            </Text>
          </Flex>
        ) : (
        <Flex direction="column" gap="1" minWidth="0" pl={row.parentAccountId ? "5" : "0"}>
          <Flex align="center" gap="2" minWidth="0">
            <Text size="2" weight="medium" truncate>
              {row.thirdParty ? t("creditOf", { name: row.name, person: row.thirdParty.personName }) : row.name}
            </Text>
            {row.ownerUserId && (
              <PersonalMark label={ownerLabel(row)} />
            )}
          </Flex>
          {/* One scope, never both: a personal account names its owner, a
              group account the group (RF-60). Another member's is theirs by name. */}
          <Text size="2" color="gray">
            {row.ownerUserId
              ? ownerLabel(row)
              : row.holderName
                ? t("holderOf", { name: row.holderName })
                : t("ownerFund")}
          </Text>
          <PaidByLine account={row} />
        </Flex>
        ),
    },
    {
      key: "institution",
      header: t("institutionLabel"),
      width: WIDTHS.institution,
      cell: ofAccount((row) =>
        row.institution ? (
          <Text size="2" color="gray" truncate>
            {row.institution}
          </Text>
        ) : (
          absent()
        ),
      ),
    },
    {
      key: "lastFour",
      header: t("lastFourLabel"),
      width: WIDTHS.lastFour,
      numeric: true,
      cell: ofAccount((row) =>
        row.lastFour ? (
          <Text size="2" color="gray">
            {row.lastFour}
          </Text>
        ) : (
          absent()
        ),
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
      cell: ({ row, free }) => {
        // A parent leads with the total of itself and its pockets; its free line is its own part (RF-173).
        const [settlement, ...others] = free ? row.balances : (row.totalBalances ?? row.balances);

        return (
          <Flex direction="column" gap="1" align="end">
            {settlement && (
              <Money
                minor={settlement.balanceCents}
                currency={settlement.currency}
                tone="plain"
              />
            )}
            {!free && others.map((balance) => (
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
      // Nothing here acts on another member's personal account.
      cell: ofAccount((row) => row.foreignOwner ? null : (
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
                  ...(hasGroup && row.ownerUserId !== null && row.parentAccountId === null
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
      )),
    },
  ];

  return (
    <DataTable
      label={t("title")}
      columns={columns}
      sections={bands}
      rowKey={({ row, free }) => (free ? `${row.id}:free` : row.id)}
      empty={empty}
    />
  );
}
