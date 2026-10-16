"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Info } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm } from "react-hook-form";

import { createGroupAction } from "@/app/actions/fund";
import {
  Button,
  Callout,
  Card,
  Field,
  FieldControl,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  SegmentedControl,
  Spinner,
  TextField,
} from "@/components/ui";
import { BASE_CURRENCY, OFFERED_CURRENCIES } from "@/lib/currency";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { createFundSchema, type CreateFundInput } from "@/lib/validation/fund";

export function CreateFundForm() {
  const t = useTranslations("onboarding");
  const tFund = useTranslations("fund");

  const form = useForm<CreateFundInput>({
    resolver: zodResolver(createFundSchema),
    defaultValues: { name: "", memberName: "", currency: BASE_CURRENCY },
  });

  const { execute, isPending } = useAction(createGroupAction, {
    onError: useActionErrorToast(),
  });

  function onSubmit(values: CreateFundInput) {
    execute(values);
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <Flex direction="column" gap="4">
        <Card size={{ initial: "2", md: "3" }}>
          <FieldGroup>
            <Controller
              name="name"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="fund-name">
                    {t("fundNameLabel")}
                  </FieldLabel>
                  <FieldControl>
                    <TextField.Root
                      {...field}
                      id="fund-name"
                      size="3"
                      autoFocus
                      autoComplete="off"
                      placeholder={t("fundNamePlaceholder")}
                      disabled={isPending}
                    />
                  </FieldControl>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />
            <Controller
              name="memberName"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="member-name">
                    {t("memberNameLabel")}
                  </FieldLabel>
                  <FieldControl>
                    <TextField.Root
                      {...field}
                      id="member-name"
                      size="3"
                      autoComplete="name"
                      disabled={isPending}
                    />
                  </FieldControl>
                  <FieldDescription>
                    {t("memberNameDescription")}
                  </FieldDescription>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />
            <Controller
              name="currency"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel id="fund-currency-label">
                    {tFund("currencyLabel")}
                  </FieldLabel>
                  <FieldControl>
                    <SegmentedControl.Root
                      size="3"
                      value={field.value}
                      onValueChange={field.onChange}
                      aria-labelledby="fund-currency-label"
                    >
                      {OFFERED_CURRENCIES.map((code) => (
                        <SegmentedControl.Item key={code} value={code}>
                          {code}
                        </SegmentedControl.Item>
                      ))}
                    </SegmentedControl.Root>
                  </FieldControl>
                  <FieldMessage error={fieldState.error} />
                </Field>
              )}
            />
          </FieldGroup>
        </Card>

        <Callout.Root color="jade" variant="soft">
          <Callout.Icon>
            <Info size={16} aria-hidden />
          </Callout.Icon>
          <Callout.Text>{t("seedNote")}</Callout.Text>
        </Callout.Root>

        <Field>
          <Button
            type="submit"
            size={{ initial: "3", md: "4" }}
            disabled={isPending}
          >
            {isPending && <Spinner />}
            {isPending ? t("submitting") : t("continue")}
          </Button>
        </Field>
      </Flex>
    </form>
  );
}
