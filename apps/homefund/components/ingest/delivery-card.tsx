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
  Checkbox,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  Flex,
  Heading,
  IconButton,
  Money,
  RawText,
  Select,
  Spinner,
  StackedSegmentedControl,
  Text,
  TextLink,
  VisuallyHidden,
} from "@/components/ui";
import type { PendingDeliveryRow } from "@/db/queries/ingest-review";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import { civilDateToDate, todayInBogota } from "@/lib/dates";
import { categoryNamesById, scopedCategoryName } from "@/lib/fund/category-names";
import { deliveryCurrency } from "@/lib/fund/glance";
import { proposedCategoryId, scopeOfAccounts } from "@/lib/fund/category-scope";
import { categoryFromHistory } from "@/lib/ingest/learned-category";
import { centsToDecimal } from "@/lib/money";
import { useActionErrorToast, type MessageKey } from "@/lib/use-action-toast";
import type { AcceptDeliveryInput } from "@/lib/validation/ingest";
import type { CredentialBadge } from "@/lib/validation/webhook";

type ReviewDefaults = {
  // The kind the card shows, so the form opens on the same tab.
  tab: "expense" | "income" | "transfer";
  fromAccountId: string | null;
  toAccountId: string | null;
  amount: string;
  occurredAt: string;
  description: string | null;
  splits: { categoryId: string; amount: string }[];
  // The person picked on the card (RF-242); the review form opens with it.
  forPersonId: string | null;
};

const SOURCE_MESSAGE = {
  merchant: "categoryFromMerchant",
  interpreter: "categoryFromText",
  recipient: "categoryFromRecipient",
  credential_default: "categoryFromDefault",
} as const satisfies Record<NonNullable<PendingDeliveryRow["categorySource"]>, string>;

// What the person set on the card itself, kept by the screen so one write can carry it: the kind of movement, its
// account or accounts, a category of their own and, optionally, whom the movement was for (RF-242, RF-278). Each
// is null while the message's own proposal stands.
export type DeliveryChoice = {
  direction: "income" | "expense" | "transfer" | null;
  accountId: string | null;
  toAccountId: string | null;
  categoryId: string | null;
  forPersonId: string | null;
};
export const NO_CHOICE: DeliveryChoice = {
  direction: null,
  accountId: null,
  toAccountId: null,
  categoryId: null,
  forPersonId: null,
};

// The delivery as the person left it: the proposal with what they changed laid over it. A category of the other
// kind than the one now chosen reads as none (`proposedCategoryId`), so changing the kind never carries one over.
export function withChoice(delivery: PendingDeliveryRow, choice: DeliveryChoice): PendingDeliveryRow {
  return {
    ...delivery,
    proposedDirection: choice.direction ?? delivery.proposedDirection,
    proposedAccountId: choice.accountId ?? delivery.proposedAccountId,
    proposedToAccountId: choice.toAccountId ?? delivery.proposedToAccountId,
  };
}

// Whether the person changed what the message proposed (not the «para quién», which rides along either way).
export function changedProposal(choice: DeliveryChoice): boolean {
  return (
    choice.direction !== null ||
    choice.accountId !== null ||
    choice.toAccountId !== null ||
    choice.categoryId !== null
  );
}

export function movementDefaults(
  proposal: PendingDeliveryRow,
  options: TransactionFormOptions,
  choice: DeliveryChoice,
): ReviewDefaults {
  const delivery = withChoice(proposal, choice);
  const amount =
    delivery.proposedAmountCents === null
      ? ""
      : centsToDecimal(delivery.proposedAmountCents);
  const accountId = delivery.proposedAccountId;
  const isIncome = delivery.proposedDirection === "income";
  const isTransfer = delivery.proposedDirection === "transfer";
  const categoryId = isTransfer ? null : (choice.categoryId ?? proposedCategoryId(delivery, options));

  return {
    tab: delivery.proposedDirection ?? "expense",
    fromAccountId: isIncome ? null : accountId,
    toAccountId: isTransfer ? delivery.proposedToAccountId : isIncome ? accountId : null,
    amount,
    occurredAt: delivery.proposedOccurredAt ?? todayInBogota(),
    description: delivery.proposedDescription,
    splits: categoryId ? [{ categoryId, amount }] : [],
    forPersonId: choice.forPersonId,
  };
}

