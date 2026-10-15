"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import { sendSignInLink, type SendSignInLinkResult } from "@/app/actions/account";
import { signInEmailSchema } from "@/lib/validation/sign-in";
import { Button, Field, Figure, Flex, ScreenHeader } from "@/components/ui";

type SendError = Extract<SendSignInLinkResult, { ok: false }>["error"];

type FormState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "failed"; error: SendError };

// `EntrarFormulario`, `EntrarEnviado`: the one form that asks for an address,
// on `/entrar` and on the consent signed out (RP-18). The screen gives its own
// title and lead; the field, the button, the refusal and the line after the
// send are this file's. `next` is where the link brings the person back to.
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

  async function handleSend(): Promise<void> {
    if (!signInEmailSchema.safeParse(email).success) {
      setState({ kind: "failed", error: "emailInvalid" });
      return;
    }
    setState({ kind: "sending" });
    const result = await sendSignInLink(email, next);
    setState(result.ok ? { kind: "sent", email } : { kind: "failed", error: result.error });
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
            fig: (chunks) => <Figure variant="meta" value={chunks} />,
          })}
        />
        <Button variant="ghost" tone="accent" onClick={() => setState({ kind: "idle" })}>
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
