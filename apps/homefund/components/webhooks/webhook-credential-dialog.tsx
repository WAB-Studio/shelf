"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { Controller, useForm, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { issueWebhookCredentialAction } from "@/app/actions/webhook-credentials";
import {
  Button,
  Callout,
  CopyField,
  Dialog,
  Field,
  FieldControl,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Select,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";
import type { WebhookCredentialOptions } from "@/db/queries/webhook-credentials";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { issueWebhookCredentialSchema } from "@/lib/validation/webhook";

// A Radix Select item may not carry an empty value, so "no default" rides this
// sentinel and maps back to null the moment it is picked.
const ANY = "none";

type IssueFormValues = {
  name: string;
  defaultAccountId: string | null;
  defaultCategoryId: string | null;
  rateLimitPerMin: number;
};

/**
 * Issues a webhook credential (RF-86) in two steps inside one dialog: the form,
 * then the token. The token is shown once and is not re-derivable, so the second
 * step refuses every dismissal gesture — Escape, an outside click, a close
 * control — and leaves exactly one way out, the acknowledge button.
 */
export function WebhookCredentialDialog({
  open,
  onOpenChange,
  options,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: WebhookCredentialOptions;
}) {
  // Mirrors the step the body is on. The token itself never leaves the body.
  const [showingToken, setShowingToken] = useState(false);

  function close() {
    setShowingToken(false);
    onOpenChange(false);
  }

  // A gesture that dismisses the dialog would destroy an unrecoverable secret.
  const block = showingToken
    ? (event: Event) => event.preventDefault()
    : undefined;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && showingToken) return;
        onOpenChange(next);
      }}
    >
      <Dialog.Content
        onEscapeKeyDown={block}
        onPointerDownOutside={block}
        onInteractOutside={block}
      >
        {/* Closing unmounts the content, so the body — and the token it alone
            holds — is born fresh on the next open. No key flips it mid-exit. */}
        <WebhookCredentialBody
          options={options}
          onTokenIssued={() => setShowingToken(true)}
          onClose={close}
        />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function WebhookCredentialBody({
  options,
  onTokenIssued,
  onClose,
}: {
  options: WebhookCredentialOptions;
  onTokenIssued: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("webhooks");
  // Root-scoped: the schema's keys and a category's kind are full catalogue paths.
  const tKey = useTranslations();

  // The plaintext bearer lives here and nowhere else: no parent state, no toast
  // body, no URL, no storage, no ref that outlives this component.
  const [token, setToken] = useState<string | null>(null);

  const form = useForm<IssueFormValues>({
    // The schema's output types both defaults as optional; the form always
    // holds them, so the resolver is cast to the shape the fields render.
    resolver: zodResolver(
      issueWebhookCredentialSchema,
    ) as unknown as Resolver<IssueFormValues>,
    defaultValues: {
      name: "",
      defaultAccountId: null,
      defaultCategoryId: null,
      rateLimitPerMin: 60,
    },
  });

  const onActionError = useActionErrorToast();

  const issue = useAction(issueWebhookCredentialAction, {
    onSuccess({ data }) {
      if (!data) return;
      setToken(data.token);
      onTokenIssued();
    },
    onError: onActionError,
  });

  function acknowledge() {
    setToken(null);
    onClose();
    // After the token is out of the way, never over it.
    toast.success(t("created"));
  }

  if (token !== null) {
    return (
      <Flex direction="column" gap="4">
        <Dialog.Title>{t("tokenTitle")}</Dialog.Title>
        <Callout.Root color="amber" variant="soft">
          <Callout.Icon>
            <TriangleAlert size={16} />
          </Callout.Icon>
          <Callout.Text>{t("tokenWarning")}</Callout.Text>
        </Callout.Root>
        {/* The only copy control on this step, so nothing competes with the
            copy that matters. */}
        <CopyField
          id="webhook-token"
          label={t("tokenLabel")}
          value={token}
          copyLabel={t("copy")}
          copiedLabel={t("copied")}
          failedLabel={t("copyFailed")}
          tone="secret"
        />
        {/* Always enabled: a clipboard write may legitimately fail, and the
            value stays selectable, so gating the exit would trap a person. */}
        <Flex justify="end">
          <Button type="button" onClick={acknowledge}>
            {t("tokenAcknowledge")}
          </Button>
        </Flex>
      </Flex>
    );
  }

  return (
    <>
      <Dialog.Title>{t("addTitle")}</Dialog.Title>
      <form
        onSubmit={form.handleSubmit((values) => issue.execute(values))}
        noValidate
      >
        <FieldGroup>
          <Controller
            name="name"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="webhook-name">{t("nameLabel")}</FieldLabel>
                <FieldControl>
                  <TextField.Root
                    {...field}
                    id="webhook-name"
                    size="3"
                    autoFocus
                    autoComplete="off"
                    disabled={issue.isPending}
                  />
                </FieldControl>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
          <Controller
            name="defaultAccountId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="webhook-account">
                  {t("defaultAccountLabel")}
                </FieldLabel>
                <Select.Root
                  value={field.value ?? ANY}
                  onValueChange={(value) =>
                    field.onChange(value === ANY ? null : value)
                  }
                  disabled={issue.isPending}
                >
                  <FieldControl>
                    <Select.Trigger id="webhook-account" />
                  </FieldControl>
                  <Select.Content position="popper">
                    <Select.Item value={ANY}>{t("defaultNone")}</Select.Item>
                    {options.accounts.map((account) => (
                      <Select.Item key={account.id} value={account.id}>
                        {account.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
          <Controller
            name="defaultCategoryId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="webhook-category">
                  {t("defaultCategoryLabel")}
                </FieldLabel>
                <Select.Root
                  value={field.value ?? ANY}
                  onValueChange={(value) =>
                    field.onChange(value === ANY ? null : value)
                  }
                  disabled={issue.isPending}
                >
                  <FieldControl>
                    <Select.Trigger id="webhook-category" />
                  </FieldControl>
                  <Select.Content position="popper">
                    <Select.Item value={ANY}>{t("defaultNone")}</Select.Item>
                    {options.categories.map((category) => (
                      <Select.Item key={category.id} value={category.id}>
                        {/* Two categories may share a name across kinds; the kind
                            is what tells them apart. */}
                        <Flex as="span" align="center" gap="2">
                          {category.name}
                          <Text size="1" color="gray">
                            {tKey(
                              category.kind === "income"
                                ? "categories.kindIncome"
                                : "categories.kindExpense",
                            )}
                          </Text>
                        </Flex>
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
          <Controller
            name="rateLimitPerMin"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="webhook-rate-limit">
                  {t("rateLimitLabel")}
                </FieldLabel>
                <FieldControl>
                  <TextField.Root
                    id="webhook-rate-limit"
                    size="3"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={1000}
                    value={field.value}
                    onBlur={field.onBlur}
                    // The schema counts requests, so the field hands it a number;
                    // an emptied box reads 0 and the schema refuses it.
                    onChange={(event) => field.onChange(Number(event.target.value))}
                    disabled={issue.isPending}
                  />
                </FieldControl>
                <FieldDescription>{t("rateLimitDescription")}</FieldDescription>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
          <Field>
            <Flex gap="3" justify="end">
              <Dialog.Close>
                <Button
                  type="button"
                  variant="soft"
                  color="gray"
                  disabled={issue.isPending}
                >
                  {tKey("common.cancel")}
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={issue.isPending}>
                {issue.isPending && <Spinner />}
                {t("issue")}
              </Button>
            </Flex>
          </Field>
        </FieldGroup>
      </form>
    </>
  );
}
