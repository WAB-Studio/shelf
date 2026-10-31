"use client";

import { ChevronLeft, ChevronRight, EllipsisVertical, Plus } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { toast } from "sonner";

import {
  archiveBudgetAction,
  deleteBudgetAction,
  restoreBudgetAction,
} from "@/app/actions/budgets";
import { BudgetFormDialog } from "@/components/planning/budget-form-dialog";
import { BudgetsTable } from "@/components/planning/budgets-table";
import type { BudgetTableRow } from "@/components/planning/budgets-table";
import { PlanningSubNav } from "@/components/planning/planning-sub-nav";
import {
  Box,
  Button,
  Card,
  CategoryTile,
  ConfirmDialog,
  DropdownMenu,
  EmptyState,
  Figure,
  Flex,
  FundChip,
  ScreenHeader,
  IconButton,
  Progress,
  SegmentedControl,
  Text,
  ToneSurface,
} from "@/components/ui";
import type { BudgetStatus } from "@/db/queries/budgets";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import { usePathname, useRouter } from "@/i18n/navigation";
import { addCivilMonths, civilDateToDate } from "@/lib/dates";
import { categoryNamesById, scopedCategoryParts } from "@/lib/fund/category-names";
import { formatMoney } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";

// The subject of a menu action, not a dialog's own field state: closing any of
// the dialogs below clears this, and reopening one always names a budget.
type RowAction =
  | { kind: "archive"; budget: BudgetStatus }
  | { kind: "restore"; budget: BudgetStatus }
  | { kind: "delete"; budget: BudgetStatus };

/**
 * The budgets area: each active budget reads as a card whose bar and status are
 * derived server-side from the split spend over the selected month's window
 * (RF-72, RF-73). The month selector rewrites `?month=` so the page re-derives
 * the whole list; a budget is created, edited, archived, restored or deleted
 * through the dialog and the confirms below (RF-120). Money stays integer cents
 * and every figure is drawn in the budget's own currency, which is what says
 * which movements the limit counts (RF-121, RF-124).
 */
