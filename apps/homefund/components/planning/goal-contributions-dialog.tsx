"use client";

import { Trash2 } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect } from "react";
import { toast } from "sonner";

import {
  listGoalContributionsAction,
  removeGoalContributionAction,
} from "@/app/actions/savings-goals";
import {
  Dialog,
  Flex,
  IconButton,
  Link,
  Money,
  Separator,
  Spinner,
  Text,
} from "@/components/ui";
import type {
  GoalContributionRow,
  GoalProgress,
} from "@/db/queries/savings-goals";
import { Link as LocaleLink } from "@/i18n/navigation";
import { civilDateToDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";

/**
 * The undo list of RF-119: every aporte the goal derives its apartado from, newest
 * first, and a person removes the one they mean — never "the last one" on their
 * behalf. Removing re-reads the list and refreshes the screen behind it, so the
 * bar and the apartado re-derive from what remains (RF-87, RNF-07).
 */
export function GoalContributionsDialog({
  open,
  onOpenChange,
  goal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goal?: GoalProgress;
}) {
  const t = useTranslations("goals");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>
          {t("contributionsTitle", { name: goal?.name ?? "" })}
        </Dialog.Title>
        {/* Remounts per goal, so the list is always read for the one that opened it. */}
        {goal && <ContributionList key={goal.id} goal={goal} />}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ContributionList({ goal }: { goal: GoalProgress }) {
  const t = useTranslations("goals");
  const format = useFormatter();
  const locale = useLocale();
  const onActionError = useActionErrorToast();

  const list = useAction(listGoalContributionsAction, { onError: onActionError });
  const { execute: load } = list;

  useEffect(() => {
    load({ goalId: goal.id });
  }, [load, goal.id]);

  // The action refreshes the page behind the dialog; this re-reads the list the
  // dialog is still showing, so both sides agree on what is left.
  const remove = useAction(removeGoalContributionAction, {
    onSuccess() {
      toast.success(t("contributionRemoved"));
      load({ goalId: goal.id });
    },
    onError: onActionError,
  });

  const rows = list.result.data;

  if (!rows) {
    return (
      <Flex justify="center" py="4">
        <Spinner />
      </Flex>
    );
  }

  if (rows.length === 0) {
    return (
      <Text size="2" color="gray">
        {t("contributionsEmpty")}
      </Text>
    );
  }

  return (
    <Flex direction="column" gap="2" mt="3">
      {rows.map((row, index) => (
        <Flex key={row.id} direction="column" gap="2">
          {index > 0 && <Separator size="4" />}
          <ContributionEntry
            row={row}
            // An aporte earmarking a movement is in that movement's currency; a
            // virtual one is set aside in the goal's own (RF-121).
            currency={row.currency ?? goal.currency}
            amount={formatMoney(
              row.amountCents,
              row.currency ?? goal.currency,
              locale,
            )}
            date={format.dateTime(civilDateToDate(row.occurredAt), {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
            pending={remove.isPending}
            onRemove={() => remove.execute({ contributionId: row.id })}
          />
        </Flex>
      ))}
    </Flex>
  );
}

function ContributionEntry({
  row,
  currency,
  amount,
  date,
  pending,
  onRemove,
}: {
  row: GoalContributionRow;
  currency: string;
  amount: string;
  date: string;
  pending: boolean;
  onRemove: () => void;
}) {
  const t = useTranslations("goals");

  return (
    <Flex align="center" gap="3">
      <Flex direction="column" minWidth="0" flexGrow="1">
        <Text size="2" weight="medium">
          <Money
            minor={row.amountCents}
            currency={currency}
            size="inherit"
            signed={false}
          />
        </Text>
        <Text size="1" color="gray" truncate>
          {date}
          {" · "}
          {row.transactionId ? (
            // The movement the aporte earmarks, reachable from here (RF-87).
            <Link asChild size="1">
              <LocaleLink href={`/movements/${row.transactionId}`}>
                {row.description || t("contributionMovement")}
              </LocaleLink>
            </Link>
          ) : (
            t("contributionVirtual")
          )}
        </Text>
      </Flex>
      <IconButton
        type="button"
        variant="ghost"
        color="gray"
        aria-label={t("removeContribution", { amount, date })}
        disabled={pending}
        onClick={onRemove}
      >
        <Trash2 size={16} />
      </IconButton>
    </Flex>
  );
}
