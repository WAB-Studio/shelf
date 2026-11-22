"use client";

import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useRef, useState } from "react";
import { toast } from "sonner";

import {
  acceptDeliveriesAction,
  acceptDeliveryAction,
  chooseDeliveryAccountsAction,
  rejectDeliveryAction,
} from "@/app/actions/ingest";
import { deleteTransactionAction } from "@/app/actions/transactions";
import { AwaitingCounterparty } from "@/components/ingest/awaiting-counterparty";
import {
  arrivedVia,
  nearLine,
  asksWhichCard,
  DeliveryCard,
  movementDefaults,
  NO_CHOICE,
  readyInput,
  withChoice,
  type DeliveryChoice,
} from "@/components/ingest/delivery-card";
import { InboxTable, type InboxTableRow } from "@/components/ingest/inbox-table";
import { RecipientFormDialog, type RecipientDraft } from "@/components/recipients/recipient-form-dialog";
import { RefusedDeliveries } from "@/components/ingest/refused-deliveries";
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
  ScreenHeader,
  Spinner,
  Text,
  TextLink,
  VisuallyHidden,
} from "@/components/ui";
import type {
  PendingDeliveryRow,
  RefusedDeliveryRow,
  SilencedShapeRow,
} from "@/db/queries/ingest-review";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import type { AwaitingCounterpartyRow } from "@/db/queries/transactions";
import { categoryNamesById } from "@/lib/fund/category-names";
import { deliveryCurrency } from "@/lib/fund/glance";
import { proposedCategoryId } from "@/lib/fund/category-scope";
import { useActionErrorToast } from "@/lib/use-action-toast";

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

// Where each thing that lands in Bandeja is set up, in Ajustes · Correos del banco and its neighbours.
const INBOX_SOURCES = [
  { key: "android", href: "/settings/webhooks#android" },
  { key: "iphone", href: "/settings/webhooks#iphone" },
  { key: "gmail", href: "/settings/webhooks#bank-emails" },
  { key: "claude", href: "/settings/webhooks#claude" },
] as const;