export function BudgetsScreen({
  budgets,
  options,
  scopeCurrency,
  hasGroup,
  month,
  archived,
}: {
  budgets: BudgetStatus[];
  options: TransactionFormOptions;
  // What a budget naming no account derives, read by the server (RF-121): the
  // form validates a new limit against it before the action reads it back.
  scopeCurrency: string;
  hasGroup: boolean;
  month: string;
  archived: boolean;
}) {
  const t = useTranslations("budgets");
  const tKey = useTranslations();
  const format = useFormatter();
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const onActionError = useActionErrorToast();

  // "new" and a row share one dialog instance; its own key resets the form.
  const [formTarget, setFormTarget] = useState<BudgetStatus | "new" | null>(
    null,
  );
  const [rowAction, setRowAction] = useState<RowAction | null>(null);

  const archiveState = useAction(archiveBudgetAction, {
    onSuccess() {
      toast.success(t("archived"));
      setRowAction(null);
    },
    onError: onActionError,
  });

  const restoreState = useAction(restoreBudgetAction, {
    onSuccess() {
      toast.success(t("restored"));
      setRowAction(null);
    },
    onError: onActionError,
  });

  const deleteState = useAction(deleteBudgetAction, {
    onSuccess() {
      toast.success(t("deleted"));
      setRowAction(null);
    },
    onError: onActionError,
  });

  // A name and colour per category id — children included — so a card reads its
  // title and dot without a second lookup.
  const categoryNames = categoryNamesById(options.categories, (name) =>
    tKey("categories.scopedName", { name }),
  );
  const categoryColors = new Map<string, string | null>();
  // The same names with the fund mark apart, so a card truncates the name alone.
  const categoryParts = new Map<string, { name: string; suffix: string | null }>();
  const markFund = (name: string) => tKey("categories.scopedName", { name });
  for (const category of options.categories) {
    categoryColors.set(category.id, category.color);
    categoryParts.set(
      category.id,
      scopedCategoryParts(category.name, category.scope, markFund),
    );
    for (const child of category.children) {
      categoryColors.set(child.id, child.color);
      categoryParts.set(
        child.id,
        scopedCategoryParts(child.name, category.scope, markFund),
      );
    }
  }

  // The dense table reads a row already named, same as a card's own title and
  // dot; `byId` lets its handlers hand the row menu back its full BudgetStatus.
  const byId = new Map(budgets.map((budget) => [budget.id, budget]));
  const tableRows: BudgetTableRow[] = budgets.map((budget) => ({
    id: budget.id,
    title: budget.name ?? categoryNames.get(budget.categoryId) ?? "",
    color: categoryColors.get(budget.categoryId) ?? null,
    currency: budget.currency,
    spentCents: budget.spentCents,
    limitCents: budget.limitCents,
    remainingCents: budget.remainingCents,
    thresholdPct: budget.thresholdPct,
    overThreshold: budget.overThreshold,
    overspent: budget.overspent,
  }));

  function fromRow(row: BudgetTableRow): BudgetStatus {
    const budget = byId.get(row.id);
    if (!budget) throw new Error("Row named a budget the screen never listed.");
    return budget;
  }

  const anchor = `${month}-01`;
  const monthName = format.dateTime(civilDateToDate(anchor), {
    month: "long",
    year: "numeric",
  });
  // The month opens with a capital in the active language; the rest stays as written.
  const monthLabel = monthName.charAt(0).toLocaleUpperCase(locale) + monthName.slice(1);

  // The two controls write the same query, so stepping the month keeps the tab
  // and switching tab keeps the period.
  function pushQuery(nextMonth: string, nextArchived: boolean) {
    router.push(
      {
        pathname,
        query: nextArchived
          ? { month: nextMonth, tab: "archived" }
          : { month: nextMonth },
      },
      { scroll: false },
    );
  }

  function goToMonth(delta: number) {
    pushQuery(addCivilMonths(anchor, delta).slice(0, 7), archived);
  }

  const addButton = (
    <Button type="button" onClick={() => setFormTarget("new")}>
      <Plus size={16} />
      {t("add")}
    </Button>
  );

  return (
    <Flex direction="column" gap="4">
      <ScreenHeader
        title={t("title")}
        meta={hasGroup ? <FundChip label={tKey("fund.label")} /> : undefined}
        // The empty state carries its own «add», so the header's would be a second.
        actions={!archived && budgets.length > 0 ? addButton : undefined}
      />

      <Box display={{ initial: "none", md: "block" }}>
        <PlanningSubNav />
      </Box>

      {/* One left edge with the header and the table: the band they carry from `md`. */}
      <Flex direction="column" gap="4" px={{ initial: "0", md: "6" }} align={{ initial: "stretch", sm: "start" }}>
        <SegmentedControl.Root
          value={archived ? "archived" : "active"}
          onValueChange={(value) => pushQuery(month, value === "archived")}
        >
          <SegmentedControl.Item value="active">
            {t("activeTab")}
          </SegmentedControl.Item>
          <SegmentedControl.Item value="archived">
            {t("archivedTab")}
          </SegmentedControl.Item>
        </SegmentedControl.Root>

        <Flex align="center" justify="center" gap="4" width="100%">
          <IconButton
            type="button"
            variant="ghost"
            color="gray"
            size="3"
            aria-label={t("previousMonth")}
            onClick={() => goToMonth(-1)}
          >
            <ChevronLeft size={18} />
          </IconButton>
          <Text weight="bold">
            {monthLabel}
          </Text>
          <IconButton
            type="button"
            variant="ghost"
            color="gray"
            size="3"
            aria-label={t("nextMonth")}
            onClick={() => goToMonth(1)}
          >
            <ChevronRight size={18} />
          </IconButton>
        </Flex>
      </Flex>

      <Box display={{ initial: "block", lg: "none" }}>
        {budgets.length === 0 ? (
          archived ? (
            <EmptyState title={t("archivedEmpty")} />
          ) : (
            <EmptyState
              title={t("emptyTitle")}
              description={t("emptyDescription")}
              action={addButton}
            />
          )
        ) : (
          <Flex direction="column" gap="3">
            {budgets.map((budget) => (
              <BudgetCard
                key={budget.id}
                budget={budget}
                title={budget.name ?? categoryParts.get(budget.categoryId)?.name ?? ""}
                suffix={
                  budget.name ? null : (categoryParts.get(budget.categoryId)?.suffix ?? null)
                }
                color={categoryColors.get(budget.categoryId) ?? null}
                archived={archived}
                onEdit={() => setFormTarget(budget)}
                onArchive={() => setRowAction({ kind: "archive", budget })}
                onRestore={() => setRowAction({ kind: "restore", budget })}
                onDelete={() => setRowAction({ kind: "delete", budget })}
              />
            ))}
          </Flex>
        )}
      </Box>

      <Box display={{ initial: "none", lg: "block" }}>
        <BudgetsTable
          rows={tableRows}
          archived={archived}
          empty={
            archived ? (
              <EmptyState variant="filtered" title={t("archivedEmpty")} />
            ) : (
              <EmptyState
                variant="filtered"
                title={t("emptyTitle")}
                description={t("emptyDescription")}
                action={addButton}
              />
            )
          }
          onEdit={(row) => setFormTarget(fromRow(row))}
          onArchive={(row) => setRowAction({ kind: "archive", budget: fromRow(row) })}
          onRestore={(row) => setRowAction({ kind: "restore", budget: fromRow(row) })}
          onDelete={(row) => setRowAction({ kind: "delete", budget: fromRow(row) })}
        />
      </Box>

      <BudgetFormDialog
        open={formTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFormTarget(null);
        }}
        options={options}
        scopeCurrency={scopeCurrency}
        budget={formTarget === "new" ? undefined : (formTarget ?? undefined)}
      />

      {rowAction?.kind === "archive" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRowAction(null)}
          title={t("archiveTitle")}
          description={t("archiveDescription")}
          confirmLabel={tKey("common.archive")}
          cancelLabel={tKey("common.cancel")}
          pending={archiveState.isPending}
          tone="neutral"
          onConfirm={() =>
            archiveState.execute({ budgetId: rowAction.budget.id })
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
          pending={restoreState.isPending}
          tone="neutral"
          onConfirm={() =>
            restoreState.execute({ budgetId: rowAction.budget.id })
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
            deleteState.execute({ budgetId: rowAction.budget.id })
          }
        />
      )}
    </Flex>
  );
}

