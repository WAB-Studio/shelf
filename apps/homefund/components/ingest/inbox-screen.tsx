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
import { AwaitingCounterparty } from "@/components/ingest/awaiting-counterparty";
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
  CopyField,
  Dialog,
  EmptyState,
  Flex,
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
import type { AwaitingCounterpartyRow } from "@/db/queries/transactions";
import { todayInBogota } from "@/lib/dates";
import { categoryNamesById } from "@/lib/fund/category-names";
import { deliveryCurrency } from "@/lib/fund/glance";
import { scopeOfAccounts } from "@/lib/fund/category-scope";
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

// A proposed category of another scope than the proposed account is read as no
// category: the split trigger would refuse it, so it is neither shown nor sent,
// and the person picks one of the account's own scope (RF-140).
function proposedCategoryId(
  delivery: PendingDeliveryRow,
  options: TransactionFormOptions,
): string | null {
  const categoryId = delivery.proposedCategoryId;
  if (categoryId === null) return null;
  const category = options.categories.find(
    (one) =>
      one.id === categoryId ||
      one.children.some((child) => child.id === categoryId),
  );
  const scope = scopeOfAccounts([delivery.proposedAccountId], options.accounts);
  return category && scope !== null && category.scope !== scope
    ? null
    : categoryId;
}

// Mirrors `DeliveryCard`'s own prefill, so the desktop table opens the exact
// same form a phone would (RF-91). Kept private to this screen: the card owns
// its copy for the same reason a movement's kind is derived at each write path
// rather than shared through an import that would couple the two.
function movementDefaults(
  delivery: PendingDeliveryRow,
  options: TransactionFormOptions,
): ReviewDefaults {
  const amount =
    delivery.proposedAmountCents === null
      ? ""
      : String(centsToPesos(delivery.proposedAmountCents));
  const accountId = delivery.proposedAccountId;
  const isIncome = delivery.proposedDirection === "income";
  const categoryId = proposedCategoryId(delivery, options);

  return {
    fromAccountId: isIncome ? null : accountId,
    toAccountId: isIncome ? accountId : null,
    amount,
    occurredAt: delivery.proposedOccurredAt ?? todayInBogota(),
    description: delivery.proposedDescription,
    splits: categoryId ? [{ categoryId, amount }] : [],
  };
}

function completeInput(
  delivery: PendingDeliveryRow,
  options: TransactionFormOptions,
): AcceptDeliveryInput | null {
  if (
    !delivery.isComplete ||
    delivery.proposedAmountCents === null ||
    delivery.proposedAccountId === null ||
    proposedCategoryId(delivery, options) === null
  ) {
    return null;
  }

  return {
    deliveryId: delivery.id,
    ...movementDefaults(delivery, options),
    labelIds: [],
  };
}

function categoryInfo(
  options: TransactionFormOptions,
  names: ReadonlyMap<string, string>,
  categoryId: string | null,
): { name: string; color: string | null } | null {
  if (categoryId === null) return null;

  const name = names.get(categoryId);
  if (name === undefined) return null;

  for (const category of options.categories) {
    if (category.id === categoryId) return { name, color: category.color };
    const child = category.children.find((one) => one.id === categoryId);
    if (child) return { name, color: child.color };
  }

  return null;
}

export function InboxScreen({
  deliveries,
  awaiting,
  shapes,
  options,
  ingestUrl,
}: {
  deliveries: PendingDeliveryRow[];
  awaiting: AwaitingCounterpartyRow[];
  shapes: SilencedShapeRow[];
  options: TransactionFormOptions;
  ingestUrl: string;
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
    const input = delivery && completeInput(delivery, options);
    if (input) accept.execute(input);
    else setReviewId(id);
  }

  const categoryNames = categoryNamesById(options.categories, (name) =>
    tKey("categories.scopedName", { name }),
  );
  const accountNames = new Map(options.accounts.map((a) => [a.id, a.name]));

  const tableRows: InboxTableRow[] = deliveries.map((delivery) => ({
    id: delivery.id,
    createdAt: delivery.createdAt,
    merchantLabel: delivery.merchantLabel,
    rawText: delivery.rawText,
    category: categoryInfo(
      options,
      categoryNames,
      proposedCategoryId(delivery, options),
    ),
    account: delivery.proposedAccountId
      ? (accountNames.get(delivery.proposedAccountId) ?? null)
      : null,
    amountMinor: delivery.proposedAmountCents,
    direction: delivery.proposedDirection === "income" ? "income" : "expense",
    currency: deliveryCurrency(delivery, options),
    isComplete: delivery.isComplete,
    beforeOpeningOn: delivery.beforeOpening ? delivery.proposedOccurredAt : null,
  }));

  const reviewing = deliveries.find((one) => one.id === reviewId) ?? null;

  const emptyState = (
    <EmptyState
      title={t("emptyTitle")}
      description={t("emptyDescription")}
      action={
        <Flex direction="column" gap="3" width="100%" maxWidth="480px">
          <CopyField
            id="inbox-ingest-url"
            label={t("emptyAddressLabel")}
            value={ingestUrl}
            copyLabel={t("copy")}
            copiedLabel={t("copied")}
            failedLabel={t("copyFailed")}
          />
          <Flex direction="column" gap="1">
            {[1, 2, 3].map((step) => (
              <Text key={step} size="2" color="gray">
                {step}. {t(`emptyStep${step}` as "emptyStep1")}
              </Text>
            ))}
          </Flex>
        </Flex>
      }
    />
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
          <ScreenHeader title={t("title")} />

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

      <AwaitingCounterparty rows={awaiting} accounts={options.accounts} />

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
              defaults={movementDefaults(reviewing, options)}
              dateBeforeOpening={reviewing.beforeOpening}
              onSaved={() => toast.success(t("acceptedToast"))}
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