export function InboxScreen({
  deliveries,
  awaiting,
  shapes,
  refused,
  options,
}: {
  deliveries: PendingDeliveryRow[];
  awaiting: AwaitingCounterpartyRow[];
  shapes: SilencedShapeRow[];
  refused: RefusedDeliveryRow[];
  options: TransactionFormOptions;
}) {
  const t = useTranslations("ingest");
  const tKey = useTranslations();
  const onActionError = useActionErrorToast();

  // The row a menu targeted; both dialogs are mounted once for the whole page,
  // as the ledger does for its own edit and delete (RF-24).
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [numberDraft, setNumberDraft] = useState<RecipientDraft | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const silenceShape = useRef(false);
  // What the person set on each card (a category, whom it was for), and which ready ones they chose to record
  // together; both live here so one write carries them (RF-242).
  const [choices, setChoices] = useState<Record<string, DeliveryChoice>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const choiceOf = (id: string): DeliveryChoice => choices[id] ?? NO_CHOICE;
  const readyOf = (delivery: PendingDeliveryRow) =>
    delivery.recorded === null ? readyInput(delivery, options, choiceOf(delivery.id)) : null;
  const ready = deliveries.filter((delivery) => readyOf(delivery) !== null);
  const chosenInputs = ready.filter((delivery) => selected.has(delivery.id)).map((delivery) => readyOf(delivery)!);

  // The account a card was given outlives a reload: it is kept on the delivery, not only on the screen.
  const keepAccounts = useAction(chooseDeliveryAccountsAction, { onError: onActionError });
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
    onSuccess({ input }) {
      toast.success(
        input.reason === "duplicate"
          ? t("duplicateRejectedToast")
          : silenceShape.current
            ? t("silencedToast")
            : t("rejectedToast"),
      );
      setRejectId(null);
    },
    onError: onActionError,
  });
  // The whole batch is one write: all recorded or none, and the toast says which.
  const acceptSelected = useAction(acceptDeliveriesAction, {
    onSuccess({ data }) {
      toast.success(t("batchAcceptedToast", { count: data?.count ?? 0 }));
      setSelected(new Set());
    },
    onError(error) {
      toast.error(t("batchRefused"));
      onActionError(error);
    },
  });

  // A delivery a recorded movement already stands for goes in one tap, as a repeat, and is never silenced as a
  // shape (RF-246); any other asks first.
  function askReject(id: string) {
    if (deliveries.find((one) => one.id === id)?.recorded == null) {
      setRejectId(id);
      return;
    }
    silenceShape.current = false;
    reject.execute({ deliveryId: id, silenceShape: false, reason: "duplicate" });
  }

  function runReject(nextSilenceShape: boolean) {
    if (!rejectId) return;
    silenceShape.current = nextSilenceShape;
    reject.execute({ deliveryId: rejectId, silenceShape: nextSilenceShape });
  }

  function select(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Accepting from the table's menu never writes on its own for an incomplete
  // delivery (RF-91): with no complete input to send, the row's own "accept"
  // opens the same form "openForm" does, rather than calling the action.
  function acceptOrReview(id: string) {
    const delivery = deliveries.find((one) => one.id === id);
    const input = delivery && readyOf(delivery);
    if (input) accept.execute(input);
    else setReviewId(id);
  }

  const categoryNames = categoryNamesById(options.categories, (name) =>
    tKey("categories.scopedName", { name }),
  );
  const accountNames = new Map(options.accounts.map((a) => [a.id, a.name]));

  const tableRows: InboxTableRow[] = deliveries.map((proposal) => {
    const delivery = withChoice(proposal, choiceOf(proposal.id));
    const toAccount = options.accounts.find((account) => account.id === delivery.proposedToAccountId);

    return {
      id: delivery.id,
      createdAt: delivery.createdAt,
      occurredOn: delivery.proposedOccurredAt,
      selectable: readyOf(proposal) !== null,
      selected: selected.has(delivery.id),
      merchantLabel: delivery.merchantLabel,
      via: arrivedVia(delivery, (badge, name) => t("arrivedVia", { kind: badge, name })),
      rawText: delivery.rawText,
      near: nearLine(delivery, (key, values) => t(key, values)),
      category: categoryInfo(
        options,
        categoryNames,
        choiceOf(delivery.id).categoryId ?? proposedCategoryId(delivery, options),
      ),
      account: delivery.proposedAccountId
        ? [delivery.proposedAccountId, delivery.proposedToAccountId]
            .filter((id) => id !== null)
            .map((id) => accountNames.get(id) ?? "")
            .join(" → ")
        : null,
      askCard: asksWhichCard(delivery),
      toMissing: delivery.proposedDirection === "transfer" && delivery.proposedToAccountId === null,
      amountMinor: delivery.proposedAmountCents,
      direction: delivery.proposedDirection ?? "expense",
      withdrawal: delivery.proposedDirection === "transfer" && toAccount?.subtype === "cash",
      currency: deliveryCurrency(delivery, options),
      isComplete: readyOf(proposal) !== null || delivery.isComplete,
      recorded: delivery.recorded !== null,
      canSaveNumber: delivery.extractedIdentifier !== null && delivery.recipientId === null,
      beforeOpeningOn: delivery.beforeOpening ? delivery.proposedOccurredAt : null,
    };
  });

  const reviewing = deliveries.find((one) => one.id === reviewId) ?? null;

  // The number the message names, prefilled; the person says what it is.
  function saveNumber(delivery: PendingDeliveryRow) {
    setNumberDraft({ identifier: delivery.extractedIdentifier ?? "", kind: "person" });
  }

  const emptyState = (
    <EmptyState
      title={t("emptyTitle")}
      description={t("emptyDescription")}
      action={
        <Flex direction="column" gap="3" width="100%" maxWidth="480px">
          <Flex direction="column" gap="1" asChild>
            <ul>
              {INBOX_SOURCES.map(({ key, href }) => (
                <li key={key}>
                  <Text size="2" color="gray">
                    {t(`emptySource.${key}.label`)}{" "}
                  </Text>
                  <TextLink href={href} size="2">
                    {t(`emptySource.${key}.link`)}
                  </TextLink>
                </li>
              ))}
            </ul>
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
            <>
          {ready.length > 0 && (
            <Flex align="center" gap="3" wrap="wrap">
              {chosenInputs.length === 0 ? (
                <Button
                  type="button"
                  size="3"
                  variant="ghost"
                  color="gray"
                  onClick={() => setSelected(new Set(ready.map((delivery) => delivery.id)))}
                >
                  {t("selectReady", { count: ready.length })}
                </Button>
              ) : (
                <>
                  <Text size="2" color="gray">
                    {t("selectedCount", { count: chosenInputs.length })}
                  </Text>
                  <Button
                    type="button"
                    size="3"
                    disabled={acceptSelected.isPending}
                    onClick={() => acceptSelected.execute({ items: chosenInputs })}
                  >
                    {acceptSelected.isPending && <Spinner />}
                    {t("acceptSelected", { count: chosenInputs.length })}
                  </Button>
                  <Button type="button" size="3" variant="ghost" color="gray" onClick={() => setSelected(new Set())}>
                    {t("clearSelection")}
                  </Button>
                </>
              )}
            </Flex>
          )}
            <InboxTable
              rows={tableRows}
              onAccept={acceptOrReview}
              onReview={setReviewId}
              onReject={askReject}
              onSelectedChange={select}
              onSaveNumber={(id) => {
                const delivery = deliveries.find((one) => one.id === id);
                if (delivery) saveNumber(delivery);
              }}
            />
            </>
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
          {ready.length > 0 && (
            <Flex align="center" gap="3" wrap="wrap">
              {chosenInputs.length === 0 ? (
                <Button
                  type="button"
                  size="3"
                  variant="ghost"
                  color="gray"
                  onClick={() => setSelected(new Set(ready.map((delivery) => delivery.id)))}
                >
                  {t("selectReady", { count: ready.length })}
                </Button>
              ) : (
                <>
                  <Text size="2" color="gray">
                    {t("selectedCount", { count: chosenInputs.length })}
                  </Text>
                  <Button
                    type="button"
                    size="3"
                    disabled={acceptSelected.isPending}
                    onClick={() => acceptSelected.execute({ items: chosenInputs })}
                  >
                    {acceptSelected.isPending && <Spinner />}
                    {t("acceptSelected", { count: chosenInputs.length })}
                  </Button>
                  <Button type="button" size="3" variant="ghost" color="gray" onClick={() => setSelected(new Set())}>
                    {t("clearSelection")}
                  </Button>
                </>
              )}
            </Flex>
          )}
              {deliveries.map((delivery) => (
                <DeliveryCard
                  key={delivery.id}
                  delivery={delivery}
                  options={options}
                  choice={choiceOf(delivery.id)}
                  onChoice={(patch) => {
                    setChoices((current) => ({ ...current, [delivery.id]: { ...choiceOf(delivery.id), ...patch } }));
                    if (patch.accountId || patch.toAccountId) {
                      keepAccounts.execute({
                        deliveryId: delivery.id,
                        accountId: patch.accountId ?? undefined,
                        toAccountId: patch.toAccountId ?? undefined,
                      });
                    }
                  }}
                  selected={selected.has(delivery.id)}
                  onSelectedChange={readyOf(delivery) === null ? null : (on) => select(delivery.id, on)}
                  onSaveNumber={() => saveNumber(delivery)}
                />
              ))}
            </Flex>
          )}
        </Flex>
      </Box>

      <AwaitingCounterparty rows={awaiting} accounts={options.accounts} />

      <RefusedDeliveries rows={refused} />

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
              defaults={movementDefaults(reviewing, options, choiceOf(reviewing.id))}
              dateBeforeOpening={reviewing.beforeOpening}
              onSaved={() => toast.success(t("acceptedToast"))}
              onDone={() => setReviewId(null)}
            />
          )}
        </Dialog.Content>
      </Dialog.Root>

      <RecipientFormDialog
        draft={numberDraft}
        options={options}
        onOpenChange={(open) => !open && setNumberDraft(null)}
      />

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
