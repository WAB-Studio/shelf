"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { approveAuthorization, denyAuthorization } from "@/app/actions/oauth";
import { Button, Notice, Page, ScreenHeader, Text } from "@/components/ui";
import type { AuthorizationRequest } from "@/lib/validation/oauth";

import { returnHost } from "@/lib/oauth/return-host";

import { ConsentList } from "./consent-list";
import { type MessageKey } from "@/i18n/translator";

const MAY = ["read", "done", "write", "rename", "phases", "plan", "measure"] as const;
const NEVER = ["delete", "undo"] as const;

export function Consent({
  client,
  email,
  request,
}: {
  client: string;
  email: string;
  request: AuthorizationRequest;
}) {
  const t = useTranslations("oauth");
  const root = useTranslations();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  async function answer(act: typeof approveAuthorization): Promise<void> {
    setWorking(true);
    setError(null);
    const result = await act(request);
    if (!result.ok) {
      setError(result.error);
      setWorking(false);
      return;
    }
    // Leaves the app: the client's own address, never a route of this one.
    window.location.assign(result.redirectTo);
  }

  return (
    <Page alone middle snug>
      <ScreenHeader
        title={t("title", { client })}
        eyebrow={t("eyebrow")}
        lead={t.rich("returnsTo", { address: returnHost(request.redirect_uri), host: (chunks) => <strong>{chunks}</strong> })}
        metaVariant="sentence"
        meta={t("consentLead")}
      />
      <ConsentList label={t("mayLabel")} items={MAY.map((key) => t(`may.${key}`))} mark="+" />
      <ConsentList label={t("neverLabel")} items={NEVER.map((key) => t(`never.${key}`))} mark="–" tone="muted" />
      {error ? <Notice role="alert">{root(error)}</Notice> : null}
      <Button tap={52} block disabled={working} onClick={() => void answer(approveAuthorization)}>
        {working ? t("working") : t("allow")}
      </Button>
      <Button variant="outline" tap={52} block disabled={working} onClick={() => void answer(denyAuthorization)}>
        {t("deny")}
      </Button>
      <Text as="p" variant="sentence" tone="muted">
        {t("footer", { email })}
      </Text>
    </Page>
  );
}