// The payload of a delivery that is ready for one tap: complete as proposed, or made complete by what the person
// chose on the card (a chosen category stands for the person, as a saved recipient's does).
export function readyInput(
  proposal: PendingDeliveryRow,
  options: TransactionFormOptions,
  choice: DeliveryChoice,
): AcceptDeliveryInput | null {
  const delivery = withChoice(proposal, choice);
  const isTransfer = delivery.proposedDirection === "transfer";
  const changed = changedProposal(choice);
  const ready = changed
    ? delivery.proposedAmountCents !== null &&
      delivery.proposedAccountId !== null &&
      (choice.accountId !== null || !delivery.beforeOpening)
    : delivery.isComplete;
  if (
    !ready ||
    delivery.proposedAmountCents === null ||
    delivery.proposedAccountId === null ||
    (isTransfer
      ? delivery.proposedToAccountId === null || delivery.proposedToAccountId === delivery.proposedAccountId
      : (choice.categoryId ?? proposedCategoryId(delivery, options)) === null)
  ) {
    return null;
  }

  // The tab is the form's own: the write names its sides and derives the kind from them.
  const form = movementDefaults(proposal, options, choice);
  return {
    deliveryId: delivery.id,
    fromAccountId: form.fromAccountId,
    toAccountId: form.toAccountId,
    amount: form.amount,
    occurredAt: form.occurredAt,
    description: form.description,
    splits: form.splits,
    forPersonId: form.forPersonId,
    labelIds: [],
  };
}

// The categories a delivery's account scope and direction can take, a child as «Parent › Child».
export function categoryChoices(
  delivery: Pick<PendingDeliveryRow, "proposedAccountId" | "proposedDirection">,
  options: TransactionFormOptions,
  mark: (name: string) => string,
): { id: string; path: string }[] {
  const scope = scopeOfAccounts([delivery.proposedAccountId], options.accounts);
  const kind = delivery.proposedDirection === "income" ? "income" : "expense";
  return options.categories
    .filter((category) => (scope === null || category.scope === scope) && category.kind === kind)
    .flatMap((category) => [
      { id: category.id, path: scopedCategoryName(category.name, category.scope, mark) },
      ...category.children.map((child) => ({
        id: child.id,
        path: `${scopedCategoryName(category.name, category.scope, mark)} › ${child.name}`,
      })),
    ]);
}

// Where it came from, in words («Llegó por SMS»); null once the key is gone, so nothing is claimed about it.
export function arrivedVia(
  delivery: Pick<PendingDeliveryRow, "credentialBadge" | "credentialName">,
  say: (badge: CredentialBadge, name: string) => string,
): string | null {
  if (delivery.credentialBadge === null || delivery.credentialName === null) return null;
  return say(delivery.credentialBadge, delivery.credentialName);
}

