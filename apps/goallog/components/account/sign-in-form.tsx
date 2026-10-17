"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import {
  sendSignInLink,
  verifySignInCode,
  type SendSignInLinkResult,
  type VerifySignInCodeResult,
} from "@/app/actions/account";
import { clearPending, readPending, savePending } from "@/lib/auth/pending-sign-in";
import { signInCodeSchema, signInEmailSchema } from "@/lib/validation/sign-in";
import { Button, Field, Figure, Flex, ScreenHeader, Text } from "@/components/ui";

type SendError = Extract<SendSignInLinkResult, { ok: false }>["error"];

type CodeError = VerifySignInCodeResult["error"];

type FormState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string; code: string; checking: boolean; error?: CodeError }
  | { kind: "failed"; error: SendError };

// `EntrarFormulario`, `EntrarCódigo`: the one form that asks for an address and
// then for the six-digit code the mail carries, on `/entrar` and on the consent
// signed out (RP-18, RP-136). The screen gives its own title and lead; the
// fields, the buttons and the refusals are this file's. `next` is where the
// code, or the link beside it, brings the person back to.
export function SignInForm({
  next,
  send,
  title,
  lead,
  notice,
}: {
  next?: string;
  send: string;
  title: string;
  lead: string;
  // Drawn above the field until the person's own next attempt.
  notice?: ReactNode;
}) {
  const t = useTranslations("account");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<FormState>({ kind: "idle" });
  // True from the verify call until a refusal comes back: the form unmounting in between is the code landing.
  const verifying = useRef(false);

  // A good code redirects and the action never returns, so the landing is seen as the form leaving.
  useEffect(
    () => () => {
      if (verifying.current) clearPending();
    },
    [],
  );

  // The step is reopened after a reload, or a relaunch of the installed app, within the code's hour.
  useEffect(() => {
    let live = true;
    queueMicrotask(() => {
      const pending = readPending();
      // Only the untouched form gives way: a person already typing keeps their place.
      if (live && pending) setState((now) => (now.kind === "idle" ? { kind: "sent", email: pending, code: "", checking: false } : now));
    });
    return () => {
      live = false;
    };
  }, []);

  async function handleVerify(address: string, code: string): Promise<void> {
    if (!signInCodeSchema.safeParse(code).success) {
      setState({ kind: "sent", email: address, code, checking: false, error: "codeShape" });
      return;
    }
    setState({ kind: "sent", email: address, code, checking: true });
    // A good code redirects and never returns; only a refusal comes back.
    verifying.current = true;
    const result = await verifySignInCode(address, code, next);
    verifying.current = false;
    if (result?.error) setState({ kind: "sent", email: address, code, checking: false, error: result.error });
  }

  async function handleSend(): Promise<void> {
    if (!signInEmailSchema.safeParse(email).success) {
      setState({ kind: "failed", error: "emailInvalid" });
      return;
    }
    setState({ kind: "sending" });
    const result = await sendSignInLink(email, next);
    if (!result.ok) {
      setState({ kind: "failed", error: result.error });
      return;
    }
    savePending(email);
    setState({ kind: "sent", email, code: "", checking: false });
  }

  if (state.kind === "sent") {
    return (
      <>
        <ScreenHeader
          title={t("sentTitle")}
          eyebrow={t("eyebrow")}
          metaVariant="sentence"
          meta={t.rich("sentBody", {
            email: state.email,
            fig: (chunks) => <Figure variant="meta" value={chunks} breakValue />,
          })}
        />
        <Flex asChild direction="column" gap="20px">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void handleVerify(state.email, state.code);
            }}
          >
            <Field
              label={t("codeLabel")}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              value={state.code}
              onChange={(event) => setState({ ...state, code: event.target.value, error: undefined })}
              invalid={state.error !== undefined}
              hint={state.error ? t(`errors.${state.error}`) : undefined}
            />
            <Button type="submit" block disabled={state.checking}>
              {state.checking ? t("checking") : t("enter")}
            </Button>
          </form>
        </Flex>
        <Text as="p" variant="sentence" tone="muted">
          {t("linkLine")}
        </Text>
        <Button
          variant="ghost"
          tone="accent"
          onClick={() => {
            clearPending();
            setState({ kind: "idle" });
          }}
        >
          {t("sentOther")}
        </Button>
      </>
    );
  }

  return (
    <>
      <ScreenHeader title={title} eyebrow={t("eyebrow")} metaVariant="sentence" meta={lead} />
      {state.kind === "idle" ? notice : null}
      <Flex asChild direction="column" gap="20px">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSend();
          }}
        >
          <Field
            label={t("emailLabel")}
            type="email"
            name="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            invalid={state.kind === "failed"}
            hint={state.kind === "failed" ? t(`errors.${state.error}`) : undefined}
          />
          <Button type="submit" block disabled={state.kind === "sending"}>
            {state.kind === "sending" ? t("sending") : send}
          </Button>
        </form>
      </Flex>
    </>
  );
}
