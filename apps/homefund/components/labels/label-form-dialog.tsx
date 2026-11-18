"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { createLabelAction, updateLabelAction } from "@/app/actions/labels";
import {
  AmountField,
  Button,
  ColorSwatchPicker,
  DateInput,
  Dialog,
  Field,
  FieldControl,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Select,
  Spinner,
  Switch,
  TapTarget,
  Text,
  TextField,
} from "@/components/ui";
import { BASE_CURRENCY, OFFERED_CURRENCIES, type CurrencyCode } from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
import { CATEGORY_COLORS, nextCategoryColor } from "@/lib/fund/category-color";
import { amountToInput } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  createLabelSchema,
  updateLabelSchema,
  LABEL_KINDS,
  LABEL_PLACEMENTS,
  type AlreadyOwedInput,
  type CreateLabelInput,
  type UpdateLabelInput,
} from "@/lib/validation/label";

// Where a label lands, named once for the screen and the form alike.
export type LabelPlacement = (typeof LABEL_PLACEMENTS)[number];
type LabelKind = (typeof LABEL_KINDS)[number];

// A superset of both schemas' shapes: the resolver strips whichever key the
// active schema does not declare, so only the fields that schema needs ever
// reach the matching action.
type LabelFormValues = {
  labelId: string;
  name: string;
  color: string | null;
  placement: LabelPlacement;
  kind: LabelKind;
  chargeDefault: boolean;
  // The field is always an object while the form is open; a blank amount turns it into null before validation.
  alreadyOwed: AlreadyOwedInput | null;
};

type Label = {
  id: string;
  name: string;
  color: string | null;
  placement: LabelPlacement;
  kind: LabelKind;
  chargeDefault: boolean;
  alreadyOwed: { cents: number; currency: CurrencyCode; since: string } | null;
};

type LabelFormProps = {
  onOpenChange: (open: boolean) => void;
  label?: Label;
  defaultPlacement: LabelPlacement;
  // What a new label is born as: «Añadir persona» opens the same form as a person.
  defaultKind: LabelKind;
  hasGroup: boolean;
  canManageGroup: boolean;
  usedColors: { personal: string[]; group: string[] };
};

