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

// "offline" and "timedOut" are the client's own: the call never reached the server, or it gave no answer in time.
type SendError = Extract<SendSignInLinkResult, { ok: false }>["error"] | "offline" | "timedOut";

type CodeError = VerifySignInCodeResult["error"] | "offlineCheck" | "timedOutCheck";

type ResendState = { kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "failed"; error: SendError };

const RESEND_WAIT_MS = 60_000;
const ANSWER_TIMEOUT_MS = 8_000;
const TIMED_OUT = "timedOut" as const;

// Settles with the call, or with TIMED_OUT when it gives no answer in time. The call itself is left running.
function answerWithin<T>(call: Promise<T>): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ANSWER_TIMEOUT_MS);
    call.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
  // Verify calls not yet refused, timed out or not: the form unmounting while any runs is the code landing.
  const verifying = useRef(0);
  // Tags each send, resend and check; an answer that comes late applies only to the newest.
  const attempt = useRef(0);
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
      if (verifying.current > 0) clearPending();
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
    attempt.current += 1;
    setState({ ...current, code, checking: true, error: undefined });
    // A good code redirects and never returns; only a refusal comes back.
    verifying.current += 1;
    const call = verifySignInCode(address, code, next);
    let result: VerifySignInCodeResult | typeof TIMED_OUT | undefined;
    try {
      result = await answerWithin(call);
    } catch (error) {
      // A good code lands through a redirect that rejects here; it is the landing, not a failure.
      unstable_rethrow(error);
      verifying.current -= 1;
      setState({ kind: "sent", email: address, at, code, checking: false, error: "offlineCheck", resend: { kind: "idle" } });
      return;
    }
    if (result === TIMED_OUT) {
      // The call still runs: a good code lands by its own redirect, a late refusal is dropped.
      call.then(
        () => {
          verifying.current -= 1;
        },
        (error: unknown) => {
          try {
            unstable_rethrow(error);
          } catch {
            return;
          }
          verifying.current -= 1;
        },
      );
      setState({ kind: "sent", email: address, at, code, checking: false, error: "timedOutCheck", resend: { kind: "idle" } });
      return;
    }
    verifying.current -= 1;
    if (result?.error) setState({ kind: "sent", email: address, at, code, checking: false, error: result.error, resend: { kind: "idle" } });
  }

  async function handleResend(current: SentState): Promise<void> {
    const mine = (attempt.current += 1);
    setState({ ...current, resend: { kind: "sending" } });
    const call = sendSignInLink(current.email, next);
    let result: SendSignInLinkResult | typeof TIMED_OUT;
    try {
      result = await answerWithin(call);
    } catch (error) {
      unstable_rethrow(error);
      setState({ ...current, resend: { kind: "failed", error: "offline" } });
      return;
    }
    if (result === TIMED_OUT) {
      call.then(
        (late) => {
          if (!late.ok || mine !== attempt.current) return;
          const sentAt = Date.now();
          savePending(current.email, sentAt);
          setNow(sentAt);
          // Only the timeout sentence gives way, and the code typed since stays.
          setState((cur) =>
            cur.kind === "sent" && cur.resend.kind === "failed" && cur.resend.error === "timedOut"
              ? { ...cur, at: sentAt, error: undefined, resend: { kind: "done" } }
              : cur,
          );
        },
        () => {},
      );
      setState({ ...current, resend: { kind: "failed", error: "timedOut" } });
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
    const mine = (attempt.current += 1);
    const address = email;
    setState({ kind: "sending" });
    const call = sendSignInLink(address, next);
    let result: SendSignInLinkResult | typeof TIMED_OUT;
    try {
      result = await answerWithin(call);
    } catch (error) {
      unstable_rethrow(error);
      setState({ kind: "failed", error: "offline" });
      return;
    }
    if (result === TIMED_OUT) {
      call.then(
        (late) => {
          if (!late.ok || mine !== attempt.current) return;
          const sentAt = Date.now();
          savePending(address, sentAt);
          setNow(sentAt);
          setState((cur) =>
            cur.kind === "failed" && cur.error === "timedOut"
              ? { kind: "sent", email: address, at: sentAt, code: "", checking: false, resend: { kind: "idle" } }
              : cur,
          );
        },
        () => {},
      );
      setState({ kind: "failed", error: "timedOut" });
      return;
    }
    if (!result.ok) {
      setState({ kind: "failed", error: result.error });
      return;
    }
    const at = Date.now();
    savePending(address, at);
    setNow(at);
    setState({ kind: "sent", email: address, at, code: "", checking: false, resend: { kind: "idle" } });
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
            attempt.current += 1;
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
