"use client";

import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useRef, useState } from "react";
import { toast } from "sonner";

import {
  acceptDeliveryAction,
  rejectDeliveryAction,
} from "@/app/actions/ingest";
import { deleteTransactionAction } from "@/app/actions/transactions";
import { DeliveryCard } from "@/components/ingest/delivery-card";
import { InboxTable, type InboxTableRow } from "@/components/ingest/inbox-table";
import { SilencedShapes } from "@/components/ingest/silenced-shapes";
import {
  MovementForm,
  movementFormDialogWidth,
} from "@/components/transactions/movement-form";
import {
  Box,
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Flex,
  Heading,
  ScreenHeader,
  Spinner,
  Text,
  VisuallyHidden,
} from "@/components/ui";
import type {
  PendingDeliveryRow,
  SilencedShapeRow,
} from "@/db/queries/ingest-review";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import { todayInBogota } from "@/lib/dates";
import { centsToPesos } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import type { AcceptDeliveryInput } from "@/lib/validation/ingest";

type ReviewDefaults = {
  fromAccountId: string | null;
  toAccountId: string | null;
  amount: string;
  occurredAt: string;
  description: string | null;
  splits: { categoryId: string; amount: string }[];
};

// Mirrors `DeliveryCard`'s own prefill, so the desktop table opens the exact
// same form a phone would (RF-91). Kept private to this screen: the card owns
// its copy for the same reason a movement's kind is derived at each write path
// rather than shared through an import that would couple the two.
function movementDefaults(delivery: PendingDeliveryRow): ReviewDefaults {
  const amount =
    delivery.proposedAmountCents === null
      ? ""
      : String(centsToPesos(delivery.proposedAmountCents));
  const accountId = delivery.proposedAccountId;
  const isIncome = delivery.proposedDirection === "income";

  return {
    fromAccountId: isIncome ? null : accountId,
    toAccountId: isIncome ? accountId : null,
    amount,
    occurredAt: delivery.proposedOccurredAt ?? todayInBogota(),
    description: delivery.proposedDescription,
    splits: delivery.proposedCategoryId
      ? [{ categoryId: delivery.proposedCategoryId, amount }]
      : [],
  };
}

function completeInput(
  delivery: PendingDeliveryRow,
): AcceptDeliveryInput | null {
  if (
    !delivery.isComplete ||
    delivery.proposedAmountCents === null ||
    delivery.proposedAccountId === null ||
    delivery.proposedCategoryId === null
  ) {
    return null;
  }

  return {
    deliveryId: delivery.id,
    ...movementDefaults(delivery),
    labelIds: [],
  };
}

function categoryInfo(
  options: TransactionFormOptions,
  categoryId: string | null,
): { name: string; color: string | null } | null {
  if (categoryId === null) return null;

  for (const category of options.categories) {
    if (category.id === categoryId) {
      return { name: category.name, color: category.color };
    }
    const child = category.children.find((one) => one.id === categoryId);
    if (child) return { name: child.name, color: child.color };
  }

  return null;
}

