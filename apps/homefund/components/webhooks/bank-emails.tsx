import { useTranslations } from "next-intl";

import { Button, CopyField, Flex, Heading, Link, Text } from "@/components/ui";
import { ACTIVITYWATCH_RELEASES_URL } from "@/lib/android-app";

// RF-192: `oauthLine` is `<client_id> <client_secret>` as aw-timelog takes it, or null when the server has no Google client.
export function BankEmails({
  oauthLine,
  inboundDomain,
  onIssue,
}: {
  oauthLine: string | null;
  // RF-187: the domain a forwarded email is received on; null hides the forwarding way.
  inboundDomain: string | null;
  onIssue: () => void;
}) {
  const t = useTranslations("webhooks.bankEmails");
  const tc = useTranslations("webhooks");
  const tf = useTranslations("webhooks.forwarding");

  return (
    <Flex direction="column" gap="3">
      <Heading as="h2" size="3">{t("heading")}</Heading>
      <Text size="2" color="gray">{t("description")}</Text>
      <Text size="2">1. {t("step1")}</Text>
      <Flex>
        <Link href={ACTIVITYWATCH_RELEASES_URL} target="_blank" rel="noopener noreferrer" size="2">
          {t("step1Link")}
        </Link>
      </Flex>
      <Text size="2">2. {t("step2")}</Text>
      <Text size="2">3. {t("step3")}</Text>
      <Text size="2">4. {t("step4")}</Text>
      <Flex>
        <Button type="button" variant="soft" onClick={onIssue}>
          {t("step4Action")}
        </Button>
      </Flex>
      <Text size="2">5. {t("step5")}</Text>
      <Text size="2">6. {t("step6")}</Text>
      {oauthLine === null ? (
        <Text size="2" color="gray">{t("lineMissing")}</Text>
      ) : (
        <CopyField
          id="gmail-oauth-line"
          label={t("lineLabel")}
          value={oauthLine}
          copyLabel={tc("copy")}
          copiedLabel={tc("copied")}
          failedLabel={tc("copyFailed")}
        />
      )}
      {inboundDomain !== null && (
        <Flex direction="column" gap="3">
          <Heading as="h3" size="3">{tf("heading")}</Heading>
          <Text size="2" color="gray">{tf("description")}</Text>
          <Text size="2">1. {tf("step1")}</Text>
          <Text size="2">2. {tf("step2")}</Text>
          <Text size="2">3. {tf("step3")}</Text>
          <Flex>
            <Button type="button" variant="soft" onClick={onIssue}>
              {tf("create")}
            </Button>
          </Flex>
        </Flex>
      )}
    </Flex>
  );
}