function BudgetCard({
  budget,
  title,
  suffix,
  color,
  archived,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
}: {
  budget: BudgetStatus;
  title: string;
  suffix: string | null;
  color: string | null;
  archived: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("budgets");
  const tKey = useTranslations();
  const locale = useLocale();

  // The bar and the percentage read the derived spend against the limit, clamped
  // so an overspend never runs the bar past its track (RF-72).
  const pct =
    budget.limitCents > 0
      ? Math.min(100, Math.round((budget.spentCents / budget.limitCents) * 100))
      : budget.spentCents > 0
        ? 100
        : 0;

  const tone = budget.overspent
    ? "red"
    : budget.overThreshold
      ? "amber"
      : "gray";

  const status = budget.overspent
    ? t("overspent", {
        amount: formatMoney(
          budget.spentCents - budget.limitCents,
          budget.currency,
          locale,
        ),
      })
    : budget.overThreshold
      ? t("nearLimit", { pct, threshold: budget.thresholdPct })
      : t("remaining", {
          amount: formatMoney(budget.remainingCents, budget.currency, locale),
          pct,
        });

  const content = (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="3">
        <CategoryTile color={color} size={16} />
        <Flex flexGrow="1" minWidth="0" align="baseline">
          <Text weight="medium" wrap="balance">
            {title}
          </Text>
          {/* Whose it is stays whole however long the name runs. */}
          {suffix && (
            <Text color="gray" wrap="nowrap">
              {suffix}
            </Text>
          )}
        </Flex>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton
              type="button"
              tap
              variant="ghost"
              color="gray"
              aria-label={tKey("common.actionsFor", { name: `${title}${suffix ?? ""}` })}
            >
              <EllipsisVertical size={16} />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content>
            {/* An archived budget is read-only: the way back is all it offers,
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
                <DropdownMenu.Item onSelect={onArchive}>
                  {tKey("common.archive")}
                </DropdownMenu.Item>
              </>
            )}
            <DropdownMenu.Item color="red" onSelect={onDelete}>
              {tKey("common.delete")}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </Flex>
      {/* The figure has the whole line: name above, amounts below, nothing cut. */}
      <Figure
        size="2"
        weight="medium"
        color={budget.overspent ? "red" : undefined}
        >
        {formatMoney(budget.spentCents, budget.currency, locale)}
        <Text color="gray" weight="regular">
          {t("ofLimit", {
            amount: formatMoney(budget.limitCents, budget.currency, locale),
          })}
        </Text>
      </Figure>
      <Progress
        value={pct}
        color={tone === "gray" ? undefined : tone}
      />
      <Flex align="baseline" justify="between" gap="2">
        <Text
          size="1"
          weight={tone === "gray" ? "regular" : "medium"}
          color={tone}
        >
          {status}
        </Text>
        {/* Which spend the limit counts: the movements booked in this one
            currency and no other (RF-124). */}
        <Text size="1" color="gray" wrap="nowrap">
          {tKey("planning.inCurrency", { currency: budget.currency })}
        </Text>
      </Flex>
    </Flex>
  );

  return budget.overspent ? (
    <ToneSurface card tone="danger">
      {content}
    </ToneSurface>
  ) : (
    <Card>{content}</Card>
  );
}
