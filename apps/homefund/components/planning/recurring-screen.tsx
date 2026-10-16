"use client";

import { Info, Pencil, Plus, Repeat, TriangleAlert } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { toast } from "sonner";

import {
  deleteRecurringRuleAction,
  pauseRecurringRuleAction,
  resumeRecurringRuleAction,
} from "@/app/actions/recurring-rules";
import { PlanningSubNav } from "@/components/planning/planning-sub-nav";
import { RecurringFormDialog } from "@/components/planning/recurring-form-dialog";
import { RecurringTable } from "@/components/planning/recurring-table";
import type { RecurringTableRow } from "@/components/planning/recurring-table";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  ConfirmDialog,
  EmptyState,
  Flex,
  FundChip,
  Heading,
  IconButton,
  RowMenu,
  Switch,
  Text,
} from "@/components/ui";
import type { RecurringRuleRow } from "@/db/queries/recurring-rules";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import { Link as LocaleLink, useRouter } from "@/i18n/navigation";
import { civilDateToDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";

/**
 * The recurring-rules area: every readable rule read as an "Auto" card, soonest
 * next run first (RF-29), each carrying a frequency + next-run subtitle. A rule's
 * switch pauses or resumes it in place (RF-32); a paused rule reads muted. The
 * amber banner counts the generated movements still awaiting review (RF-31) and
 * hides when none are. Money stays integer cents and every figure is drawn in
 * the settlement currency of the account the rule names (RF-121).
 */
export function RecurringScreen({
  rules,
  unreviewedCount,
  options,
  hasGroup,
}: {
  rules: RecurringRuleRow[];
  unreviewedCount: number;
  options: TransactionFormOptions;
  hasGroup: boolean;
}) {
  const t = useTranslations("recurringRules");
  const tKey = useTranslations();
  const router = useRouter();
  const onActionError = useActionErrorToast();

  // "new" and a row share one dialog instance; its own key resets the form.
  const [formTarget, setFormTarget] = useState<RecurringRuleRow | "new" | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<RecurringRuleRow | null>(
    null,
  );

  const deleteState = useAction(deleteRecurringRuleAction, {
    onSuccess() {
      toast.success(t("deleted"));
      setDeleteTarget(null);
    },
    onError: onActionError,
  });

  // A name and colour per category id — children included — and a name per
  // account id, so the dense table's cells cost no lookup of their own.
  const categoryNames = new Map<string, string>();
  const categoryColors = new Map<string, string | null>();
  for (const category of options.categories) {
    categoryNames.set(category.id, category.name);
    categoryColors.set(category.id, category.color);
    for (const child of category.children) {
      categoryNames.set(child.id, child.name);
      categoryColors.set(child.id, child.color);
    }
  }
  const accountNames = new Map(options.accounts.map((a) => [a.id, a.name]));

  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const tableRows: RecurringTableRow[] = rules.map((rule) => {
    // A destination-only rule is income, a source-only rule an expense (RF-29).
    const accountId = rule.toAccountId ?? rule.fromAccountId;
    return {
      id: rule.id,
      concept: rule.description ?? t("noConcept"),
      frequency: rule.frequency,
      intervalN: rule.intervalN,
      nextRunOn: rule.nextRunOn,
      category: {
        name: categoryNames.get(rule.categoryId) ?? "",
        color: categoryColors.get(rule.categoryId) ?? null,
      },
      account: (accountId && accountNames.get(accountId)) ?? "",
      isActive: rule.isActive,
      amountCents: rule.amountCents,
      currency: rule.currency,
      isIncome: rule.toAccountId !== null,
    };
  });

  function fromRow(row: RecurringTableRow): RecurringRuleRow {
    const rule = byId.get(row.id);
    if (!rule) throw new Error("Row named a rule the screen never listed.");
    return rule;
  }

  const addButton = (
    <Button type="button" onClick={() => setFormTarget("new")}>
      <Plus size={16} />
      {t("add")}
    </Button>
  );

  return (
    <Flex direction="column" gap="4">
      <Flex justify="between" align="center" gap="3" wrap="wrap">
        <Flex align="center" gap="2">
          <Heading size="5">{t("title")}</Heading>
          {hasGroup && <FundChip label={tKey("fund.label")} />}
        </Flex>
        {addButton}
      </Flex>

      <Box display={{ initial: "none", md: "block" }}>
        <PlanningSubNav />
      </Box>

      {/* Generated movements land marked automatic until confirmed (RF-31); the
          banner leads to the ledger to review them, and stays hidden at zero. */}
      {unreviewedCount > 0 && (
        <LocaleLink href="/movements?unreviewed=1" style={{ textDecoration: "none" }}>
          <Callout.Root color="amber" variant="soft">
            <Callout.Icon>
              <TriangleAlert size={16} aria-hidden />
            </Callout.Icon>
            <Callout.Text>
              {t("unreviewedBanner", { count: unreviewedCount })}
            </Callout.Text>
          </Callout.Root>
        </LocaleLink>
      )}

      <Box display={{ initial: "block", lg: "none" }}>
        {rules.length === 0 ? (
          <EmptyState
            title={t("emptyTitle")}
            description={t("emptyDescription")}
            action={addButton}
          />
        ) : (
          <Flex direction="column" gap="3">
            {rules.map((rule) => (
              <RuleCard
                key={rule.id}
                rule={rule}
                onEdit={() => setFormTarget(rule)}
                onViewGenerated={() => router.push(`/movements?rule=${rule.id}`)}
              />
            ))}
          </Flex>
        )}
      </Box>

      <Box display={{ initial: "none", lg: "block" }}>
        <RecurringTable
          rows={tableRows}
          empty={
            <EmptyState
              variant="filtered"
              title={t("emptyTitle")}
              description={t("emptyDescription")}
              action={addButton}
            />
          }
          onEdit={(row) => setFormTarget(fromRow(row))}
          onViewGenerated={(row) => router.push(`/movements?rule=${row.id}`)}
          onDelete={(row) => setDeleteTarget(fromRow(row))}
        />
      </Box>

      <Callout.Root color="jade" variant="soft">
        <Callout.Icon>
          <Info size={16} aria-hidden />
        </Callout.Icon>
        <Callout.Text>{t("autoHint")}</Callout.Text>
      </Callout.Root>

      <RecurringFormDialog
        open={formTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFormTarget(null);
        }}
        options={options}
        rule={formTarget === "new" ? undefined : (formTarget ?? undefined)}
      />

      {deleteTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title={t("deleteTitle")}
          description={t("deleteDescription")}
          confirmLabel={tKey("common.delete")}
          cancelLabel={tKey("common.cancel")}
          pending={deleteState.isPending}
          onConfirm={() => deleteState.execute({ id: deleteTarget.id })}
        />
      )}
    </Flex>
  );
}

