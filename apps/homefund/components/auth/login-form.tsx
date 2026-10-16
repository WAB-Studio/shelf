"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useMemo, useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { signInAction } from "@/app/actions/auth";
import {
  Button,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { signInSchema, type SignInInput } from "@/lib/validation/auth";

export function LoginForm({ next }: { next?: string }) {
  const t = useTranslations("auth");

  // The address the link went to, and the whole "sent" state: not a route, so
  // the browser's back button never lands on a stale inbox panel.
  const [sentTo, setSentTo] = useState<string | null>(null);

  const form = useForm({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "" },
  });

  // `next` is a bind argument, not a form field, so it never reaches the schema.
  const signIn = useMemo(() => signInAction.bind(null, next), [next]);

  const { execute, isPending, reset } = useAction(signIn, {
    onSuccess({ input }) {
      setSentTo(input.email);
    },
    onError: useActionErrorToast(),
  });

  function onSubmit(values: SignInInput) {
    execute(values);
  }

  function backToIdle() {
    setSentTo(null);
    reset();
    form.reset();
  }

  // The panel replaces the form, so the submit button that had focus unmounts
  // with it: the live region is what carries the news instead.
  if (sentTo) {
    return (
      <Flex direction="column" gap="4" role="status">
        <Flex direction="column" align="center" gap="2">
          <Text>
            <MailCheckIcon size={24} aria-hidden />
          </Text>
          <Text size="3" weight="medium" asChild>
            <h2>{t("sentTitle")}</h2>
          </Text>
          <Text size="2" color="gray" align="center">
            {t("sentDescription", { email: sentTo })}
          </Text>
          <Text size="2" color="gray" align="center">
            {t("sentHint")}
          </Text>
        </Flex>
        <Button
          type="button"
          variant="outline"
          size={{ initial: "2", md: "3" }}
          onClick={backToIdle}
        >
          {t("useAnotherEmail")}
        </Button>
      </Flex>
    );
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Controller
          name="email"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="login-email">{t("emailLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="login-email"
                  size="3"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoFocus
                  placeholder={t("emailPlaceholder")}
                  disabled={isPending}
                />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />
        <Field>
          <Button
            type="submit"
            size={{ initial: "2", md: "4" }}
            disabled={isPending}
          >
            {isPending && <Spinner />}
            {isPending ? t("sending") : t("sendLink")}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
