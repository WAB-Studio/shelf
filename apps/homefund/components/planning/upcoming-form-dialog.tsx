"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Info } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import {
  createExpectedIncomeAction,
  createPlannedPaymentAction,
  updatePlannedPaymentAction,
} from "@/app/actions/planned-payments";
import {
  createRecurringRuleAction,
  updateRecurringRuleAction,
} from "@/app/actions/recurring-rules";
import {
  Box,
  Button,
  Callout,
  Dialog,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  SegmentedControl,
  Select,
  Spinner,
  Text,
  TextField,
  AmountField,
  DateInput,
  ScopedSelectGroups,
} from "@/components/ui";
import type { PlannedPaymentRow } from "@/db/queries/planned-payments";
import type { RecurringRuleRow } from "@/db/queries/recurring-rules";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import { scopeOfAccounts } from "@/lib/fund/category-scope";
import { isExpectedIncome } from "@/lib/fund/glance";
import { pickableCategories } from "@/lib/fund/upcoming";
import { amountToInput } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  createPlannedPaymentSchema,
  refinePaymentAmount,
  requireAnIncome,
  updatePlannedPaymentSchema,
  type CreatePlannedPaymentInput,
  type UpdatePlannedPaymentInput,
} from "@/lib/validation/planned-payment";
import {
  createRecurringRuleSchema,
  refineRuleAmount,
  updateRecurringRuleSchema,
  type CreateRecurringRuleInput,
  type UpdateRecurringRuleInput,
} from "@/lib/validation/recurring-rule";

// Radix's Select rejects an empty-string item value, so "no category" and "no
// second account" each need a sentinel; both map back to null when picked.
const NONE = "none";

type Frequency = "weekly" | "monthly" | "yearly";

// A superset of the four schemas' shapes: whichever one is active strips the keys it does not declare.
type FormValues = {
  plannedPaymentId?: string;
  id?: string;
  fromAccountId: string | null;
  toAccountId: string | null;
  amount: string;
  categoryId: string | null;
  description: string | null;
  // A one-off carries a due day and an optional reminder; a repeating one its first run, rhythm and end.
  dueDate: string;
  remindOn: string | null;
  frequency: Frequency;
  intervalN: number;
  dayOfMonth: number | null;
  nextRunOn: string;
  endsOn: string | null;
};

// Weekly carries no day anchor; yearly follows the first run's day; monthly keeps the day a rule already had.
function dayAnchor(values: FormValues): number | null {
  if (values.frequency === "weekly") return null;
  const day = Number(values.nextRunOn.slice(8, 10));
  const fromDate = Number.isInteger(day) && day > 0 ? day : null;
  return values.frequency === "yearly" ? fromDate : (values.dayOfMonth ?? fromDate);
}

/**
 * One form for everything «Lo que viene» holds. Two questions pick what is being added: does the person pay
 * or receive, and does it happen once or repeat. Underneath it is still a planned payment, an expected income
 * or a recurring rule, each written by its own action under its own schema; editing keeps what it was.
 */
