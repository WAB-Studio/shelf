"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { Page, Separator, Text } from "@/components/ui";

import { SignInForm } from "./sign-in-form";

// The two ways `/auth/confirm` sends a person back here (RP-18): a timeout
// answering the link and a link already spent or malformed. Anything else in
// `?error=` is not this contract's and is read as no error at all.
const LINK_ERRORS = ["linkTimeout", "linkInvalid"] as const;
type LinkError = (typeof LINK_ERRORS)[number];

function readLinkError(value: string | null): LinkError | null {
  return value !== null && (LINK_ERRORS as readonly string[]).includes(value) ? (value as LinkError) : null;
}

// No red anywhere in this palette (docs/pulsar/DESIGN.md): a failed link sets
// its break off with a hairline and says it in full-weight ink, never a colour.
function FailureNotice({ title, body }: { title: string; body?: string }) {
  return (
    <>
      <Separator />
      <Text as="p" weight="medium">
        {title}
      </Text>
      {body ? (
        <Text as="p" variant="sentence" tone="muted">
          {body}
        </Text>
      ) : null}
    </>
  );
}

function EntrarForm() {
  const t = useTranslations("account");
  const params = useSearchParams();
  const linkError = readLinkError(params.get("error"));
  const next = params.get("next") ?? undefined;

  return (
    <Page alone middle>
      <SignInForm
        next={next}
        send={t("action")}
        title={t("title")}
        lead={t("lead")}
        notice={
          linkError ? <FailureNotice title={t(`errors.${linkError}Title`)} body={t(`errors.${linkError}Body`)} /> : null
        }
      />
    </Page>
  );
}

export function EntrarScreen() {
  return (
    <Suspense fallback={null}>
      <EntrarForm />
    </Suspense>
  );
}
