"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { sendSignInLink, type SignInResult } from "@/app/actions/sign-in";
import { Button, Field, Form, Stack, Text } from "@/components/ui";
import { signInEmailSchema } from "@/lib/forms";

// RT-08: an address, one link.
export function SignInForm({ linkError }: { linkError: boolean }) {
  const t = useTranslations("time.signIn");
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<SignInResult | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!signInEmailSchema.safeParse(email).success) {
      setResult({ ok: false, error: "emailInvalid" });
      return;
    }
    startTransition(async () => setResult(await sendSignInLink(email)));
  }

  return (
    <Stack gap={3}>
      <Text as="p" variant="meta">{t("intro")}</Text>
      {linkError && result === null ? <Text as="p">{t("linkInvalid")}</Text> : null}
      <Form onSubmit={submit}>
        <Field type="email" autoComplete="email" label={t("email")} value={email} onChange={(event) => setEmail(event.target.value)} required />
        <Button type="submit" disabled={pending}>
          {pending ? t("sending") : t("send")}
        </Button>
      </Form>
      {result === null ? null : <Text as="p">{result.ok ? t("sent") : t(result.error)}</Text>}
    </Stack>
  );
}