export function DeliveryCard({
  delivery: proposal,
  options,
  choice,
  onChoice,
  selected,
  onSelectedChange,
  onSaveNumber,
}: {
  delivery: PendingDeliveryRow;
  options: TransactionFormOptions;
  choice: DeliveryChoice;
  onChoice: (patch: Partial<DeliveryChoice>) => void;
  // A checkbox only for a card that is ready to record; the screen records the chosen ones together.
  selected: boolean;
  onSelectedChange: ((selected: boolean) => void) | null;
  // Offered when the message names a number nobody saved yet (RF-189).
  onSaveNumber: () => void;
}) {
  const t = useTranslations("ingest");
  const tTx = useTranslations("transactions");
  const tKey = useTranslations();
  const format = useFormatter();
  const onActionError = useActionErrorToast();

  // The proposal with what the person changed on the card laid over it; everything below reads this one.
  const delivery = withChoice(proposal, choice);
  const isIncome = delivery.proposedDirection === "income";
  const isTransfer = delivery.proposedDirection === "transfer";
  const currency = deliveryCurrency(delivery, options);

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
        delivery.recorded
          ? t("duplicateRejectedToast")
          : silenceShape.current
            ? t("silencedToast")
            : t("rejectedToast"),
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

  const forPersonId = choice.forPersonId;
  // The persons of the proposed account's scope (RF-242): a person of the other scope would be refused on write.
  const proposedScope = options.accounts.find((one) => one.id === delivery.proposedAccountId)?.groupId
    ? "group"
    : "personal";
  const persons = options.labels.filter(
    (label) => label.kind === "person" && label.scope === proposedScope,
  );
  const input = readyInput(proposal, options, choice);
  const defaults = movementDefaults(proposal, options, choice);
  const categoryId = choice.categoryId ?? proposedCategoryId(delivery, options);
  const tCategories = useTranslations("categories");
  const categories = categoryChoices(delivery, options, (name) => tCategories("scopedName", { name }));
  // The accounts a movement can be written on: never the hidden «Me debe» of a credit somebody else pays.
  const accountChoices = options.accounts.filter((one) => one.internal !== true);
  const kind = delivery.proposedDirection ?? "expense";
  const withdrawal =
    isTransfer &&
    options.accounts.find((one) => one.id === delivery.proposedToAccountId)?.subtype === "cash";
  const category =
    categoryId === null
      ? null
      : (categoryNamesById(options.categories, (name) =>
          tKey("categories.scopedName", { name }),
        ).get(categoryId) ?? null);
  const chosen = choice.categoryId !== null;
  const learnedFromHistory = !chosen && category !== null && categoryFromHistory(delivery);
  // The day the message prints, never the hour it arrived; a message that prints none shows its arrival.
  const dateLine =
    delivery.proposedOccurredAt === null
      ? t("receivedOn", {
          date: format.dateTime(delivery.createdAt, { dateStyle: "medium", timeStyle: "short" }),
        })
      : t("occurredOn", {
          date: format.dateTime(civilDateToDate(delivery.proposedOccurredAt), {
            day: "numeric",
            month: "short",
            year: "numeric",
          }),
        });

  const via = arrivedVia(delivery, (badge, name) => t("arrivedVia", { kind: badge, name }));

  function runReject(nextSilenceShape: boolean) {
    silenceShape.current = nextSilenceShape;
    reject.execute({
      deliveryId: delivery.id,
      silenceShape: nextSilenceShape,
      ...(delivery.recorded ? { reason: "duplicate" as const } : {}),
    });
  }

  return (
    <Card>
      <Flex direction="column" gap="4">
        <Flex justify="between" align="start" gap="3">
          {onSelectedChange && (
            <Checkbox
              size="3"
              checked={selected}
              onCheckedChange={(checked) => onSelectedChange(checked === true)}
              aria-label={t("chooseDelivery", { name: delivery.merchantLabel ?? t("noMerchant") })}
            />
          )}
          <Flex direction="column" gap="1" minWidth="0" flexGrow="1">
            <Heading as="h2" size="3">
              {delivery.merchantLabel ?? t("noMerchant")}
            </Heading>
            <Text size="2" color="gray">
              {dateLine}
            </Text>
            {via && (
              <Text size="2" color="gray">
                {via}
              </Text>
            )}
          </Flex>

          {delivery.merchantId && (
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
                  <DropdownMenu.Item onSelect={() => setForgetOpen(true)}>
                    {t("forgetMerchant")}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            </Box>
          )}
        </Flex>

        {delivery.proposedAmountCents === null ? (
          <Heading as="h3" size="6" color="amber">
            {t("amountMissing")}
          </Heading>
        ) : (
          <Flex align="baseline" gap="2">
            <Heading as="h3" size="6">
              <Money
                minor={delivery.proposedAmountCents}
                currency={currency}
                tone="plain"
                size="inherit"
              />
            </Heading>
            <Badge color={isIncome ? "jade" : "gray"} variant="soft" radius="full">
              {t(isIncome ? "kindIncome" : withdrawal ? "kindWithdrawal" : isTransfer ? "kindTransfer" : "kindExpense")}
            </Badge>
          </Flex>
        )}

        {delivery.recorded && (
          <Flex direction="column" align="start" gap="1">
            <Badge color="blue" variant="soft" radius="full">
              {t("alreadyRecorded")}
            </Badge>
            <Text size="2" color="gray">
              {t(delivery.recorded.description ? "alreadyRecordedAs" : "alreadyRecordedOn", {
                description: delivery.recorded.description ?? "",
                date: format.dateTime(civilDateToDate(delivery.recorded.occurredOn), {
                  day: "numeric",
                  month: "short",
                }),
              })}
            </Text>
            <TextLink href={`/movements/${delivery.recorded.transactionId}`} size="2">
              {t("seeRecorded")}
            </TextLink>
          </Flex>
        )}

        <Flex direction="column" gap="2">
          <StackedSegmentedControl.Root
            size="3"
            value={kind}
            aria-label={t("typeLabel")}
            onValueChange={(value) => {
              const direction = value as DeliveryChoice["direction"];
              if (direction === kind) return;
              // The proposal's own kind is no change; any other kind drops the category, which is of the old one.
              onChoice({
                direction: direction === (proposal.proposedDirection ?? "expense") ? null : direction,
                categoryId: null,
              });
            }}
          >
            <StackedSegmentedControl.Item value="expense">{t("kindExpense")}</StackedSegmentedControl.Item>
            <StackedSegmentedControl.Item value="income">{t("kindIncome")}</StackedSegmentedControl.Item>
            <StackedSegmentedControl.Item value="transfer">{t("kindTransfer")}</StackedSegmentedControl.Item>
          </StackedSegmentedControl.Root>
          {delivery.proposedAccountId === null && (
            <Text color="amber">{t("accountMissing")}</Text>
          )}
          <Select.Root
            size="3"
            value={delivery.proposedAccountId ?? undefined}
            onValueChange={(value) => {
              // A category of the other scope than the new account would be refused on write.
              const sameScope =
                scopeOfAccounts([value], options.accounts) === scopeOfAccounts([delivery.proposedAccountId], options.accounts);
              onChoice(sameScope ? { accountId: value } : { accountId: value, categoryId: null });
            }}
            disabled={accept.isPending}
          >
            <Select.Trigger
              placeholder={t("accountChoose")}
              color={delivery.proposedAccountId ? undefined : "amber"}
              aria-label={t(isTransfer ? "fromAccountLabel" : "accountLabel")}
            />
            <Select.Content position="popper">
              {accountChoices.map((option) => (
                <Select.Item key={option.id} value={option.id}>
                  {option.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          {isTransfer && (
            <Select.Root
              size="3"
              value={delivery.proposedToAccountId ?? undefined}
              onValueChange={(value) => onChoice({ toAccountId: value })}
              disabled={accept.isPending}
            >
              <Select.Trigger
                placeholder={t("accountChoose")}
                color={delivery.proposedToAccountId ? undefined : "amber"}
                aria-label={t("toAccountLabel")}
              />
              <Select.Content position="popper">
                {accountChoices
                  .filter((option) => option.id !== delivery.proposedAccountId)
                  .map((option) => (
                    <Select.Item key={option.id} value={option.id}>
                      {option.name}
                    </Select.Item>
                  ))}
              </Select.Content>
            </Select.Root>
          )}
          {delivery.beforeOpening && delivery.proposedOccurredAt !== null && (
            <Text size="2" color="amber">
              {t("beforeOpening", {
                date: format.dateTime(
                  civilDateToDate(delivery.proposedOccurredAt),
                  { day: "numeric", month: "short", year: "numeric" },
                ),
              })}
            </Text>
          )}
          {!isTransfer && categoryId === null && (
            <Text color="amber">{t("categoryMissing")}</Text>
          )}
          {!isTransfer && (
            <Select.Root
              size="3"
              value={categoryId ?? undefined}
              onValueChange={(value) => onChoice({ categoryId: value })}
              disabled={accept.isPending}
            >
              <Select.Trigger
                placeholder={t("categoryChoose")}
                color={categoryId ? undefined : "amber"}
                aria-label={t("categoryLabel")}
              />
              <Select.Content position="popper">
                {categories.map((option) => (
                  <Select.Item key={option.id} value={option.id}>
                    {option.path}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
          <Flex gap="2" wrap="wrap">
            {delivery.categorySource && !chosen && (
              <Badge
                color={learnedFromHistory ? "blue" : "gray"}
                variant={learnedFromHistory ? "soft" : undefined}
              >
                {t(
                  learnedFromHistory
                    ? "categoryFromHistory"
                    : SOURCE_MESSAGE[delivery.categorySource],
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

        {delivery.recipientName && (
          <Text size="2" color="gray">
            {t("recipientIs", { name: delivery.recipientName })}
          </Text>
        )}
        {delivery.extractedIdentifier && !delivery.recipientId && (
          <Flex align="start">
            <Button type="button" size="3" variant="soft" onClick={onSaveNumber}>
              {t("saveNumber")}
            </Button>
          </Flex>
        )}

        {persons.length > 0 && delivery.proposedAccountId !== null && (
          <Flex direction="column" gap="1">
            <Text as="label" size="2" weight="medium" htmlFor={`delivery-for-person-${delivery.id}`}>
              {tTx("forPersonLabel")}
            </Text>
            <Select.Root
              size="3"
              value={forPersonId ?? "none"}
              onValueChange={(value) => onChoice({ forPersonId: value === "none" ? null : value })}
              disabled={accept.isPending}
            >
              <Select.Trigger id={`delivery-for-person-${delivery.id}`} />
              <Select.Content position="popper">
                <Select.Item value="none">{tTx("forPersonNone")}</Select.Item>
                {persons.map((person) => (
                  <Select.Item key={person.id} value={person.id}>
                    {person.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>
        )}

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
              <RawText size="2" color="gray">
                {delivery.rawText}
              </RawText>
            </Flex>
          )}
        </Flex>

        {delivery.recorded ? (
          <Flex direction="column" gap="2">
            <Button
              type="button"
              size="3"
              color="red"
              disabled={reject.isPending}
              onClick={() => runReject(false)}
            >
              {reject.isPending && <Spinner />}
              {t("rejectDuplicate")}
            </Button>
            <Button type="button" size="3" variant="ghost" color="gray" onClick={() => setReviewOpen(true)}>
              {t("recordAnyway")}
            </Button>
          </Flex>
        ) : (
          <Flex gap="3">
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
            <Button type="button" size="3" color="red" variant="soft" onClick={() => setRejectOpen(true)}>
              {t("reject")}
            </Button>
          </Flex>
        )}
        {accept.result.serverError && (
          <Text size="2" color="red" role="alert">
            {tKey(accept.result.serverError as MessageKey)}
          </Text>
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
              dateBeforeOpening={delivery.beforeOpening}
              onSaved={() => toast.success(t("acceptedToast"))}
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
