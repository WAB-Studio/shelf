"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { MailCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
import {
  clearPending,
  readPending,
  RESEND_WAIT_MS,
  writePending,
} from "@/lib/auth/pending-sign-in";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  signInCodeSchema,
  signInSchema,
  type SignInCodeInput,
  type SignInInput,
} from "@/lib/validation/auth";

const subscribeNothing = () => () => {};

// The snapshot must be a stable value, so the record travels as its JSON text.
const readPendingText = () => JSON.stringify(readPending());

type Sent = { email: string; sentAt: number; resent: boolean };

export function LoginForm({ next }: { next?: string }) {
  const t = useTranslations("auth");

  // The address the link went to, and the whole "sent" state: not a route, so
  // the browser's back button never lands on a stale inbox panel.
  const [sent, setSentTo] = useState<Sent | null>(null);

  // A relaunch opens on the code step while the last send is still fresh. The
  // server render has no storage, so it reads null and the client re-reads.
  const storedText = useSyncExternalStore(subscribeNothing, readPendingText, () => "null");
  const stored = useMemo(
    () => (JSON.parse(storedText) as { email: string; sentAt: number } | null),
    [storedText],
  );
  const sentTo = sent ?? (stored && { ...stored, resent: false });

  const form = useForm({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: "" },
  });

  // `next` is a bind argument, not a form field, so it never reaches the schema.
  const signIn = useMemo(() => signInAction.bind(null, next), [next]);

  const { execute, isPending, reset } = useAction(signIn, {
    onSuccess({ input }) {
      writePending(input.email);
      setSentTo({ email: input.email, sentAt: Date.now(), resent: false });
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
    // Keyed by the send, so a new code remounts the step: empty field, focus, a fresh countdown.
    return (
      <CodeStep
        key={sentTo.sentAt}
        email={sentTo.email}
        sentAt={sentTo.sentAt}
        resent={sentTo.resent}
        next={next}
        onResent={(sentAt) => setSentTo({ email: sentTo.email, sentAt, resent: true })}
        onBack={backToIdle}
      />
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

function CodeStep({
  email,
  sentAt,
  resent,
  next,
  onResent,
  onBack,
}: {
  email: string;
  sentAt: number;
  resent: boolean;
  next?: string;
  onResent: (sentAt: number) => void;
  onBack: () => void;
}) {
  const t = useTranslations("auth");

  const [now, setNow] = useState(() => Date.now());
  const remaining = Math.max(0, Math.ceil((sentAt + RESEND_WAIT_MS - now) / 1000));
  const waiting = remaining > 0;
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [waiting]);

  const signIn = useMemo(() => signInAction.bind(null, next), [next]);
  const { execute: resend, isPending: isResending } = useAction(signIn, {
    onSuccess({ input }) {
      writePending(input.email);
      onResent(Date.now());
    },
    onError: useActionErrorToast(),
  });

  // The server's refusal is a catalogue key that lives under the field, not in a toast.
  const [refusal, setRefusal] = useState<string | null>(null);

  const form = useForm({
    resolver: zodResolver(signInCodeSchema),
    defaultValues: { email, code: "" },
  });

  const { execute, isPending: isChecking } = useAction(verifyCodeAction, {
    onSuccess: clearPending,
    onNavigation: clearPending,
    onError({ error }) {
      setRefusal(error.serverError ?? "errors.unexpected");
    },
  });

  const busy = isChecking || isResending;

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
        {resent && (
          <Text size="2" align="center" role="status">
            {t("resent", { email })}
          </Text>
        )}
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
                    disabled={busy}
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
          disabled={busy}
        >
          {isChecking && <Spinner />}
          {isChecking ? t("checking") : t("enter")}
        </Button>
        <Text size="2" color="gray" align="center">
          {t("sentHint")}
        </Text>
        <Button
          tap
          type="button"
          variant="soft"
          size={{ initial: "2", md: "3" }}
          onClick={() => resend({ email })}
          disabled={busy || waiting}
        >
          {isResending && <Spinner />}
          {isResending
            ? t("resending")
            : remaining > 0
              ? t("resendIn", { seconds: remaining })
              : t("resend")}
        </Button>
        <Button
          tap
          type="button"
          variant="outline"
          size={{ initial: "2", md: "3" }}
          onClick={onBack}
          disabled={busy}
        >
          {t("useAnotherEmail")}
        </Button>
      </Flex>
    </form>
  );
}
