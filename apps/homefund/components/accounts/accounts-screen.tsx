"use client";

import { EllipsisVertical, Plus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import {
  archiveAccountAction,
  deleteAccountAction,
  handAccountToGroupAction,
  restoreAccountAction,
} from "@/app/actions/accounts";
import { useOwnerLabel } from "@/components/fund/owner-mark";
import { AccountFormDialog } from "@/components/accounts/account-form-dialog";
import {
  BilledAmountDialog,
  ForeignEstimates,
  type BilledTarget,
} from "@/components/accounts/foreign-estimates";
import { ReconcileDialog } from "@/components/accounts/reconcile-dialog";
import { AccountsTable } from "@/components/accounts/accounts-table";
import {
  Box,
  Button,
  Card,
  ConfirmDialog,
  DropdownMenu,
  EmptyState,
  FilterBar,
  FilterSelect,
  Flex,
  IconButton,
  Money,
  PersonalMark,
  ScreenHeader,
  SegmentedControl,
  Separator,
  StatTiles,
  Text,
} from "@/components/ui";
import type { AccountRow } from "@/db/queries/accounts";
import type { AccountPendingSettlement } from "@/db/queries/debt-statements";
import { usePathname, useRouter } from "@/i18n/navigation";
import { civilDateToDate } from "@/lib/dates";
import { useActionErrorToast } from "@/lib/use-action-toast";
import type { CurrencyCode } from "@/lib/currency";
import type { ACCOUNT_SUBTYPES } from "@/lib/validation/account";

type Group = { key: string; label: string; accounts: AccountRow[] };

// A Radix Select item may not carry an empty value, so "any" rides this
// sentinel and maps back to no query param the moment it is picked.
const ANY = "all";

// The subject of a menu action, not a dialog's own field state: closing any
// of the dialogs below clears this, and reopening one always names an account.
type RowAction =
  | { kind: "archive"; account: AccountRow }
  | { kind: "restore"; account: AccountRow }
  | { kind: "delete"; account: AccountRow }
  | { kind: "handOver"; account: AccountRow };

type Figure = { currency: CurrencyCode; cents: number };

// A section's own figure per currency, never one sum across currencies (RF-124).
// Each row's `balances` is its own free part, so a pocket and its parent add up
// once; a liability's cents are already negative.
function sumByCurrency(rows: AccountRow[]): Figure[] {
  const totals = new Map<CurrencyCode, number>();
  for (const row of rows) {
    for (const balance of row.balances) {
      totals.set(balance.currency, (totals.get(balance.currency) ?? 0) + balance.balanceCents);
    }
  }
  return [...totals].map(([currency, cents]) => ({ currency, cents }));
}

function Figures({ figures, owed }: { figures: Figure[]; owed?: boolean }) {
  return (
    <Flex direction="column" gap="1" align="start">
      {figures.map(({ currency, cents }) => (
        <Money
          key={currency}
          minor={owed ? Math.abs(cents) : cents}
          currency={currency}
          tone="plain"
          size="inherit"
          signed={!owed}
        />
      ))}
    </Flex>
  );
}

export function AccountsScreen({
  accounts,
  groupName,
  pendingSettlements,
  archived,
  newSubtype,
}: {
  accounts: AccountRow[];
  groupName: string | null;
  // Foreign estimates still unbilled on the asset accounts, every account's together.
  pendingSettlements: AccountPendingSettlement[];
  archived: boolean;
  // The class a caller arrived asking to open, already validated by the page.
  newSubtype?: (typeof ACCOUNT_SUBTYPES)[number] | null;
}) {
  const t = useTranslations("accounts");
  const tKey = useTranslations();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const onActionError = useActionErrorToast();

  // The desktop table's own narrowing (RF-89): the tab already scopes the rows
  // Postgres returns, these two only narrow the array already in hand.
  const ownerFilter = searchParams.get("owner") ?? ANY;
  const institutionFilter = searchParams.get("institution") ?? ANY;

  // "new" and a row share one dialog instance; its own key resets the form. A
  // named class opens it on arrival, so the tile that asked for it lands on the
  // form rather than on the list.
  const [formTarget, setFormTarget] = useState<AccountRow | "new" | null>(
    newSubtype ? "new" : null,
  );
  const [reconcileTarget, setReconcileTarget] = useState<AccountRow | null>(null);
  const [rowAction, setRowAction] = useState<RowAction | null>(null);
  const [billedTarget, setBilledTarget] = useState<BilledTarget | null>(null);

  const archiveState = useAction(archiveAccountAction, {
    onSuccess() {
      toast.success(t("archived"));
      setRowAction(null);
    },
    onError: onActionError,
  });

  const restoreState = useAction(restoreAccountAction, {
    onSuccess() {
      toast.success(t("restored"));
      setRowAction(null);
    },
    onError: onActionError,
  });

  const deleteState = useAction(deleteAccountAction, {
    onSuccess() {
      toast.success(t("deleted"));
      setRowAction(null);
    },
    onError: onActionError,
  });

  const handOverState = useAction(handAccountToGroupAction, {
    onSuccess() {
      toast.success(t("handedOver"));
      setRowAction(null);
    },
    onError: onActionError,
  });

  // Rewrites the query string instead of holding a filter in state, so a
  // reload or a shared link lands on the same view. `new` only ever opens the
  // dialog on arrival, so it never survives a filter change.
  function patchQuery(patch: Record<string, string | null>) {
    const query = new URLSearchParams(searchParams.toString());
    query.delete("new");
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) query.delete(key);
      else query.set(key, value);
    }
    router.push(
      { pathname, query: Object.fromEntries(query) },
      { scroll: false },
    );
  }

  function onTabChange(value: string) {
    patchQuery({ tab: value === "archived" ? "archived" : null });
  }

  // The desktop table's own rows: the tab already scoped what Postgres
  // returned, these three filters only narrow the array further, in memory.
  const filteredAccounts = accounts.filter((account) => {
    if (ownerFilter !== ANY) {
      const placement = account.ownerUserId ? "personal" : "group";
      if (placement !== ownerFilter) return false;
    }
    if (institutionFilter !== ANY && account.institution !== institutionFilter) {
      return false;
    }
    return true;
  });

  // The entities present in this tab's accounts, named once each, sorted.
  const institutionOptions = Array.from(
    new Set(
      accounts
        .map((account) => account.institution)
        .filter((institution): institution is string => Boolean(institution)),
    ),
  ).sort((a, b) => a.localeCompare(b));

  // One section per type: what is held, then the cards owed. The model has no
  // loan subtype (liability admits only card), so no third section exists.
  function sectionsOf(list: AccountRow[]) {
    return [
      { key: "accounts", label: t("sectionAccounts"), rows: list.filter((a) => a.kind === "asset") },
      { key: "cards", label: t("sectionCards"), rows: list.filter((a) => a.kind === "liability") },
    ]
      .filter((section) => section.rows.length > 0)
      .map((section) => ({
        ...section,
        figures: sumByCurrency(section.rows),
        owed: section.key === "cards",
      }));
  }

  function totalsFor(list: AccountRow[]) {
    const have = sumByCurrency(list.filter((a) => a.kind === "asset"));
    const owe = sumByCurrency(list.filter((a) => a.kind === "liability"));
    const net = sumByCurrency(list);
    return (
      <StatTiles
        tiles={[
          { key: "have", label: t("kindAsset"), value: <Figures figures={have} /> },
          { key: "owe", label: t("kindLiability"), value: <Figures figures={owe} owed /> },
          { key: "net", label: t("netLabel"), value: <Figures figures={net} /> },
        ]}
      />
    );
  }

  const pendingFor = (account: AccountRow) =>
    pendingSettlements.filter((movement) => movement.accountId === account.id);
  const withPending = filteredAccounts.filter(
    (account) => pendingFor(account).length > 0,
  );

  const addButton = (
    <Button type="button" onClick={() => setFormTarget("new")}>
      <Plus size={16} />
      {t("add")}
    </Button>
  );

  // Add would create an active account, so the archived tab offers none, in
  // the header or in the empty state.
  const emptyState = archived ? (
    <EmptyState title={t("archivedEmpty")} />
  ) : (
    <EmptyState
      title={t("emptyTitle")}
      description={t("emptyDescription")}
      action={addButton}
    />
  );

  return (
    <Flex direction="column" gap="4">
      {/* The laptop's band, filters and table, and the phone's header, tabs and
          cards: exactly one set is displayed at any width. */}
      <Box display={{ initial: "none", lg: "block" }}>
        <Flex direction="column" gap="4">
          <ScreenHeader
            title={t("title")}
            meta={t("listMeta", { count: filteredAccounts.length })}
            actions={
              !archived && (
                <Button
                  type="button"
                  variant="surface"
                  color="gray"
                  onClick={() => setFormTarget("new")}
                >
                  <Plus size={15} />
                  {t("add")}
                </Button>
              )
            }
          />

          <FilterBar>
            <FilterSelect
              label={t("statusLabel")}
              value={archived ? "archived" : "active"}
              onValueChange={onTabChange}
              items={[
                { value: "active", label: t("activeTab") },
                { value: "archived", label: t("archivedTab") },
              ]}
              width={140}
            />
            <FilterSelect
              label={t("ownerLabel")}
              value={ownerFilter}
              onValueChange={(value) =>
                patchQuery({ owner: value === ANY ? null : value })
              }
              items={[
                { value: ANY, label: t("allOwners") },
                { value: "personal", label: t("ownerPersonal") },
                { value: "group", label: t("ownerFund") },
              ]}
              width={170}
            />
            <FilterSelect
              label={t("institutionLabel")}
              value={institutionFilter}
              onValueChange={(value) =>
                patchQuery({ institution: value === ANY ? null : value })
              }
              items={[
                { value: ANY, label: t("allInstitutions") },
                ...institutionOptions.map((institution) => ({
                  value: institution,
                  label: institution,
                })),
              ]}
              width={190}
            />
          </FilterBar>

          {filteredAccounts.length > 0 && totalsFor(filteredAccounts)}

          <AccountsTable
            sections={sectionsOf(filteredAccounts).map(({ figures, owed, ...section }) => ({
              ...section,
              aside: <Figures figures={figures} owed={owed} />,
            }))}
            archived={archived}
            empty={
              accounts.length === 0 ? (
                emptyState
              ) : filteredAccounts.length === 0 ? (
                <EmptyState
                  title={t("filteredEmptyTitle")}
                  description={t("filteredEmptyDescription")}
                  action={
                    <Button
                      type="button"
                      mt="2"
                      onClick={() =>
                        patchQuery({ owner: null, institution: null })
                      }
                    >
                      {t("clearFilters")}
                    </Button>
                  }
                />
              ) : undefined
            }
            hasGroup={groupName !== null}
            onEdit={(account) => setFormTarget(account)}
            onReconcile={(account) => setReconcileTarget(account)}
            onArchive={(account) => setRowAction({ kind: "archive", account })}
            onRestore={(account) => setRowAction({ kind: "restore", account })}
            onDelete={(account) => setRowAction({ kind: "delete", account })}
            onHandOver={(account) => setRowAction({ kind: "handOver", account })}
          />

          {/* The table has no room for a purchase list, so each account that has
              one gets the card's own section beneath it. */}
          {withPending.map((account) => (
            <Card key={account.id}>
              <Flex direction="column" gap="3">
                <Text weight="medium">{account.name}</Text>
                <ForeignEstimates
                  account={account}
                  pending={pendingFor(account)}
                  onConfirm={setBilledTarget}
                />
              </Flex>
            </Card>
          ))}
        </Flex>
      </Box>

      <Box display={{ initial: "block", lg: "none" }}>
        <Flex direction="column" gap="4">
          <ScreenHeader title={t("title")} actions={!archived ? addButton : undefined} />
          <SegmentedControl.Root
            value={archived ? "archived" : "active"}
            onValueChange={onTabChange}
          >
            <SegmentedControl.Item value="active">
              {t("activeTab")}
            </SegmentedControl.Item>
            <SegmentedControl.Item value="archived">
              {t("archivedTab")}
            </SegmentedControl.Item>
          </SegmentedControl.Root>

          {accounts.length === 0 ? (
            emptyState
          ) : (
            <>
              {totalsFor(accounts)}
              <Flex direction="column" gap="5">
                {sectionsOf(accounts).map((section) => (
                  <Flex key={section.key} direction="column" gap="3">
                    <Flex justify="between" align="start" gap="3">
                      <Text size="2" weight="bold" color="gray">
                        {section.label}
                      </Text>
                      <Figures figures={section.figures} owed={section.owed} />
                    </Flex>
                    <Flex direction="column" gap="2">
                      {section.rows.map((account) => (
                        // A pocket reads under its parent, set in from it (RF-173).
                        <Box key={account.id} ml={account.parentAccountId ? "5" : "0"}>
                          <AccountCard
                            account={account}
                            archived={archived}
                            pending={pendingFor(account)}
                            onConfirm={setBilledTarget}
                            onEdit={() => setFormTarget(account)}
                            onReconcile={() => setReconcileTarget(account)}
                            onArchive={() => setRowAction({ kind: "archive", account })}
                            onRestore={() => setRowAction({ kind: "restore", account })}
                            onDelete={() => setRowAction({ kind: "delete", account })}
                            // Only a personal, live account of a caller who has a
                            // group has anywhere to go (RF-60, RF-61).
                            onHandOver={
                              groupName !== null &&
                              account.ownerUserId !== null &&
                              !archived
                                ? () => setRowAction({ kind: "handOver", account })
                                : null
                            }
                          />
                        </Box>
                      ))}
                    </Flex>
                  </Flex>
                ))}
              </Flex>
            </>
          )}
        </Flex>
      </Box>

      <AccountFormDialog
        hasGroup={groupName !== null}
        open={formTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFormTarget(null);
        }}
        account={formTarget === "new" ? undefined : (formTarget ?? undefined)}
        defaultSubtype={newSubtype ?? undefined}
        parentCandidates={accounts}
      />

      {billedTarget !== null && (
        <BilledAmountDialog
          target={billedTarget}
          onClose={() => setBilledTarget(null)}
        />
      )}

      {reconcileTarget !== null && (
        <ReconcileDialog
          account={reconcileTarget}
          open
          onOpenChange={(open) => {
            if (!open) setReconcileTarget(null);
          }}
        />
      )}

      {rowAction?.kind === "archive" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRowAction(null)}
          title={t("archiveTitle")}
          description={t("archiveDescription")}
          confirmLabel={tKey("common.archive")}
          cancelLabel={tKey("common.cancel")}
          tone="neutral"
          pending={archiveState.isPending}
          onConfirm={() =>
            archiveState.execute({ accountId: rowAction.account.id })
          }
        />
      )}

      {rowAction?.kind === "restore" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRowAction(null)}
          title={t("restoreTitle")}
          description={t("restoreDescription")}
          confirmLabel={tKey("common.restore")}
          cancelLabel={tKey("common.cancel")}
          tone="neutral"
          pending={restoreState.isPending}
          onConfirm={() =>
            restoreState.execute({ accountId: rowAction.account.id })
          }
        />
      )}

      {rowAction?.kind === "handOver" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRowAction(null)}
          title={t("handOverTitle")}
          description={t("handOverDescription")}
          confirmLabel={t("handOver")}
          cancelLabel={tKey("common.cancel")}
          tone="neutral"
          pending={handOverState.isPending}
          onConfirm={() =>
            handOverState.execute({ accountId: rowAction.account.id })
          }
        />
      )}

      {rowAction?.kind === "delete" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRowAction(null)}
          title={t("deleteTitle")}
          description={t("deleteDescription")}
          confirmLabel={tKey("common.delete")}
          cancelLabel={tKey("common.cancel")}
          pending={deleteState.isPending}
          onConfirm={() =>
            deleteState.execute({ accountId: rowAction.account.id })
          }
        />
      )}
    </Flex>
  );
}

