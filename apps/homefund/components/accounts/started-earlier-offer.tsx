"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect } from "react";
import { toast } from "sonner";

import { findLaterOpeningAction, moveOpeningEarlierAction } from "@/app/actions/accounts";
import { Button, Callout, Flex, Spinner, Text } from "@/components/ui";
import { civilDateToDate } from "@/lib/dates";
import { useActionErrorToast } from "@/lib/use-action-toast";

/**
 * «Esta deuda empieza el 1 oct. ¿Empezó antes?» (RF-303): the answer to a movement dated before the account's
 * opening, in place. It asks which account refused the day, says when that account begins and offers to begin it on
 * the movement's day with one tap; `onMoved` then saves the movement again. Nothing shows while it looks, when the
 * caller cannot change the account, or once the opening is no later than the day.
 */
export function StartedEarlierOffer({
  accountIds,
  occurredAt,
  onMoved,
}: {
  // The accounts the movement names, the one most likely to be the debt first.
  accountIds: string[];
  occurredAt: string;
  onMoved: () => void;
}) {
  const t = useTranslations("startedEarlier");
  const format = useFormatter();
  const onActionError = useActionErrorToast();
  const day = (date: string) => format.dateTime(civilDateToDate(date), { day: "numeric", month: "short", year: "numeric" });

  const find = useAction(findLaterOpeningAction);
  const { execute } = find;
  const key = accountIds.join(",");
  useEffect(() => {
    execute({ accountIds: key.split(","), occurredAt });
  }, [execute, key, occurredAt]);

  const move = useAction(moveOpeningEarlierAction, {
    onSuccess() {
      toast.success(t("moved", { date: day(occurredAt) }));
      onMoved();
    },
    onError: onActionError,
  });

  const later = find.result.data;
  if (find.isPending) {
    return (
      <Flex align="center" gap="2" role="status">
        <Spinner />
        <Text size="2" color="gray">
          {t("looking")}
        </Text>
      </Flex>
    );
  }
  if (!later) return null;

  return (
    <Callout.Root color="amber" variant="soft" role="status">
      <Flex direction="column" gap="2" align="start">
        <Callout.Text>
          {t(later.kind === "liability" ? "titleDebt" : "titleAccount", { name: later.name, opened: day(later.openedOn) })}
        </Callout.Text>
        <Button type="button" variant="soft" disabled={move.isPending} onClick={() => move.execute({ accountId: later.accountId, occurredAt })}>
          {move.isPending && <Spinner />}
          {t("change", { date: day(occurredAt) })}
        </Button>
      </Flex>
    </Callout.Root>
  );
}
