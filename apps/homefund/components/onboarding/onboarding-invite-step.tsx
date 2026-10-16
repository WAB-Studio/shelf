"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { createMemberAction } from "@/app/actions/members";
import { MemberFormDialog } from "@/components/members/member-form-dialog";
import {
  Badge,
  Box,
  Button,
  Card,
  Field,
  FieldControl,
  FieldMessage,
  Flex,
  Link,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import type { MemberRow } from "@/db/queries/group-members";
import { Link as LocaleLink } from "@/i18n/navigation";
import { useActionErrorToast } from "@/lib/use-action-toast";

// The email is the only field a person types; the member's provisional name is
// derived from it on submit (renameable later), so the form validates just the
// address against the same email rule the server re-runs (RF-07).
const inviteFormSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, { error: "members.errors.emailInvalid" })
    .pipe(z.email({ error: "members.errors.emailInvalid" })),
});

type InviteFormValues = z.infer<typeof inviteFormSchema>;

// The roster is the server's `members` prop: `createMemberAction` calls
// `refresh()`, so a new member re-renders here without any client copy.
export function OnboardingInviteStep({
  members,
  currentUserId,
}: {
  members: MemberRow[];
  currentUserId: string;
}) {
  const t = useTranslations("onboarding.inviteStep");

  // The name-only path reuses the members dialog; the flow has no edit path.
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <Flex direction="column" gap="4">
      <InviteByEmailForm />

      <Button
        type="button"
        variant="soft"
        size={{ initial: "2", md: "3" }}
        onClick={() => setDialogOpen(true)}
      >
        <Plus size={16} />
        {t("addWithoutEmail")}
      </Button>

      {members.length > 0 && (
        <Flex direction="column" gap="2">
          {members.map((member) => (
            <RosterCard
              key={member.id}
              member={member}
              currentUserId={currentUserId}
            />
          ))}
        </Flex>
      )}

      <Flex direction="column" gap="3" pt="2">
        <Button asChild size={{ initial: "3", md: "4" }}>
          <LocaleLink href="/">{t("toDashboard")}</LocaleLink>
        </Button>
        <Flex justify="center">
          <Link asChild size="2" color="gray" weight="medium">
            <LocaleLink href="/">{t("skip")}</LocaleLink>
          </Link>
        </Flex>
      </Flex>

      <MemberFormDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </Flex>
  );
}

function InviteByEmailForm() {
  const t = useTranslations("onboarding.inviteStep");
  const tMembers = useTranslations("members");

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(inviteFormSchema),
    defaultValues: { email: "" },
  });

  const { execute, isPending } = useAction(createMemberAction, {
    onSuccess({ data }) {
      toast.success(tMembers("created"));
      // A failed send still lands the member as pending; surface it, don't fail.
      if (data?.inviteEmailFailed) toast.warning(t("emailFailed"));
      form.reset();
    },
    onError: useActionErrorToast(),
  });

  function onSubmit({ email }: InviteFormValues) {
    // Provisional name = the invited address until they rename it in settings.
    execute({ name: email, email });
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <Controller
        name="email"
        control={form.control}
        render={({ field, fieldState }) => (
          <Field invalid={fieldState.invalid}>
            <Flex align="start" gap="2">
              <Box flexGrow="1">
                <FieldControl>
                  <TextField.Root
                    {...field}
                    id="invite-email"
                    type="email"
                    size="3"
                    autoComplete="off"
                    placeholder={t("emailPlaceholder")}
                    disabled={isPending}
                  />
                </FieldControl>
              </Box>
              <Button
                type="submit"
                size={{ initial: "3", md: "4" }}
                disabled={isPending}
              >
                {isPending && <Spinner />}
                {t("sendInvite")}
              </Button>
            </Flex>
            <FieldMessage error={fieldState.error} />
          </Field>
        )}
      />
    </form>
  );
}

function RosterCard({
  member,
  currentUserId,
}: {
  member: MemberRow;
  currentUserId: string;
}) {
  const t = useTranslations("members");
  const isSelf = member.userId === currentUserId;
  const isPending = member.userId === null && member.inviteEmail !== null;

  return (
    <Card>
      <Flex align="center" gap="3">
        <Flex
          align="center"
          justify="center"
          flexShrink="0"
          style={{
            width: 36,
            height: 36,
            borderRadius: 999,
            fontSize: 15,
            fontWeight: 700,
            backgroundColor: "var(--accent-9)",
            color: "var(--accent-contrast)",
          }}
        >
          {member.name.charAt(0).toUpperCase()}
        </Flex>
        <Text weight="medium" truncate style={{ flexGrow: 1, minWidth: 0 }}>
          {member.name}
        </Text>
        <Flex align="center" gap="2" flexShrink="0">
          {member.role === "leader" && (
            <Badge color="blue">{t("ownerBadge")}</Badge>
          )}
          {isSelf && <Badge>{t("you")}</Badge>}
          {isPending && <Badge color="amber">{t("pendingBadge")}</Badge>}
        </Flex>
      </Flex>
    </Card>
  );
}
