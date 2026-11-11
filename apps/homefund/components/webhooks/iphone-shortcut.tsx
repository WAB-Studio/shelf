import { useTranslations } from "next-intl";

import { CopyField, Flex, Heading, Text } from "@/components/ui";

const EXPENSE_STEPS = [
  "expenseStep1",
  "expenseStep2",
  "expenseStep3",
  "expenseStep4",
  "expenseStep5",
  "expenseStep6",
] as const;

const SMS_STEPS = ["smsStep1", "smsStep2", "smsStep3"] as const;

// RF-186: the steps name the Shortcuts actions as iOS labels them in the person's language.
export function IphoneShortcut({ ingestUrl }: { ingestUrl: string }) {
  const t = useTranslations("webhooks.iphone");
  const tCopy = useTranslations("webhooks");

  return (
    <Flex direction="column" gap="4">
      <Heading as="h2" size="3">{t("heading")}</Heading>
      <Text size="2" color="gray">{t("description")}</Text>
      <CopyField
        id="iphone-shortcut-url"
        label={tCopy("endpointUrlLabel")}
        value={ingestUrl}
        copyLabel={tCopy("copy")}
        copiedLabel={tCopy("copied")}
        failedLabel={tCopy("copyFailed")}
      />
      <Flex direction="column" gap="2">
        <Heading as="h3" size="2">{t("expenseHeading")}</Heading>
        {EXPENSE_STEPS.map((key) => (
          <Text key={key} size="2">{t(key)}</Text>
        ))}
      </Flex>
      <Flex direction="column" gap="2">
        <Heading as="h3" size="2">{t("smsHeading")}</Heading>
        {SMS_STEPS.map((key) => (
          <Text key={key} size="2">{t(key)}</Text>
        ))}
      </Flex>
      <Text size="2" color="gray">{t("result")}</Text>
    </Flex>
  );
}
