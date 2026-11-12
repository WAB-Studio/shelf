"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useLocale, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, FormProvider, useForm, useFormContext, useWatch } from "react-hook-form";
import { toast } from "sonner";

import { setUpThirdPartyCreditAction, updateThirdPartyCreditAction } from "@/app/actions/third-party-credits";
import {
  AmountField,
  Button,
  DateInput,
  Dialog,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Select,
  Spinner,
  TextField,
} from "@/components/ui";
import { minorUnitExponent, type CurrencyCode } from "@/lib/currency";
import { todayInBogota } from "@/lib/dates";
import type { Locale } from "@/lib/locales";
import { amountToInput } from "@/lib/money";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  setUpThirdPartyCreditSchema,
  updateThirdPartyCreditSchema,
  type SetUpThirdPartyCreditFields,
  type SetUpThirdPartyCreditInput,
  type UpdateThirdPartyCreditFields,
  type UpdateThirdPartyCreditInput,
} from "@/lib/validation/third-party-credit";

// The select has no empty value, so «a new one» travels under this word and leaves the form as "".
const NEW_RECEIVABLE = "new";

type Asset = { id: string; name: string };

// The fields both forms share; each form provides its own, a superset of these, through `FormProvider`.
type SharedFields = { personName: string; installmentAmount: string; dueDay: string };

// What the lender asks each month, optional and the same in both forms.
function LenderTermsFields({ currency, disabled }: { currency: CurrencyCode; disabled: boolean }) {
  const t = useTranslations("thirdPartyCredit");
  const { control } = useFormContext<SharedFields>();

  return (
    <Flex gap="3">
      <Controller
        name="installmentAmount"
        control={control}
        render={({ field, fieldState }) => (
          <Field invalid={fieldState.invalid}>
            <FieldLabel htmlFor="third-party-installment">{t("installmentLabel")}</FieldLabel>
            <FieldControl>
              <AmountField
                {...field}
                id="third-party-installment"
                size="3"
                inputMode={minorUnitExponent(currency) > 0 ? "decimal" : "numeric"}
                disabled={disabled}
              />
            </FieldControl>
            <FieldMessage error={fieldState.error} />
          </Field>
        )}
      />
      <Controller
        name="dueDay"
        control={control}
        render={({ field, fieldState }) => (
          <Field invalid={fieldState.invalid}>
            <FieldLabel htmlFor="third-party-due-day">{t("dueDayLabel")}</FieldLabel>
            <FieldControl>
              <TextField.Root
                {...field}
                id="third-party-due-day"
                size="3"
                inputMode="numeric"
                maxLength={2}
                disabled={disabled}
              />
            </FieldControl>
            <FieldMessage error={fieldState.error} />
          </Field>
        )}
      />
    </Flex>
  );
}

function PersonField({ disabled }: { disabled: boolean }) {
  const t = useTranslations("thirdPartyCredit");
  const { control } = useFormContext<SharedFields>();

  return (
    <Controller
      name="personName"
      control={control}
      render={({ field, fieldState }) => (
        <Field invalid={fieldState.invalid}>
          <FieldLabel htmlFor="third-party-person">{t("personLabel")}</FieldLabel>
          <FieldControl>
            <TextField.Root
              {...field}
              id="third-party-person"
              size="3"
              placeholder={t("personPlaceholder")}
              autoFocus
              disabled={disabled}
            />
          </FieldControl>
          <FieldMessage error={fieldState.error} />
        </Field>
      )}
    />
  );
}

function Footer({ pending }: { pending: boolean }) {
  const t = useTranslations("thirdPartyCredit");
  const tKey = useTranslations();

  return (
    <Field>
      <Flex gap="3" justify="end">
        <Dialog.Close>
          <Button type="button" variant="soft" color="gray" disabled={pending}>
            {tKey("common.cancel")}
          </Button>
        </Dialog.Close>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner />}
          {t("save")}
        </Button>
      </Flex>
    </Field>
  );
}

