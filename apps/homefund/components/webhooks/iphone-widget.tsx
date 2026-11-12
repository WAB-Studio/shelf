"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";

import { issueWidgetKeyAction } from "@/app/actions/webhook-credentials";
import { Button, Callout, CopyField, Flex, Heading, Link, Text } from "@/components/ui";
import { useActionErrorToast } from "@/lib/use-action-toast";

const SCRIPTABLE_URL = "https://apps.apple.com/app/scriptable/id1405459188";

// RF-215: the steps to put the Scriptable widget on an iPhone; step 3 mints the key that reads the summary alone.
export function IphoneWidget({ script, scriptUrl }: { script: string; scriptUrl: string }) {
  const t = useTranslations("webhooks");
  const tw = useTranslations("webhooks.widget");
  const [token, setToken] = useState<string | null>(null);
  const onError = useActionErrorToast();
  const issue = useAction(issueWidgetKeyAction, {
    onSuccess: ({ data }) => setToken(data.token),
    onError,
  });

  return (
    <Flex direction="column" gap="3">
      <Heading as="h2" size="3">{tw("heading")}</Heading>
      <Text size="2" color="gray">{tw("description")}</Text>

      <Text size="2">1. {tw("step1")}</Text>
      <Flex>
        <Link href={SCRIPTABLE_URL} target="_blank" rel="noopener noreferrer" size="2">
          {tw("step1Link")}
        </Link>
      </Flex>

      <Text size="2">2. {tw("step2")}</Text>
      <CopyField
        id="widget-script"
        label={tw("scriptLabel")}
        value={script}
        copyLabel={t("copy")}
        copiedLabel={t("copied")}
        failedLabel={t("copyFailed")}
        multiline
      />
      <CopyField
        id="widget-script-url"
        label={tw("scriptUrlLabel")}
        value={scriptUrl}
        copyLabel={t("copy")}
        copiedLabel={t("copied")}
        failedLabel={t("copyFailed")}
      />

      <Text size="2">3. {tw("step3")}</Text>
      {token === null ? (
        <Flex>
          <Button type="button" loading={issue.isPending} onClick={() => issue.execute({})}>
            {tw("issue")}
          </Button>
        </Flex>
      ) : (
        <Flex direction="column" gap="3">
          <Callout.Root color="amber" variant="soft">
            <Callout.Icon>
              <TriangleAlert size={16} />
            </Callout.Icon>
            <Callout.Text>{t("tokenWarning")}</Callout.Text>
          </Callout.Root>
          <CopyField
            id="widget-token"
            label={tw("keyLabel")}
            value={token}
            copyLabel={t("copy")}
            copiedLabel={t("copied")}
            failedLabel={t("copyFailed")}
            tone="secret"
          />
        </Flex>
      )}

      <Text size="2">4. {tw("step4")}</Text>
      <Text size="2">5. {tw("step5")}</Text>
      <Text size="2">6. {tw("step6")}</Text>
      <Text size="2" color="gray">{tw("result")}</Text>
    </Flex>
  );
}
