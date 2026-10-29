"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";

import { updateGroupAction } from "@/app/actions/groups";
import { leaveFundAction } from "@/app/actions/members";
import {
  Box,
  Button,
  Card,
  ConfirmDialog,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Heading,
  ScreenHeader,
  SegmentedControl,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import { useRouter } from "@/i18n/navigation";
import { OFFERED_CURRENCIES } from "@/lib/currency";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { updateGroupSchema, type UpdateGroupInput } from "@/lib/validation/group";

/**
 * The group's own settings (RF-56, RF-57, RF-121). Name, cash mode and
 * currency leave together: the write is one statement over all three columns,
 * so the screen offers one save. A plain member gets the three values as
 * text — RF-57 makes the configuration the leader's, and the action's refusal
 * is the second lock, never the only one.
 */
export function GroupSettingsScreen({
  groupName,
  cashMode,
  currency,
  isLeader,
  hasCompany,
}: {
  groupName: string;
  cashMode: UpdateGroupInput["cashMode"];
  currency: UpdateGroupInput["currency"];
  isLeader: boolean;
  hasCompany: boolean;
}) {
  const t = useTranslations("group");
  const tCommon = useTranslations("common");
  const tNav = useTranslations("nav");
  const router = useRouter();
  const [asking, setAsking] = useState(false);

  const form = useForm({
    resolver: zodResolver(updateGroupSchema),
    defaultValues: { name: groupName, cashMode, currency },
  });

  const { execute, isPending } = useAction(updateGroupAction, {
    onSuccess() {
      toast.success(t("saved"));
    },
    onError: useActionErrorToast(),
  });

  // The leader's refusal is decided on load (no write is tried); the server's `leaderStays` is
  // the second lock for a roster that changed since.
  const leave = useAction(leaveFundAction, {
    onSuccess() {
      toast.success(t("leaveDone", { fund: groupName }), {
        description: t("leaveDoneBody"),
      });
      router.push("/");
    },
    onError: useActionErrorToast(),
  });
  const refused = isLeader && hasCompany;
  // A leader alone hands the fund over to no one and is not offered leaving.
  const offered = !isLeader || hasCompany;

  function onSubmit(values: UpdateGroupInput) {
    execute(values);
  }

  return (
    <Flex direction="column" gap="4">
      <ScreenHeader
        title={t("title")}
        back={{ href: "/settings", label: tNav("settings") }}
      />

      {isLeader ? (
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <Flex direction="column" gap="4">
            <Card size="2">
              <FieldGroup>
                <Controller
                  name="name"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field invalid={fieldState.invalid}>
                      <FieldLabel htmlFor="group-name">
                        {t("nameLabel")}
                      </FieldLabel>
                      <FieldControl>
                        <TextField.Root
                          {...field}
                          id="group-name"
                          size="3"
                          autoComplete="off"
                          disabled={isPending}
                        />
                      </FieldControl>
                      <FieldMessage error={fieldState.error} />
                    </Field>
                  )}
                />
                <Controller
                  name="cashMode"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field invalid={fieldState.invalid}>
                      <FieldLabel id="group-cash-mode-label">
                        {t("cashModeLabel")}
                      </FieldLabel>
                      <FieldControl>
                        <SegmentedControl.Root
                          size="3"
                          value={field.value}
                          onValueChange={field.onChange}
                          aria-labelledby="group-cash-mode-label"
                        >
                          <SegmentedControl.Item value="shared">
                            {t("cashModeShared")}
                          </SegmentedControl.Item>
                          <SegmentedControl.Item value="per_member">
                            {t("cashModePerMember")}
                          </SegmentedControl.Item>
                        </SegmentedControl.Root>
                      </FieldControl>
                      <FieldMessage error={fieldState.error} />
                    </Field>
                  )}
                />
                <Controller
                  name="currency"
                  control={form.control}
                  render={({ field, fieldState }) => (
                    <Field invalid={fieldState.invalid}>
                      <FieldLabel id="group-currency-label">
                        {t("currencyLabel")}
                      </FieldLabel>
                      <FieldControl>
                        <SegmentedControl.Root
                          size="3"
                          value={field.value}
                          onValueChange={field.onChange}
                          aria-labelledby="group-currency-label"
                        >
                          {OFFERED_CURRENCIES.map((code) => (
                            <SegmentedControl.Item key={code} value={code}>
                              {code}
                            </SegmentedControl.Item>
                          ))}
                        </SegmentedControl.Root>
                      </FieldControl>
                      <FieldMessage error={fieldState.error} />
                    </Field>
                  )}
                />
              </FieldGroup>
            </Card>

            <Field>
              <Button type="submit" size="3" disabled={isPending}>
                {isPending && <Spinner />}
                {t("save")}
              </Button>
            </Field>
          </Flex>
        </form>
      ) : (
        <Card size="2">
          <FieldGroup>
            <Field>
              <FieldLabel>{t("nameLabel")}</FieldLabel>
              <Text>{groupName}</Text>
            </Field>
            <Field>
              <FieldLabel>{t("cashModeLabel")}</FieldLabel>
              <Text>
                {cashMode === "shared"
                  ? t("cashModeShared")
                  : t("cashModePerMember")}
              </Text>
            </Field>
            <Field>
              <FieldLabel>{t("currencyLabel")}</FieldLabel>
              <Text>{currency}</Text>
            </Field>
          </FieldGroup>
        </Card>
      )}

      {offered && (
        <Card size="2">
          <Flex direction="column" gap="3">
            <Heading as="h2" size="4">
              {t("leaveTitle")}
            </Heading>
            <Text>{t("leaveBody", { fund: groupName })}</Text>
            <Button
              type="button"
              size="3"
              variant="soft"
              onClick={() => setAsking(true)}
            >
              {t("leaveTitle")}
            </Button>
          </Flex>
        </Card>
      )}

      {refused ? (
        <ConfirmDialog
          open={asking}
          onOpenChange={setAsking}
          title={t("leaveRefusedTitle")}
          description={t("leaveRefusedBody", { fund: groupName })}
          cancelLabel={t("leaveUnderstood")}
          dismissOnly
        />
      ) : (
        <ConfirmDialog
          open={asking}
          onOpenChange={(open) => {
            if (!leave.isPending) setAsking(open);
          }}
          title={t("leaveAsk", { fund: groupName })}
          description={
            <>
              <Box as="span" display="block">
                {t("leaveStays")}
              </Box>
              <Box as="span" display="block">
                {t("leaveGoes", { fund: groupName })}
              </Box>
            </>
          }
          confirmLabel={leave.isPending ? t("leaving") : t("leaveTitle")}
          cancelLabel={tCommon("cancel")}
          tone="danger"
          pending={leave.isPending}
          onConfirm={() => leave.execute({})}
        />
      )}
    </Flex>
  );
}