export function InboxScreen({
  deliveries,
  shapes,
  options,
}: {
  deliveries: PendingDeliveryRow[];
  shapes: SilencedShapeRow[];
  options: TransactionFormOptions;
}) {
  const t = useTranslations("ingest");
  const tKey = useTranslations();
  const onActionError = useActionErrorToast();

  // The row a menu targeted; both dialogs are mounted once for the whole page,
  // as the ledger does for its own edit and delete (RF-24).
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const silenceShape = useRef(false);

  const remove = useAction(deleteTransactionAction, { onError: onActionError });
  const accept = useAction(acceptDeliveryAction, {
    onSuccess({ data }) {
      const transactionId = data?.transactionId;
      toast.success(t("acceptedToast"), {
        action: transactionId
          ? {
              label: t("undo"),
              onClick: () => remove.execute({ transactionId }),
            }
          : undefined,
      });
    },
    onError: onActionError,
  });
  const reject = useAction(rejectDeliveryAction, {
    onSuccess() {
      toast.success(
        silenceShape.current ? t("silencedToast") : t("rejectedToast"),
      );
      setRejectId(null);
    },
    onError: onActionError,
  });

  function runReject(nextSilenceShape: boolean) {
    if (!rejectId) return;
    silenceShape.current = nextSilenceShape;
    reject.execute({ deliveryId: rejectId, silenceShape: nextSilenceShape });
  }

  // Accepting from the table's menu never writes on its own for an incomplete
  // delivery (RF-91): with no complete input to send, the row's own "accept"
  // opens the same form "openForm" does, rather than calling the action.
  function acceptOrReview(id: string) {
    const delivery = deliveries.find((one) => one.id === id);
    const input = delivery && completeInput(delivery);
    if (input) accept.execute(input);
    else setReviewId(id);
  }

  const accountNames = new Map(options.accounts.map((a) => [a.id, a.name]));
  const settlementByAccount = new Map(
    options.accounts.map((a) => [a.id, a.settlementCurrency]),
  );

  const tableRows: InboxTableRow[] = deliveries.map((delivery) => ({
    id: delivery.id,
    createdAt: delivery.createdAt,
    merchantLabel: delivery.merchantLabel,
    rawText: delivery.rawText,
    category: categoryInfo(options, delivery.proposedCategoryId),
    account: delivery.proposedAccountId
      ? (accountNames.get(delivery.proposedAccountId) ?? null)
      : null,
    amountMinor: delivery.proposedAmountCents,
    // An account names its own currency; a proposal with none yet falls back
    // to the fund's, never to pesos (RF-121, RF-124).
    currency: delivery.proposedAccountId
      ? (settlementByAccount.get(delivery.proposedAccountId) ??
        options.scopeCurrency)
      : options.scopeCurrency,
    isComplete: delivery.isComplete,
  }));

  const reviewing = deliveries.find((one) => one.id === reviewId) ?? null;

  const emptyState = (
    <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
  );

  return (
    <Flex direction="column" gap="4">
      {/* The laptop's band and table, and the phone's own heading and delivery
          cards: exactly one set is displayed at any width. */}
      <Box display={{ initial: "none", lg: "block" }}>
        <Flex direction="column" gap="4">
          <ScreenHeader title={t("title")} />
          {deliveries.length === 0 ? (
            emptyState
          ) : (
            <InboxTable
              rows={tableRows}
              onAccept={acceptOrReview}
              onReview={setReviewId}
              onReject={setRejectId}
            />
          )}
        </Flex>
      </Box>

      <Box display={{ initial: "block", lg: "none" }}>
        <Flex direction="column" gap="4">
          <Heading size="5">{t("title")}</Heading>

          {deliveries.length === 0 ? (
            emptyState
          ) : (
            <Flex direction="column" gap="3">
              {deliveries.map((delivery) => (
                <DeliveryCard
                  key={delivery.id}
                  delivery={delivery}
                  options={options}
                />
              ))}
            </Flex>
          )}
        </Flex>
      </Box>

      <SilencedShapes shapes={shapes} />

      <Dialog.Root
        open={reviewing !== null}
        onOpenChange={(open) => !open && setReviewId(null)}
      >
        <Dialog.Content maxWidth={movementFormDialogWidth}>
          <VisuallyHidden>
            <Dialog.Title>{t("review")}</Dialog.Title>
          </VisuallyHidden>
          {reviewing && (
            <MovementForm
              mode="create"
              options={options}
              deliveryId={reviewing.id}
              defaults={movementDefaults(reviewing)}
              onDone={() => setReviewId(null)}
            />
          )}
        </Dialog.Content>
      </Dialog.Root>

      <ConfirmDialog
        open={rejectId !== null}
        onOpenChange={(open) => !open && setRejectId(null)}
        title={t("rejectTitle")}
        description={
          <Flex direction="column" gap="3">
            <Text>{t("rejectDescription")}</Text>
            <Button
              type="button"
              color="red"
              variant="soft"
              disabled={reject.isPending}
              onClick={() => runReject(true)}
            >
              {reject.isPending && <Spinner />}
              {t("rejectAndSilence")}
            </Button>
          </Flex>
        }
        confirmLabel={t("rejectOnce")}
        cancelLabel={tKey("common.cancel")}
        pending={reject.isPending}
        tone="danger"
        onConfirm={() => runReject(false)}
      />
    </Flex>
  );
}
