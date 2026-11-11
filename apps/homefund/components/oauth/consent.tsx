"use client";

import { Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";

import { approveAuthorizationAction, denyAuthorizationAction } from "@/app/actions/oauth";
import { AppMark, Button, Card, Flex, Heading, Text } from "@/components/ui";
import { returnHost } from "@/lib/oauth/return-host";
import { useActionErrorToast } from "@/lib/use-action-toast";
import type { AuthorizationRequest } from "@/lib/validation/oauth";

const MAY = ["accounts", "review", "import"] as const;

export function Consent({ client, email, request }: { client: string; email: string; request: AuthorizationRequest }) {
  const t = useTranslations("oauth");
  const onError = useActionErrorToast();
  // Leaves the app: the client's own address, never a route of this one.
  const onSuccess = ({ data }: { data: { redirectTo: string } }) => window.location.assign(data.redirectTo);
  const approve = useAction(approveAuthorizationAction, { onSuccess, onError });
  const deny = useAction(denyAuthorizationAction, { onSuccess, onError });
  const working = approve.isPending || approve.hasSucceeded || deny.isPending || deny.hasSucceeded;

  return (
    <Flex asChild direction="column" flexGrow="1" align="center" justify="center" p="4">
      <main>
        <Flex direction="column" gap="4" width="100%" maxWidth="28rem">
          <AppMark size={56} />
          <Flex direction="column" gap="2">
            <Heading size="6">{t("heading", { client })}</Heading>
            <Text color="gray">
              {t.rich("returnsTo", {
                address: returnHost(request.redirect_uri),
                host: (chunks) => <strong>{chunks}</strong>,
              })}
            </Text>
          </Flex>
          <Card>
            <Flex direction="column" gap="2">
              <Text weight="medium">{t("mayLabel")}</Text>
              {MAY.map((key) => (
                <Flex key={key} gap="2" align="center">
                  <Check size={16} aria-hidden />
                  <Text size="2">{t(`may.${key}`)}</Text>
                </Flex>
              ))}
              <Text weight="medium">{t("neverLabel")}</Text>
              <Flex gap="2" align="center">
                <X size={16} aria-hidden />
                <Text size="2" color="gray">
                  {t("never.delete")}
                </Text>
              </Flex>
            </Flex>
          </Card>
          <Button size="3" disabled={working} loading={approve.isPending} onClick={() => approve.execute(request)}>
            {t("allow")}
          </Button>
          <Button size="3" variant="outline" disabled={working} loading={deny.isPending} onClick={() => deny.execute(request)}>
            {t("deny")}
          </Button>
          <Text size="2" color="gray">
            {t("footer", { email })}
          </Text>
        </Flex>
      </main>
    </Flex>
  );
}
