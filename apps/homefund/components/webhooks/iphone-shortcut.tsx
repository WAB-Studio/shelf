import { useTranslations } from "next-intl";

import { Flex, Heading, Text } from "@/components/ui";

const STEP_COUNTS = { expense: 6, sms: 3 } as const;

// RF-186: the steps name the Shortcuts actions as iOS labels them in the person's language.
export function IphoneShortcut() {
  const t = useTranslations("webhooks.iphone");

  return (
    <Flex direction="column" gap="4">
      <Heading as="h2" size="3">{t("heading")}</Heading>
      <Text size="2" color="gray">{t("description")}</Text>
      {(["expense", "sms"] as const).map((list) => (
        <Flex key={list} direction="column" gap="2">
          <Heading as="h3" size="2">{t(`${list}Heading`)}</Heading>
          {Array.from({ length: STEP_COUNTS[list] }, (_, i) => i + 1).map((step) => (
            <Text key={step} size="2">
              {step}. {t(`${list}Step${step}` as "expenseStep1")}
            </Text>
          ))}
        </Flex>
      ))}
      <Text size="2" color="gray">{t("result")}</Text>
    </Flex>
  );
}
