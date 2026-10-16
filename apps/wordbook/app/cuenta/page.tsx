import { getTranslations } from "next-intl/server";

import { getReader } from "@/lib/session";
import { AccountPanel } from "@/components/account/account-panel";
import { AccountTabs, TabBody } from "@/components/account/tab-body";
import { AccountInfo } from "@/components/account/account-info";
import { Flex, Headword, Page, Separator, Text } from "@/components/ui";

// RL-49: `app/auth/confirm/route.ts` sends a failed link here as
// `?error=linkTimeout` (the gateway never answered) or `?error=linkInvalid`
// (the link is genuinely spent or expired). Anything else is no failure.
type LinkFailure = "linkTimeout" | "linkInvalid" | null;

function resolveLinkFailure(raw: string | string[] | undefined): LinkFailure {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "linkTimeout" || value === "linkInvalid" ? value : null;
}

// Server-rendered shell alone, like `/registro`: `getReader()` reads the
// verified claims with no round trip to Postgres, so a signed-out visit
// opens no connection at all — the panel below is the only thing that ever
// calls `/api/devices` or `/api/log/sync`, and only once a reader exists
// (RNL-09). No `useDictionary` here: this screen never resolves a word
// (RNL-08). `measure="full"`: Cuenta is a set of controls, not prose, so it
// takes the width it needs (docs/voyager/DESIGN.md "Viewport").
export default async function CuentaPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[]; error?: string | string[] }>;
}) {
  const t = await getTranslations("account");
  const reader = await getReader();
  const { tab: rawTab, error: rawError } = await searchParams;
  const tab = rawTab === "info" ? "info" : "account";
  const linkFailure = resolveLinkFailure(rawError);

  return (
    <Page measure="full">
      <Flex direction="column" gap="5">
        <Headword>{t("title")}</Headword>

        <AccountTabs />

        {linkFailure && tab === "account" && (
          // No red in this palette (docs/voyager/DESIGN.md "Failure"): a
          // hairline sets the break off, the title in full-weight ink, the
          // reason muted below it. No retry button of its own — the email
          // form right below is the retry.
          <Flex direction="column" gap="3" align="start">
            <Separator size="4" />
            <Text size="2" weight="bold">
              {linkFailure === "linkTimeout" ? t("errors.linkTimeoutTitle") : t("errors.linkInvalidTitle")}
            </Text>
            <Text size="2" muted>
              {linkFailure === "linkTimeout" ? t("errors.linkTimeoutBody") : t("errors.linkInvalidBody")}
            </Text>
          </Flex>
        )}

        <TabBody account={<AccountPanel reader={reader} />} info={<AccountInfo />} />
      </Flex>
    </Page>
  );
}
