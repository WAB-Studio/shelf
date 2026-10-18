"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { unstable_rethrow } from "next/navigation";
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

type SentState = Extract<FormState, { kind: "sent" }>;

// "offline" is the client's own: the call never reached the server.
type SendError = Extract<SendSignInLinkResult, { ok: false }>["error"] | "offline";

type CodeError = VerifySignInCodeResult["error"] | "offlineCheck";

type ResendState = { kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "failed"; error: SendError };

const RESEND_WAIT_MS = 60_000;

type FormState =
  | { kind: "idle" }
  | { kind: "sending" }
  | {
      kind: "sent";
      email: string;
      // When the code on its way was sent; the resend counts its wait from here.
      at: number;
      code: string;
      checking: boolean;
      error?: CodeError;
      resend: ResendState;
    }
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
  const codeField = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(0);
  const resendDone = state.kind === "sent" && state.resend.kind === "done";

  // The countdown reads the clock, so a reload keeps counting from the send.
  const counting = state.kind === "sent";
  useEffect(() => {
    if (!counting) return;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, [counting]);

  // A new code empties the field; the person's next move is typing it.
  useEffect(() => {
    if (resendDone) codeField.current?.focus();
  }, [resendDone]);

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
      if (live && pending) {
        setNow(Date.now());
        setState((current) =>
          current.kind === "idle"
            ? { kind: "sent", email: pending.email, at: pending.at, code: "", checking: false, resend: { kind: "idle" } }
            : current,
        );
      }
    });
    return () => {
      live = false;
    };
  }, []);

  async function handleVerify(current: SentState, code: string): Promise<void> {
    const { email: address, at } = current;
    if (!signInCodeSchema.safeParse(code).success) {
      setState({ ...current, code, checking: false, error: "codeShape" });
      return;
    }
    setState({ ...current, code, checking: true, error: undefined });
    // A good code redirects and never returns; only a refusal comes back.
    verifying.current = true;
    let result: VerifySignInCodeResult | undefined;
    try {
      result = await verifySignInCode(address, code, next);
    } catch (error) {
      // A good code lands through a redirect that rejects here; it is the landing, not a failure.
      unstable_rethrow(error);
      verifying.current = false;
      setState({ kind: "sent", email: address, at, code, checking: false, error: "offlineCheck", resend: { kind: "idle" } });
      return;
    }
    verifying.current = false;
    if (result?.error) setState({ kind: "sent", email: address, at, code, checking: false, error: result.error, resend: { kind: "idle" } });
  }

  async function handleResend(current: SentState): Promise<void> {
    setState({ ...current, resend: { kind: "sending" } });
    let result: SendSignInLinkResult;
    try {
      result = await sendSignInLink(current.email, next);
    } catch {
      setState({ ...current, resend: { kind: "failed", error: "offline" } });
      return;
    }
    if (!result.ok) {
      setState({ ...current, resend: { kind: "failed", error: result.error } });
      return;
    }
    const at = Date.now();
    savePending(current.email, at);
    setNow(at);
    setState({ ...current, at, code: "", error: undefined, resend: { kind: "done" } });
  }

  async function handleSend(): Promise<void> {
    if (!signInEmailSchema.safeParse(email).success) {
      setState({ kind: "failed", error: "emailInvalid" });
      return;
    }
    setState({ kind: "sending" });
    let result: SendSignInLinkResult;
    try {
      result = await sendSignInLink(email, next);
    } catch {
      setState({ kind: "failed", error: "offline" });
      return;
    }
    if (!result.ok) {
      setState({ kind: "failed", error: result.error });
      return;
    }
    const at = Date.now();
    savePending(email, at);
    setNow(at);
    setState({ kind: "sent", email, at, code: "", checking: false, resend: { kind: "idle" } });
  }

  if (state.kind === "sent") {
    const sentState = state;
    const waitLeft = Math.max(0, Math.ceil((state.at + RESEND_WAIT_MS - now) / 1000));
    const resending = state.resend.kind === "sending";
    const busy = state.checking || resending;
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
              void handleVerify(sentState, sentState.code);
            }}
          >
            <Field
              label={t("codeLabel")}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              ref={codeField}
              disabled={resending}
              value={state.code}
              onChange={(event) => setState({ ...state, code: event.target.value, error: undefined })}
              invalid={state.error !== undefined}
              hint={state.error ? t(`errors.${state.error}`) : undefined}
            />
            <Button type="submit" block disabled={busy}>
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
          disabled={busy || waitLeft > 0}
          onClick={() => void handleResend(sentState)}
        >
          {resending ? t("resending") : waitLeft > 0 ? t("resendIn", { seconds: waitLeft }) : t("resend")}
        </Button>
        {state.resend.kind === "done" ? (
          <Text as="p" variant="sentence">
            {t.rich("resent", {
              email: state.email,
              fig: (chunks) => <Figure variant="meta" value={chunks} breakValue />,
            })}
          </Text>
        ) : null}
        {state.resend.kind === "failed" ? (
          <Text as="p" variant="sentence" role="alert">
            {t(`errors.${state.resend.error}`)}
          </Text>
        ) : null}
        <Button
          variant="ghost"
          tone="accent"
          disabled={busy}
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
