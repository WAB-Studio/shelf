"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";

import { issueClaudeKeyAction } from "@/app/actions/webhook-credentials";
import { Button, Callout, CopyField, Flex } from "@/components/ui";
import { useActionErrorToast } from "@/lib/use-action-toast";

// RF-144: mints a key that opens /mcp alone and shows it once, under the address it is used with.
export function ClaudeKey() {
  const t = useTranslations("webhooks");
  const [token, setToken] = useState<string | null>(null);
  const onError = useActionErrorToast();
  const issue = useAction(issueClaudeKeyAction, {
    onSuccess: ({ data }) => setToken(data.token),
    onError,
  });

  if (token === null) {
    return (
      <Flex>
        <Button type="button" loading={issue.isPending} onClick={() => issue.execute({})}>
          {t("mcpIssue")}
        </Button>
      </Flex>
    );
  }
  return (
    <Flex direction="column" gap="3">
      <Callout.Root color="amber" variant="soft">
        <Callout.Icon>
          <TriangleAlert size={16} />
        </Callout.Icon>
        <Callout.Text>{t("tokenWarning")}</Callout.Text>
      </Callout.Root>
      <CopyField
        id="mcp-token"
        label={t("tokenLabel")}
        value={token}
        copyLabel={t("copy")}
        copiedLabel={t("copied")}
        failedLabel={t("copyFailed")}
        tone="secret"
      />
    </Flex>
  );
}
