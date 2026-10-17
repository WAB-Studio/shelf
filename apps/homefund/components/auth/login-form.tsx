"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Controller, useForm } from "react-hook-form";

import { signInAction, verifyCodeAction } from "@/app/actions/auth";
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
import { clearPending, readPending, writePending } from "@/lib/auth/pending-sign-in";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  signInCodeSchema,
  signInSchema,
  type SignInCodeInput,
  type SignInInput,
} from "@/lib/validation/auth";

const subscribeNothing = () => () => {};

export function LoginForm({ next }: { next?: string }) {
  const t = useTranslations("auth");

  // The address the link went to, and the whole "sent" state: not a route, so
  // the browser's back button never lands on a stale inbox panel.
  const [sent, setSentTo] = useState<string | null>(null);

  // A relaunch opens on the code step while the last send is still fresh. The
  // server render has no storage, so it reads null and the client re-reads.
  const stored = useSyncExternalStore(subscribeNothing, readPending, () => null);
  const sentTo = sent ?? stored;

  const form = useForm({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "" },
  });

  // `next` is a bind argument, not a form field, so it never reaches the schema.
  const signIn = useMemo(() => signInAction.bind(null, next), [next]);

  const { execute, isPending, reset } = useAction(signIn, {
    onSuccess({ input }) {
      writePending(input.email);
      setSentTo(input.email);
    },
    onError: useActionErrorToast(),
  });

  function onSubmit(values: SignInInput) {
    execute(values);
  }

  function backToIdle() {
    clearPending();
    setSentTo(null);
    reset();
    form.reset();
  }

  if (sentTo) {
    return <CodeStep email={sentTo} onBack={backToIdle} />;
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

function CodeStep({ email, onBack }: { email: string; onBack: () => void }) {
  const t = useTranslations("auth");

  // The server's refusal is a catalogue key that lives under the field, not in a toast.
  const [refusal, setRefusal] = useState<string | null>(null);

  const form = useForm({
    resolver: zodResolver(signInCodeSchema),
    defaultValues: { email, code: "" },
  });

  const { execute, isPending } = useAction(verifyCodeAction, {
    onSuccess: clearPending,
    onNavigation: clearPending,
    onError({ error }) {
      setRefusal(error.serverError ?? "errors.unexpected");
    },
  });

  function onSubmit(values: SignInCodeInput) {
    setRefusal(null);
    execute(values);
  }

  // The panel replaces the email form, so the button that had focus unmounts
  // with it: the live region carries the news and the code field takes focus.
  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <Flex direction="column" gap="4">
        <Flex direction="column" align="center" gap="2" role="status">
          <Text>
            <MailCheckIcon size={24} aria-hidden />
          </Text>
          <Text size="3" weight="medium" asChild>
            <h2>{t("sentTitle")}</h2>
          </Text>
          <Text size="2" color="gray" align="center">
            {t("sentDescription", { email })}
          </Text>
        </Flex>
        <Controller
          name="code"
          control={form.control}
          render={({ field, fieldState }) => {
            const message = refusal ? { message: refusal } : fieldState.error;
            return (
              <Field invalid={!!message}>
                <FieldLabel htmlFor="login-code">{t("codeLabel")}</FieldLabel>
                <FieldControl tap>
                  <TextField.Root
                    {...field}
                    onChange={(event) => {
                      setRefusal(null);
                      field.onChange(event);
                    }}
                    id="login-code"
                    size="3"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    autoFocus
                    disabled={isPending}
                  />
                </FieldControl>
                <FieldMessage error={message} />
              </Field>
            );
          }}
        />
        <Button
          tap
          type="submit"
          size={{ initial: "2", md: "4" }}
          disabled={isPending}
        >
          {isPending && <Spinner />}
          {isPending ? t("checking") : t("enter")}
        </Button>
        <Text size="2" color="gray" align="center">
          {t("sentHint")}
        </Text>
        <Button
          tap
          type="button"
          variant="outline"
          size={{ initial: "2", md: "3" }}
          onClick={onBack}
          disabled={isPending}
        >
          {t("useAnotherEmail")}
        </Button>
      </Flex>
    </form>
  );
}