/** «Lo paga otra persona» (RF-211): who pays the credit, where their debt sits and what the lender asks. */
export function SetUpThirdPartyDialog({
  open,
  onOpenChange,
  credit,
  assets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  credit: { accountId: string; owedCents: number; currency: CurrencyCode };
  // The person's own asset accounts a «Me debe» may already be.
  assets: Asset[];
}) {
  const t = useTranslations("thirdPartyCredit");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t("setUpTitle")}</Dialog.Title>
        <SetUpForm credit={credit} assets={assets} onOpenChange={onOpenChange} />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function SetUpForm({
  credit,
  assets,
  onOpenChange,
}: {
  credit: { accountId: string; owedCents: number; currency: CurrencyCode };
  assets: Asset[];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("thirdPartyCredit");
  const onActionError = useActionErrorToast();
  const locale = useLocale() as Locale;

  const form = useForm<SetUpThirdPartyCreditFields, unknown, SetUpThirdPartyCreditInput>({
    resolver: zodResolver(setUpThirdPartyCreditSchema),
    defaultValues: {
      liabilityAccountId: credit.accountId,
      personName: "",
      receivableAccountId: "",
      // What the credit still owes: the person owes the whole of it until their payments say otherwise.
      amount: amountToInput(credit.owedCents, credit.currency, locale),
      openedOn: todayInBogota(),
      installmentAmount: "",
      dueDay: "",
    },
  });
  const receivable = useWatch({ control: form.control, name: "receivableAccountId" });

  const setUp = useAction(setUpThirdPartyCreditAction, {
    onSuccess() {
      toast.success(t("setUpSaved"));
      onOpenChange(false);
    },
    onError: onActionError,
  });
  const isPending = setUp.isPending;

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(() => setUp.execute(form.getValues()))} noValidate>
        <FieldGroup>
          <PersonField disabled={isPending} />

          <Controller
            name="receivableAccountId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="third-party-receivable">{t("receivableLabel")}</FieldLabel>
                <Select.Root
                  size="3"
                  value={field.value || NEW_RECEIVABLE}
                  onValueChange={(value) => field.onChange(value === NEW_RECEIVABLE ? "" : value)}
                  disabled={isPending}
                >
                  <FieldControl>
                    <Select.Trigger id="third-party-receivable" />
                  </FieldControl>
                  <Select.Content position="popper">
                    <Select.Item value={NEW_RECEIVABLE}>{t("receivableNew")}</Select.Item>
                    {assets.map((asset) => (
                      <Select.Item key={asset.id} value={asset.id}>
                        {asset.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />

          {/* A new «Me debe» opens at a figure and a day; an account the person already has keeps its own. */}
          {!receivable && (
            <Flex gap="3">
              <Controller
                name="amount"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="third-party-opening">{t("openingLabel")}</FieldLabel>
                    <FieldControl>
                      <AmountField
                        {...field}
                        id="third-party-opening"
                        size="3"
                        inputMode={minorUnitExponent(credit.currency) > 0 ? "decimal" : "numeric"}
                        disabled={isPending}
                      />
                    </FieldControl>
                    <FieldMessage error={fieldState.error} />
                  </Field>
                )}
              />
              <Controller
                name="openedOn"
                control={form.control}
                render={({ field, fieldState }) => (
                  <Field invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="third-party-opened-on">{t("openedOnLabel")}</FieldLabel>
                    <FieldControl>
                      <DateInput {...field} id="third-party-opened-on" size="3" disabled={isPending} />
                    </FieldControl>
                    <FieldMessage error={fieldState.error} />
                  </Field>
                )}
              />
            </Flex>
          )}

          <LenderTermsFields currency={credit.currency} disabled={isPending} />
          <Footer pending={isPending} />
        </FieldGroup>
      </form>
    </FormProvider>
  );
}

/** Renames who pays and sets what the lender asks (RF-211). */
export function EditThirdPartyDialog({
  open,
  onOpenChange,
  credit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  credit: {
    liabilityAccountId: string;
    personName: string;
    installmentCents: number | null;
    dueDay: number | null;
    currency: CurrencyCode;
  };
}) {
  const t = useTranslations("thirdPartyCredit");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t("editTitle")}</Dialog.Title>
        <EditForm credit={credit} onOpenChange={onOpenChange} />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function EditForm({
  credit,
  onOpenChange,
}: {
  credit: React.ComponentProps<typeof EditThirdPartyDialog>["credit"];
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("thirdPartyCredit");
  const onActionError = useActionErrorToast();
  const locale = useLocale() as Locale;

  const form = useForm<UpdateThirdPartyCreditFields, unknown, UpdateThirdPartyCreditInput>({
    resolver: zodResolver(updateThirdPartyCreditSchema),
    defaultValues: {
      liabilityAccountId: credit.liabilityAccountId,
      personName: credit.personName,
      installmentAmount:
        credit.installmentCents === null ? "" : amountToInput(credit.installmentCents, credit.currency, locale),
      dueDay: credit.dueDay === null ? "" : String(credit.dueDay),
    },
  });

  const update = useAction(updateThirdPartyCreditAction, {
    onSuccess() {
      toast.success(t("updated"));
      onOpenChange(false);
    },
    onError: onActionError,
  });
  const isPending = update.isPending;

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(() => update.execute(form.getValues()))} noValidate>
        <FieldGroup>
          <PersonField disabled={isPending} />
          <LenderTermsFields currency={credit.currency} disabled={isPending} />
          <Footer pending={isPending} />
        </FieldGroup>
      </form>
    </FormProvider>
  );
}