export function UpcomingFormDialog({
  open,
  onOpenChange,
  options,
  payment,
  rule,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: TransactionFormOptions;
  payment?: PlannedPaymentRow;
  rule?: RecurringRuleRow;
}) {
  const t = useTranslations("upcoming.form");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t(payment || rule ? "editTitle" : "addTitle")}</Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            subject, so the form below is always born with fresh defaults. */}
        <UpcomingForm
          key={payment?.id ?? rule?.id ?? "create"}
          options={options}
          payment={payment}
          rule={rule}
          onOpenChange={onOpenChange}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function UpcomingForm({
  options,
  payment,
  rule,
  onOpenChange,
}: {
  options: TransactionFormOptions;
  payment?: PlannedPaymentRow;
  rule?: RecurringRuleRow;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("upcoming.form");
  const locale = useLocale();
  // Root-scoped: `common` and `categories` sit outside the `upcoming.form` namespace.
  const tKey = useTranslations();

  const isEdit = !!payment || !!rule;
  // A save over someone else's change is refused here, in the dialog, with what was typed kept.
  const [stale, setStale] = useState(false);
  const [receives, setReceives] = useState(
    rule ? rule.toAccountId !== null : payment ? isExpectedIncome(payment) : false,
  );
  const [repeats, setRepeats] = useState(!!rule);
  const mark = useCallback((name: string) => tKey("categories.scopedName", { name }), [tKey]);

  const row = payment ?? rule;
  // Only accounts the person may write, plus the ones an edit already names.
  const writableAccounts = options.accounts.filter(
    (account) =>
      account.canWrite || account.id === row?.fromAccountId || account.id === row?.toAccountId,
  );

  // The amount is read in the currency the named accounts settle in, by the same rule the action applies to
  // the currencies it reads back (RF-121, RNF-10).
  const resolver: Resolver<FormValues> = (values, context, options_) => {
    const settlement = {
      from: values.fromAccountId ? (options.accountCurrencies[values.fromAccountId] ?? null) : null,
      to: values.toAccountId ? (options.accountCurrencies[values.toAccountId] ?? null) : null,
    };

    if (repeats) {
      const schema = (isEdit ? updateRecurringRuleSchema : createRecurringRuleSchema).superRefine(
        refineRuleAmount(settlement),
      );
      return (zodResolver(schema) as unknown as Resolver<FormValues>)(
        { ...values, categoryId: values.categoryId ?? "", dayOfMonth: dayAnchor(values) },
        context,
        options_,
      );
    }

    const base = isEdit ? updatePlannedPaymentSchema : createPlannedPaymentSchema;
    const schema = (receives ? base.superRefine(requireAnIncome) : base).superRefine(
      refinePaymentAmount(settlement),
    );
    return (zodResolver(schema) as unknown as Resolver<FormValues>)(values, context, options_);
  };

  const form = useForm<FormValues>({
    resolver,
    defaultValues: {
      plannedPaymentId: payment?.id,
      id: rule?.id,
      fromAccountId: row?.fromAccountId ?? null,
      toAccountId: row?.toAccountId ?? null,
      amount: row ? amountToInput(row.amountCents, row.currency, locale) : "",
      categoryId: row?.categoryId ?? null,
      description: row?.description ?? null,
      dueDate: payment?.dueDate ?? "",
      remindOn: payment?.remindOn ?? null,
      frequency: rule?.frequency ?? "monthly",
      intervalN: rule?.intervalN ?? 1,
      dayOfMonth: rule?.dayOfMonth ?? null,
      nextRunOn: rule?.nextRunOn ?? "",
      endsOn: rule?.endsOn ?? null,
    },
  });

  const fromAccountId = useWatch({ control: form.control, name: "fromAccountId" });
  const toAccountId = useWatch({ control: form.control, name: "toAccountId" });
  const intervalN = useWatch({ control: form.control, name: "intervalN" });

  // A repeating plan names one account; a one-off payment may also name a second one of the person's own,
  // the card or loan it pays.
  const accountId = receives ? toAccountId : fromAccountId;
  const paysToAccount = !receives && !repeats && toAccountId !== null;

  // A category is asked for a repeating plan, offered for a one-off payment and left out of an expected income
  // and of a payment between the person's own accounts, which carry none.
  const asksCategory = repeats || (!receives && !paysToAccount);
  const categories = useMemo(
    () =>
      pickableCategories(
        options.categories,
        scopeOfAccounts([fromAccountId, toAccountId], options.accounts),
        receives ? "income" : "expense",
        mark,
      ),
    [options.categories, options.accounts, fromAccountId, toAccountId, receives, mark],
  );

  const categoryItems = (scope: "personal" | "group") =>
    categories
      .filter((category) => category.scope === scope)
      .map((category) => (
        <Select.Item key={category.id} value={category.id}>
          {/* One line whatever the name: the cap keeps it inside a 360 px screen. */}
          <Box maxWidth="calc(100vw - 6rem)" asChild>
            <Text as="div" truncate>
              {category.name}
            </Text>
          </Box>
        </Select.Item>
      ));

  // Another account, direction or scope strands the picked category outside the list.
  useEffect(() => {
    const categoryId = form.getValues("categoryId");
    if (categoryId && (!asksCategory || !categories.some((one) => one.id === categoryId))) {
      form.setValue("categoryId", null, { shouldValidate: true });
    }
  }, [asksCategory, categories, form]);

  function putAccount(side: "pay" | "receive", value: string | null) {
    form.setValue(side === "receive" ? "toAccountId" : "fromAccountId", value, { shouldValidate: true });
    if (side === "receive") form.setValue("fromAccountId", null);
    else if (repeats) form.setValue("toAccountId", null);
  }

  function chooseDirection(value: string) {
    const next = value === "receive";
    setReceives(next);
    form.setValue(next ? "toAccountId" : "fromAccountId", accountId);
    form.setValue(next ? "fromAccountId" : "toAccountId", null);
    form.clearErrors();
  }

  function chooseRepeat(value: string) {
    const next = value === "repeats";
    setRepeats(next);
    // A repeating plan names exactly one account.
    if (next && !receives) form.setValue("toAccountId", null);
    form.clearErrors();
  }

  function onActionSuccess() {
    toast.success(t(isEdit ? "updated" : "created"));
    onOpenChange(false);
  }

  const onActionError = useActionErrorToast();
  const onStaleOr = (result: Parameters<typeof onActionError>[0]) => {
    if (result.error.serverError === "errors.stale") setStale(true);
    else onActionError(result);
  };

  // One hook per action, not one behind a ternary: their input types differ and hooks cannot be picked.
  const createPayment = useAction(createPlannedPaymentAction, { onSuccess: onActionSuccess, onError: onActionError });
  const createIncome = useAction(createExpectedIncomeAction, { onSuccess: onActionSuccess, onError: onActionError });
  const createRule = useAction(createRecurringRuleAction, { onSuccess: onActionSuccess, onError: onActionError });
  const updatePayment = useAction(updatePlannedPaymentAction, { onSuccess: onActionSuccess, onError: onStaleOr });
  const updateRule = useAction(updateRecurringRuleAction, { onSuccess: onActionSuccess, onError: onStaleOr });

  const isPending = [createPayment, createIncome, createRule, updatePayment, updateRule].some(
    (action) => action.isPending,
  );

  function onSubmit(values: FormValues) {
    // The resolver already parsed `values` against the schema of this kind of plan.
    setStale(false);
    if (rule) {
      updateRule.execute({
        ...(values as unknown as UpdateRecurringRuleInput),
        expectedUpdatedAt: rule.updatedAt,
      });
    } else if (payment) {
      updatePayment.execute({
        ...(values as UpdatePlannedPaymentInput),
        expectedUpdatedAt: payment.updatedAt,
      });
    } else if (repeats) {
      createRule.execute(values as unknown as CreateRecurringRuleInput);
    } else if (receives) {
      // The same schema the form ran, with the source and the category left out.
      createIncome.execute({
        ...(values as CreatePlannedPaymentInput),
        fromAccountId: null,
        categoryId: null,
      });
    } else {
      createPayment.execute(values as CreatePlannedPaymentInput);
    }
  }

  const side = receives ? "receive" : "pay";
  const accountError = form.formState.errors.fromAccountId ?? form.formState.errors.toAccountId;
  const optional = (
    <Text size="2" weight="regular" color="gray">
      {tKey("common.optional")}
    </Text>
  );

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        {/* What it is cannot change after saving: each kind is its own record. */}
        {!isEdit && (
          <>
            <Field>
              <FieldLabel id="upcoming-direction-label">{t("directionLabel")}</FieldLabel>
              <FieldControl>
                <SegmentedControl.Root
                  size="3"
                  value={side}
                  onValueChange={chooseDirection}
                  aria-labelledby="upcoming-direction-label"
                >
                  <SegmentedControl.Item value="pay">{t("pay")}</SegmentedControl.Item>
                  <SegmentedControl.Item value="receive">{t("receive")}</SegmentedControl.Item>
                </SegmentedControl.Root>
              </FieldControl>
            </Field>
            <Field>
              <FieldLabel id="upcoming-repeat-label">{t("repeatLabel")}</FieldLabel>
              <FieldControl>
                <SegmentedControl.Root
                  size="3"
                  value={repeats ? "repeats" : "once"}
                  onValueChange={chooseRepeat}
                  aria-labelledby="upcoming-repeat-label"
                >
                  <SegmentedControl.Item value="once">{t("once")}</SegmentedControl.Item>
                  <SegmentedControl.Item value="repeats">{t("repeats")}</SegmentedControl.Item>
                </SegmentedControl.Root>
              </FieldControl>
            </Field>
          </>
        )}

        <Controller
          name="description"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="upcoming-concept">
                {t(receives ? "conceptReceive" : "conceptPay")}
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  id="upcoming-concept"
                  size="3"
                  placeholder={t(receives ? "conceptReceivePlaceholder" : "conceptPayPlaceholder")}
                  disabled={isPending}
                  value={field.value ?? ""}
                  onChange={(event) => field.onChange(event.target.value || null)}
                  onBlur={field.onBlur}
                  name={field.name}
                  ref={field.ref}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Controller
          name="amount"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="upcoming-amount">{t("amount")}</FieldLabel>
              <FieldControl>
                <AmountField {...field} id="upcoming-amount" size="3" inputMode="numeric" disabled={isPending} />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />

        <Field invalid={!!accountError}>
          <FieldLabel htmlFor="upcoming-account">{t(receives ? "accountReceive" : "accountPay")}</FieldLabel>
          <Select.Root
            size="3"
            value={accountId ?? ""}
            onValueChange={(value) => putAccount(side, value)}
            disabled={isPending}
          >
            <FieldControl>
              <Select.Trigger id="upcoming-account" placeholder={t("accountPlaceholder")} />
            </FieldControl>
            <Select.Content position="popper">
              {writableAccounts.map((account) => (
                <Select.Item key={account.id} value={account.id}>
                  {account.name}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <FieldMessage error={accountError} />
        </Field>

        {!receives && !repeats && (
          <Field>
            <FieldLabel htmlFor="upcoming-pay-to">
              <Flex as="span" align="center" gap="1">
                {t("payTo")}
                {optional}
              </Flex>
            </FieldLabel>
            <Select.Root
              size="3"
              value={toAccountId ?? NONE}
              onValueChange={(value) => form.setValue("toAccountId", value === NONE ? null : value, { shouldValidate: true })}
              disabled={isPending}
            >
              <FieldControl>
                <Select.Trigger id="upcoming-pay-to" />
              </FieldControl>
              <Select.Content position="popper">
                <Select.Item value={NONE}>{t("payToNone")}</Select.Item>
                {writableAccounts
                  .filter((account) => account.id !== fromAccountId)
                  .map((account) => (
                    <Select.Item key={account.id} value={account.id}>
                      {account.name}
                    </Select.Item>
                  ))}
              </Select.Content>
            </Select.Root>
          </Field>
        )}

        {repeats ? (
          <Controller
            key="nextRunOn"
            name="nextRunOn"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="upcoming-date">{t("dateRepeat")}</FieldLabel>
                <FieldControl>
                  <DateInput {...field} id="upcoming-date" size="3" disabled={isPending} />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        ) : (
          <Controller
            key="dueDate"
            name="dueDate"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="upcoming-date">{t(receives ? "dateReceive" : "datePay")}</FieldLabel>
                <FieldControl>
                  <DateInput {...field} id="upcoming-date" size="3" disabled={isPending} />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}

        {repeats && (
          <>
            <Controller
              name="frequency"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="upcoming-frequency">{t("frequency")}</FieldLabel>
                  <Select.Root size="3" value={field.value} onValueChange={field.onChange} disabled={isPending}>
                    <FieldControl>
                      <Select.Trigger id="upcoming-frequency" />
                    </FieldControl>
                    <Select.Content position="popper">
                      {(["monthly", "weekly", "yearly"] as const).map((one) => (
                        <Select.Item key={one} value={one}>
                          {t(`every.${one}`, { n: intervalN })}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />

            <Controller
              name="endsOn"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="upcoming-ends">
                    <Flex as="span" align="center" gap="1">
                      {t("endsOn")}
                      {optional}
                    </Flex>
                  </FieldLabel>
                  <FieldControl>
                    <DateInput
                      id="upcoming-ends"
                      size="3"
                      value={field.value ?? ""}
                      onChange={(event) => field.onChange(event.target.value || null)}
                      onBlur={field.onBlur}
                      disabled={isPending}
                    />
                  </FieldControl>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />
          </>
        )}

        {!repeats && (
          <Controller
            name="remindOn"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="upcoming-remind">
                  <Flex as="span" align="center" gap="1">
                    {t("remindOn")}
                    {optional}
                  </Flex>
                </FieldLabel>
                <FieldControl>
                  <DateInput
                    id="upcoming-remind"
                    size="3"
                    value={field.value ?? ""}
                    onChange={(event) => field.onChange(event.target.value || null)}
                    onBlur={field.onBlur}
                    disabled={isPending}
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}

        {asksCategory && (
          <Controller
            name="categoryId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="upcoming-category">
                  <Flex as="span" align="center" gap="1">
                    {t("category")}
                    {!repeats && optional}
                  </Flex>
                </FieldLabel>
                <Select.Root
                  size="3"
                  value={field.value ?? (repeats ? "" : NONE)}
                  onValueChange={(value) => field.onChange(value === NONE ? null : value)}
                  disabled={isPending}
                >
                  <FieldControl>
                    <Select.Trigger id="upcoming-category" placeholder={t(repeats ? "categoryPlaceholder" : "categoryNone")} />
                  </FieldControl>
                  <Select.Content position="popper">
                    {!repeats && <Select.Item value={NONE}>{t("categoryNone")}</Select.Item>}
                    {/* Tied to no account, both lists are offered, each under its own heading. */}
                    <ScopedSelectGroups
                      fundHeading={tKey("categories.fundSection", { name: options.groupName ?? "" })}
                      personalHeading={tKey("categories.selectPersonalHeading")}
                      fund={categoryItems("group")}
                      personal={categoryItems("personal")}
                    />
                  </Select.Content>
                </Select.Root>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}

        <Callout.Root color="jade" variant="soft">
          <Callout.Icon>
            <Info size={16} aria-hidden />
          </Callout.Icon>
          <Callout.Text>{t(repeats ? "hintRepeat" : receives ? "hintReceive" : "hintPay")}</Callout.Text>
        </Callout.Root>

        {stale && (
          <Callout.Root color="red" variant="soft" role="alert">
            <Callout.Text>{tKey("errors.stale")}</Callout.Text>
          </Callout.Root>
        )}

        <Field>
          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray" disabled={isPending}>
                {tKey("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button type="submit" disabled={isPending}>
              {isPending && <Spinner />}
              {t("save")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
