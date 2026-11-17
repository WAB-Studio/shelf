"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { useOwnerLabel } from "@/components/fund/owner-mark";
import {
  DataTable,
  Flex,
  Money,
  RowMenu,
  Text,
  type DataColumn,
} from "@/components/ui";
import type { AccountRow } from "@/db/queries/accounts";
import { holdsMoneyApartFromPockets, nameCarriesHolder } from "@/lib/account-detail";

// The tracks of the Cuentas artboard, in order.
const WIDTHS = {
  name: "minmax(0, 1fr)",
  balance: "168px",
  menu: "36px",
} as const;

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
 * The one gray line under an account's name, with what it has and nothing else (RF-240): its entity, the end of its
 * number, its holder when the name does not already say it, and the owner of another member's account. Nothing
 * for an account with none of them.
 */
export function AccountDetail({ account }: { account: AccountRow }) {
  const t = useTranslations("accounts");
  const ownerOf = useOwnerLabel();
  const parts = [
    account.institution,
    account.lastFour ? t("lastFourDetail", { digits: account.lastFour }) : null,
    account.holderName && !nameCarriesHolder(account.name, account.holderName)
      ? t("holderOf", { name: account.holderName })
      : null,
    account.foreignOwner ? ownerOf(account.ownerName) : null,
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;

  return (
    <Text size="2" color="gray" truncate>
      {parts.join(" · ")}
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

  const columns: DataColumn<AccountRow>[] = [
    {
      key: "name",
      header: t("nameLabel"),
      width: WIDTHS.name,
      cell: (row) => (
        <Flex direction="column" gap="1" minWidth="0" pl={row.parentAccountId ? "5" : "0"}>
          <Text size="2" weight="medium" truncate>
            {row.thirdParty ? t("creditOf", { name: row.name, person: row.thirdParty.personName }) : row.name}
          </Text>
          <AccountDetail account={row} />
          <PaidByLine account={row} />
        </Flex>
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
        // A parent leads with the total of itself and its pockets and names its own part under it only when
        // that part is not the whole (RF-173, RF-240).
        const [settlement, ...others] = row.totalBalances ?? row.balances;
        const free = holdsMoneyApartFromPockets(row.balances, row.totalBalances) ? row.balances[0] : undefined;

        return (
          <Flex direction="column" gap="1" align="end">
            {settlement && (
              <Money
                minor={settlement.balanceCents}
                currency={settlement.currency}
                tone="plain"
              />
            )}
            {free && (
              <Text size="1" color="gray">
                {t.rich("freeOfTotal", {
                  amount: () => (
                    <Money minor={free.balanceCents} currency={free.currency} tone="plain" size="inherit" />
                  ),
                })}
              </Text>
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
      // Nothing here acts on another member's personal account.
      cell: (row) => row.foreignOwner ? null : (
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
      ),
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
