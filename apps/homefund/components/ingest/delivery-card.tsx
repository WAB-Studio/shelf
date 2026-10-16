"use client";

import { EllipsisVertical } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useRef, useState } from "react";
import { toast } from "sonner";

import {
  acceptDeliveryAction,
  forgetMerchantAction,
  rejectDeliveryAction,
} from "@/app/actions/ingest";
import { deleteTransactionAction } from "@/app/actions/transactions";
import {
  MovementForm,
  movementFormDialogWidth,
} from "@/components/transactions/movement-form";
import {
  Badge,
  Box,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  Flex,
  Heading,
  IconButton,
  Spinner,
  Text,
  VisuallyHidden,
} from "@/components/ui";
import type { PendingDeliveryRow } from "@/db/queries/ingest-review";
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

function categoryName(
  options: TransactionFormOptions,
  categoryId: string | null,
): string | null {
  if (categoryId === null) return null;

  for (const category of options.categories) {
    if (category.id === categoryId) return category.name;
    const child = category.children.find((one) => one.id === categoryId);
    if (child) return child.name;
  }

  return null;
}

export function DeliveryCard({
  delivery,
  options,
}: {
  delivery: PendingDeliveryRow;
  options: TransactionFormOptions;
}) {
  const t = useTranslations("ingest");
  const tKey = useTranslations();
  const format = useFormatter();
  const onActionError = useActionErrorToast();

  const [rawTextOpen, setRawTextOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);
  const silenceShape = useRef(false);

  const remove = useAction(deleteTransactionAction, {
    onError: onActionError,
  });
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
      setRejectOpen(false);
    },
    onError: onActionError,
  });
  const forget = useAction(forgetMerchantAction, {
    onSuccess() {
      toast.success(t("forgetMerchantDone"));
      setForgetOpen(false);
    },
    onError: onActionError,
  });

  const input = completeInput(delivery);
  const defaults = movementDefaults(delivery);
  const account =
    options.accounts.find((one) => one.id === delivery.proposedAccountId)
      ?.name ?? null;
  const category = categoryName(options, delivery.proposedCategoryId);
  const receivedOn = format.dateTime(delivery.createdAt, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  function runReject(nextSilenceShape: boolean) {
    silenceShape.current = nextSilenceShape;
    reject.execute({
      deliveryId: delivery.id,
      silenceShape: nextSilenceShape,
    });
  }

  return (
    <Card>
      <Flex direction="column" gap="4">
        <Flex justify="between" align="start" gap="3">
          <Flex direction="column" gap="1" minWidth="0">
            <Heading as="h2" size="3">
              {delivery.merchantLabel ?? t("noMerchant")}
            </Heading>
            <Text size="2" color="gray">
              {t("receivedOn", { date: receivedOn })}
            </Text>
          </Flex>

          <Box flexShrink="0">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>
                <IconButton
                  type="button"
                  variant="ghost"
                  color="gray"
                  size="3"
                  aria-label={tKey("common.actionsFor", {
                    name: delivery.merchantLabel ?? t("noMerchant"),
                  })}
                >
                  <EllipsisVertical size={16} />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Content>
                <DropdownMenu.Item
                  color="red"
                  onSelect={() => setRejectOpen(true)}
                >
                  {t("reject")}
                </DropdownMenu.Item>
                {delivery.merchantId && (
                  <>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item onSelect={() => setForgetOpen(true)}>
                      {t("forgetMerchant")}
                    </DropdownMenu.Item>
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Root>
          </Box>
        </Flex>

        {delivery.proposedAmountCents === null ? (
          <Heading as="h3" size="6" color="amber">
            {t("amountMissing")}
          </Heading>
        ) : (
          <Heading as="h3" size="6">
            {format.number(
              centsToPesos(delivery.proposedAmountCents),
              "currency",
            )}
          </Heading>
        )}

        <Flex direction="column" gap="2">
          <Text color={account ? undefined : "amber"}>
            {account ?? t("accountMissing")}
          </Text>
          <Text color={category ? undefined : "amber"}>
            {category ?? t("categoryMissing")}
          </Text>
          <Flex gap="2" wrap="wrap">
            {delivery.categorySource && (
              <Badge color="gray">
                {t(
                  delivery.categorySource === "merchant"
                    ? "categoryFromMerchant"
                    : delivery.categorySource === "interpreter"
                      ? "categoryFromText"
                      : "categoryFromDefault",
                )}
              </Badge>
            )}
            {delivery.merchantState && (
              <Badge
                color={
                  delivery.merchantState === "trusted"
                    ? "green"
                    : delivery.merchantState === "ambiguous"
                      ? "amber"
                      : "gray"
                }
              >
                {t(
                  delivery.merchantState === "trusted"
                    ? "merchantTrusted"
                    : delivery.merchantState === "ambiguous"
                      ? "merchantAmbiguous"
                      : "merchantLearning",
                )}
              </Badge>
            )}
          </Flex>
          {delivery.merchantState === "ambiguous" && (
            <Text size="2" color="amber">
              {t("merchantAmbiguousHint")}
            </Text>
          )}
        </Flex>

        <Flex direction="column" align="start" gap="2">
          <Button
            type="button"
            size="3"
            variant="ghost"
            color="gray"
            aria-expanded={rawTextOpen}
            onClick={() => setRawTextOpen((open) => !open)}
          >
            {rawTextOpen ? t("hideRawText") : t("showRawText")}
          </Button>
          {rawTextOpen && (
            <Flex direction="column" gap="1">
              <Text size="2" weight="medium">
                {t("rawTextLabel")}
              </Text>
              <Text
                size="2"
                color="gray"
                style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
              >
                {delivery.rawText}
              </Text>
            </Flex>
          )}
        </Flex>

        {input ? (
          <Button
            type="button"
            size="3"
            disabled={accept.isPending}
            onClick={() => accept.execute(input)}
          >
            {accept.isPending && <Spinner />}
            {t("accept")}
          </Button>
        ) : (
          <Button type="button" size="3" onClick={() => setReviewOpen(true)}>
            {t("review")}
          </Button>
        )}
      </Flex>

      <Dialog.Root open={reviewOpen} onOpenChange={setReviewOpen}>
        <Dialog.Content maxWidth={movementFormDialogWidth}>
          <VisuallyHidden>
            <Dialog.Title>{t("review")}</Dialog.Title>
          </VisuallyHidden>
          {reviewOpen && (
            <MovementForm
              mode="create"
              options={options}
              deliveryId={delivery.id}
              defaults={defaults}
              onDone={() => setReviewOpen(false)}
            />
          )}
        </Dialog.Content>
      </Dialog.Root>

      <ConfirmDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
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

      {delivery.merchantId && (
        <ConfirmDialog
          open={forgetOpen}
          onOpenChange={setForgetOpen}
          title={t("forgetMerchantTitle")}
          description={t("forgetMerchantDescription")}
          confirmLabel={t("forgetMerchant")}
          cancelLabel={tKey("common.cancel")}
          pending={forget.isPending}
          tone="danger"
          onConfirm={() => forget.execute({ merchantId: delivery.merchantId! })}
        />
      )}
    </Card>
  );
}