function RuleCard({
  rule,
  onEdit,
  onViewGenerated,
}: {
  rule: RecurringRuleRow;
  onEdit: () => void;
  onViewGenerated: () => void;
}) {
  const t = useTranslations("recurringRules");
  const tKey = useTranslations();
  const format = useFormatter();
  const locale = useLocale();
  const onActionError = useActionErrorToast();

  // Two hooks, not one behind a ternary: rules of hooks forbid picking which one
  // to call, and pausing and resuming report their own toast.
  const pause = useAction(pauseRecurringRuleAction, {
    onSuccess() {
      toast.success(t("pausedToast"));
    },
    onError: onActionError,
  });
  const resume = useAction(resumeRecurringRuleAction, {
    onSuccess() {
      toast.success(t("resumedToast"));
    },
    onError: onActionError,
  });
  const isPending = pause.isPending || resume.isPending;

  function onToggle(active: boolean) {
    if (active) resume.execute({ id: rule.id });
    else pause.execute({ id: rule.id });
  }

  const nextLabel = format.dateTime(civilDateToDate(rule.nextRunOn), {
    day: "numeric",
    month: "short",
  });
  // "cada N" only surfaces when the interval spans more than one period.
  const subtitle =
    rule.intervalN > 1
      ? t(`subtitleEvery.${rule.frequency}`, {
          n: rule.intervalN,
          date: nextLabel,
        })
      : t(`subtitle.${rule.frequency}`, { date: nextLabel });

  // A destination-only rule is income, a source-only rule an expense (RF-29).
  const isIncome = rule.toAccountId !== null;

  return (
    <Card>
      <Flex
        align="center"
        gap="3"
        style={{ opacity: rule.isActive ? 1 : 0.55 }}
      >
        <Flex
          align="center"
          justify="center"
          flexShrink="0"
          style={{
            width: 40,
            height: 40,
            borderRadius: 999,
            background: "var(--accent-a3)",
            color: "var(--accent-11)",
          }}
        >
          <Repeat size={19} />
        </Flex>
        <Flex direction="column" gap="1" flexGrow="1" minWidth="0">
          <Flex align="center" gap="2">
            <Text size="3" weight="medium" truncate>
              {rule.description ?? t("noConcept")}
            </Text>
            <Badge color="jade" variant="soft" radius="full">
              {t("autoBadge")}
            </Badge>
          </Flex>
          <Text size="2" color="gray" truncate>
            {subtitle}
          </Text>
        </Flex>
        <Text
          size="3"
          weight="medium"
          color={isIncome ? "grass" : undefined}
          style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}
        >
          {formatMoney(rule.amountCents, rule.currency, locale)}
        </Text>
      </Flex>
      <Flex align="center" justify="end" gap="3" mt="3">
        <Flex align="center" gap="2">
          <Switch
            checked={rule.isActive}
            onCheckedChange={onToggle}
            disabled={isPending}
            aria-label={t("activeToggle")}
          />
          <Text size="2" color="gray">
            {rule.isActive ? t("stateActive") : t("statePaused")}
          </Text>
        </Flex>
        <IconButton
          type="button"
          tap
          variant="ghost"
          color="gray"
          onClick={onEdit}
          aria-label={tKey("common.edit")}
        >
          <Pencil size={16} />
        </IconButton>
        <RowMenu
          rowName={rule.description ?? t("noConcept")}
          items={[
            {
              key: "viewGenerated",
              label: t("rowViewGenerated"),
              onSelect: onViewGenerated,
            },
          ]}
        />
      </Flex>
    </Card>
  );
}