function AccountCard({
  account,
  archived,
  pending,
  onConfirm,
  onEdit,
  onReconcile,
  onArchive,
  onRestore,
  onDelete,
  onHandOver,
}: {
  account: AccountRow;
  archived: boolean;
  pending: AccountPendingSettlement[];
  onConfirm: (target: BilledTarget) => void;
  onEdit: () => void;
  onReconcile: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onHandOver: (() => void) | null;
}) {
  const t = useTranslations("accounts");
  const tKey = useTranslations();
  const format = useFormatter();

  // The query orders the settlement currency first (RF-121), so the lead figure
  // is the first entry and every other currency the account holds follows it.
  // A parent leads with the total of itself and its pockets and names its own part under it (RF-173).
  const [settlement, ...others] = account.totalBalances ?? account.balances;
  const freePart = account.totalBalances ? account.balances[0] : undefined;

  const ownerOf = useOwnerLabel();
  const ownerLabel = account.foreignOwner ? ownerOf(account.ownerName) : t("ownerPersonal");

  return (
    <Card>
      <Flex direction="column" gap="3">
      <Flex justify="between" align="start" gap="3">
        <Flex direction="column" gap="1" flexGrow="1" minWidth="0">
          <Flex align="center" gap="2" wrap="wrap">
            <Text weight="medium">{account.name}</Text>
            {account.ownerUserId && <PersonalMark label={ownerLabel} />}
          </Flex>
          {account.foreignOwner && (
            <Text size="2" color="gray">
              {ownerLabel}
            </Text>
          )}
          {account.institution && (
            <Text size="2" color="gray">
              {account.institution}
            </Text>
          )}
          {/* The settlement currency is the figure the card leads with, and each
              other currency the account holds sits under it naming itself: no
              line here is the sum of two currencies (RF-124).

              Signed: the section states the kind, but a balance below zero is
              an overdraft on an asset and what is owed on a liability (RF-114),
              and drawn as a magnitude it reads as money there is. */}
          <Flex direction="column" gap="1">
            {settlement && (
              <Flex align="center" gap="1" wrap="wrap">
                <Text size="2" color="gray">
                  {t("balanceLabel")}
                </Text>
                <Money
                  minor={settlement.balanceCents}
                  currency={settlement.currency}
                  tone="plain"
                />
              </Flex>
            )}
            {freePart && (
              <Flex align="center" gap="1" wrap="wrap">
                <Text size="2" color="gray">
                  {t("freePart")}
                </Text>
                <Money minor={freePart.balanceCents} currency={freePart.currency} tone="plain" />
              </Flex>
            )}
            {others.map((balance) => (
              <Text key={balance.currency} size="2" color="gray">
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
          <Flex align="center" gap="1" wrap="wrap">
            <Text size="2" color="gray">
              {t("openingBalanceLabel")}
            </Text>
            <Text size="2" color="gray">
              {t.rich("openingBalanceRow", {
                amount: () => (
                  <Money
                    minor={account.initialBalanceCents}
                    currency={account.settlementCurrency}
                    tone="plain"
                    size="inherit"
                    signed={false}
                  />
                ),
                date: format.dateTime(civilDateToDate(account.initialBalanceOn)),
              })}
            </Text>
          </Flex>
        </Flex>
        {/* Nothing here acts on another member's personal account. */}
        {!account.foreignOwner && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <IconButton
                type="button"
                variant="ghost"
                color="gray"
                size="3"
                aria-label={tKey("common.actionsFor", { name: account.name })}
              >
                <EllipsisVertical size={16} />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Content>
              {/* An archived account is read-only: the way back is all it offers,
                  and a mistake is corrected by restoring it first. */}
              {archived ? (
                <DropdownMenu.Item onSelect={onRestore}>
                  {tKey("common.restore")}
                </DropdownMenu.Item>
              ) : (
                <>
                  <DropdownMenu.Item onSelect={onEdit}>
                    {tKey("common.edit")}
                  </DropdownMenu.Item>
                  {account.canWrite && (
                    <DropdownMenu.Item onSelect={onReconcile}>
                      {t("reconcile")}
                    </DropdownMenu.Item>
                  )}
                  <DropdownMenu.Item onSelect={onArchive}>
                    {tKey("common.archive")}
                  </DropdownMenu.Item>
                  {onHandOver && (
                    <DropdownMenu.Item onSelect={onHandOver}>
                      {t("handOver")}
                    </DropdownMenu.Item>
                  )}
                </>
              )}
              <DropdownMenu.Item color="red" onSelect={onDelete}>
                {tKey("common.delete")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>
        )}
      </Flex>
      {pending.length > 0 && (
        <>
          <Separator size="4" />
          <ForeignEstimates
            account={account}
            pending={pending}
            onConfirm={onConfirm}
          />
        </>
      )}
      </Flex>
    </Card>
  );
}
