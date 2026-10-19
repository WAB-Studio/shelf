"use client";

import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { toast } from "sonner";

import { acceptInvitationAction, declineInvitationAction } from "@/app/actions/members";
import { Box, Button, Card, Flex, Heading, Text } from "@/components/ui";
import { useRouter } from "@/i18n/navigation";
import { useActionErrorToast } from "@/lib/use-action-toast";

type Refusal = "gone" | "otherFund";

/**
 * RF-154: «X te invitó · Aceptar / Rechazar». Joining and declining are the invited person's own
 * tap; the card never joins on load. A refusal the server answers (the invitation withdrawn,
 * the person already in another fund) replaces the choice with a card that says so and leaves one
 * way out. A person whose own fund has company is told so on load, before any tap.
 */
export function InvitationCard({
  memberId,
  inviterName,
  fundName,
  currentFundName,
  currentFundHasCompany,
}: {
  memberId: string;
  inviterName: string;
  fundName: string;
  currentFundName: string | null;
  currentFundHasCompany: boolean;
}) {
  const t = useTranslations("members");
  const router = useRouter();
  const onActionError = useActionErrorToast();
  // A lone leader's accept answers otherFund until the engine lets them join; the card shows it too.
  const [refusal, setRefusal] = useState<Refusal | null>(
    currentFundName && currentFundHasCompany ? "otherFund" : null,
  );

  function onError(result: { error: { serverError?: string } }) {
    const key = result.error.serverError;
    if (key === "errors.invitationGone") setRefusal("gone");
    else if (key === "errors.alreadyInFund") setRefusal("otherFund");
    else onActionError(result);
  }

  const accept = useAction(acceptInvitationAction, {
    onSuccess() {
      toast.success(t("invitationAccepted", { fund: fundName }));
    },
    onError,
  });
  const decline = useAction(declineInvitationAction, {
    onSuccess() {
      toast.success(t("invitationDeclined", { inviter: inviterName }));
    },
    onError,
  });
  const busy = accept.isPending || decline.isPending;

  const goAccounts = (
    <Button size="3" onClick={() => router.push("/settings/accounts")}>
      {t("invitationGoAccounts")}
    </Button>
  );

  let content;
  if (refusal === "gone") {
    content = (
      <>
        <Heading as="h1" size="5">{t("invitationGoneTitle")}</Heading>
        <Text size="3">{t("invitationGoneBody", { inviter: inviterName, fund: fundName })}</Text>
        <Flex direction="column">{goAccounts}</Flex>
      </>
    );
  } else if (refusal === "otherFund") {
    content = (
      <>
        <Heading as="h1" size="5">{t("invitationOtherTitle", { other: currentFundName ?? "" })}</Heading>
        <Text size="3">{t("invitationOtherBody", { fund: fundName, other: currentFundName ?? "" })}</Text>
        <Flex direction="column">{goAccounts}</Flex>
      </>
    );
  } else {
    content = (
      <>
        <Heading as="h1" size="5">{t("invitationTitle", { inviter: inviterName, fund: fundName })}</Heading>
        <Text size="3">{t("invitationIfAccept", { fund: fundName })}</Text>
        <Text size="2" color="gray">{t("invitationIfDecline", { inviter: inviterName })}</Text>
        <Flex direction="column" gap="2">
          <Button size="3" disabled={busy} onClick={() => accept.execute({ memberId })}>
            {accept.isPending ? t("invitationAccepting") : t("invitationAccept")}
          </Button>
          <Button size="3" variant="ghost" tap disabled={busy} onClick={() => decline.execute({ memberId })}>
            {t("invitationDecline")}
          </Button>
        </Flex>
      </>
    );
  }

  return (
    <Flex justify="center" p="4">
      <Box width="100%" maxWidth="480px">
        <Card size="3">
          <Flex direction="column" gap="4">
            <Text size="2" weight="bold" color="gray">{t("invitationEyebrow")}</Text>
            {content}
          </Flex>
        </Card>
      </Box>
    </Flex>
  );
}