export function LabelFormDialog({
  open,
  ...props
}: LabelFormProps & { open: boolean }) {
  const t = useTranslations("labels");

  return (
    <Dialog.Root open={open} onOpenChange={props.onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>
          {t(
            props.label
              ? props.label.kind === "person" ? "editPersonTitle" : "editTitle"
              : props.defaultKind === "person" ? "addPersonTitle" : "addTitle",
          )}
        </Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            subject, so the form below is always born with fresh defaults. */}
        <LabelForm key={props.label?.id ?? "create"} {...props} />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function LabelForm({
  onOpenChange,
  label,
  defaultPlacement,
  defaultKind,
  hasGroup,
  canManageGroup,
  usedColors,
}: LabelFormProps) {
  const t = useTranslations("labels");
  // Root-scoped: the keys arriving from the schema and the action are full paths.
  const tKey = useTranslations();

  const emptyOwed: AlreadyOwedInput = { amount: "", currency: BASE_CURRENCY, since: todayInBogota() };

  const isEdit = !!label;
  // Fixed at birth: a tag never becomes a person, so the form reads it once.
  const kind = label?.kind ?? defaultKind;
  const placement = label?.placement ?? defaultPlacement;

  const schemaResolver = (isEdit
    ? zodResolver(updateLabelSchema)
    : zodResolver(createLabelSchema)) as unknown as Resolver<LabelFormValues>;

  // A blank «Ya te debía» is no debt: the schema sees null, which removes it on an edit.
  const resolver: Resolver<LabelFormValues> = (values, context, options) =>
    schemaResolver(
      { ...values, alreadyOwed: kind === "person" && values.alreadyOwed?.amount.trim() ? values.alreadyOwed : null },
      context,
      options,
    );

  const form = useForm<LabelFormValues>({
    resolver,
    defaultValues: {
      labelId: label?.id ?? "",
      name: label?.name ?? "",
      color: label?.color ?? nextCategoryColor(usedColors[placement]),
      placement,
      kind,
      chargeDefault: label?.chargeDefault ?? false,
      alreadyOwed: label?.alreadyOwed
        ? {
            amount: amountToInput(label.alreadyOwed.cents, label.alreadyOwed.currency),
            currency: label.alreadyOwed.currency as AlreadyOwedInput["currency"],
            since: label.alreadyOwed.since,
          }
        : emptyOwed,
    },
  });

  // Writing what they already owed makes the person «se le cobra»: the switch follows and waits until it is cleared.
  const owedAmount = useWatch({ control: form.control, name: "alreadyOwed.amount" });
  const hasOpening = kind === "person" && owedAmount.trim().length > 0;
  function onActionSuccess() {
    toast.success(t(isEdit ? "updated" : "created"));
    onOpenChange(false);
  }

  const onActionError = useActionErrorToast();

  // Two hooks, not one behind a ternary: the actions' input types differ, and
  // rules of hooks forbid picking which one to call.
  const create = useAction(createLabelAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });
  const update = useAction(updateLabelAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });

  const isPending = isEdit ? update.isPending : create.isPending;

  function onSubmit(values: LabelFormValues) {
    // The resolver already parsed `values` against the schema for this mode,
    // stripping the field the other mode's action does not accept.
    if (isEdit) {
      update.execute(values as UpdateLabelInput);
    } else {
      create.execute(values as CreateLabelInput);
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="label-name">{t("nameLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="label-name"
                  size="3"
                  autoFocus
                  autoComplete="off"
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />
        {isEdit ? (
          <Field>
            {/* Not labelable: a read-only Text names nothing a <label> can target. */}
            <FieldLabel>{t("placementLabel")}</FieldLabel>
            <Text size="3">
              {t(
                placement === "group" ? "placementGroup" : "placementPersonal",
              )}
            </Text>
            <FieldDescription>{t("placementLocked")}</FieldDescription>
          </Field>
        ) : (
          hasGroup && (
            <Controller
              name="placement"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="label-placement">
                    {t("placementLabel")}
                  </FieldLabel>
                  <Select.Root
                    value={field.value}
                    onValueChange={(value) => {
                      const nextPlacement = value as LabelPlacement;
                      field.onChange(nextPlacement);
                      // Each scope spends its own colours, so the default
                      // follows the set the label is about to land in.
                      form.setValue(
                        "color",
                        nextCategoryColor(usedColors[nextPlacement]),
                      );
                    }}
                    disabled={isPending}
                  >
                    <FieldControl>
                      <Select.Trigger id="label-placement" />
                    </FieldControl>
                    <Select.Content>
                      <Select.Item value="personal">
                        {t("placementPersonal")}
                      </Select.Item>
                      {/* The database refuses a member's group write; the
                          option says so before the write is attempted. */}
                      <Select.Item value="group" disabled={!canManageGroup}>
                        {t("placementGroup")}
                      </Select.Item>
                    </Select.Content>
                  </Select.Root>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />
          )
        )}
        {kind === "person" && (
          <Controller
            name="chargeDefault"
            control={form.control}
            render={({ field }) => (
              <Text as="label" size="2">
                <TapTarget align="center" gap="2">
                  <Switch
                    checked={field.value || hasOpening}
                    disabled={isPending || hasOpening}
                    onCheckedChange={field.onChange}
                  />
                  <Flex direction="column">
                    {t("chargeLabel")}
                    <Text size="1" color="gray">
                      {t(hasOpening ? "chargeForced" : "chargeHint")}
                    </Text>
                  </Flex>
                </TapTarget>
              </Text>
            )}
          />
        )}
        {kind === "person" && (
          <Flex direction="column" gap="3">
            <Text size="2" weight="medium">
              {t("alreadyOwedLabel")}
            </Text>
            <Text size="1" color="gray">
              {t("alreadyOwedHint")}
            </Text>
            <Controller
              name="alreadyOwed.currency"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="label-owed-currency">{t("alreadyOwedCurrencyLabel")}</FieldLabel>
                  <Select.Root size="3" value={field.value} onValueChange={field.onChange} disabled={isPending}>
                    <FieldControl>
                      <Select.Trigger id="label-owed-currency" />
                    </FieldControl>
                    <Select.Content position="popper">
                      {OFFERED_CURRENCIES.map((currency) => (
                        <Select.Item key={currency} value={currency}>
                          {currency}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />
            <Controller
              name="alreadyOwed.amount"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="label-owed-amount">{t("alreadyOwedAmountLabel")}</FieldLabel>
                  <FieldControl>
                    <AmountField {...field} id="label-owed-amount" size="3" inputMode="numeric" disabled={isPending} />
                  </FieldControl>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />
            <Controller
              name="alreadyOwed.since"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="label-owed-since">{t("alreadyOwedSinceLabel")}</FieldLabel>
                  <FieldControl>
                    <DateInput {...field} id="label-owed-since" size="3" disabled={isPending} />
                  </FieldControl>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />
          </Flex>
        )}
        <Controller
          name="color"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldControl>
                <ColorSwatchPicker
                  id="label-color"
                  name="color"
                  value={field.value ?? ""}
                  onValueChange={field.onChange}
                  colors={CATEGORY_COLORS}
                  label={t("colorLabel")}
                  optionLabel={(index) => t("colorOption", { number: index + 1 })}
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />
        <Field>
          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button
                type="button"
                variant="soft"
                color="gray"
                disabled={isPending}
              >
                {tKey("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button type="submit" disabled={isPending}>
              {isPending && <Spinner />}
              {tKey("common.save")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
