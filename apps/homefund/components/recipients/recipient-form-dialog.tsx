"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { saveRecipientAction } from "@/app/actions/recipients";
import {
  Button,
  Dialog,
  Field,
  FieldControl,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  ScopedSelectGroups,
  Select,
  Spinner,
  TextField,
} from "@/components/ui";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  RECIPIENT_KINDS,
  saveRecipientSchema,
  type SaveRecipientFields,
} from "@/lib/validation/recipient";

// A Radix Select item may not carry an empty value, so "none" rides this sentinel.
const NONE = "none";

export type RecipientOptions = Pick<TransactionFormOptions, "accounts" | "categories">;

// What the dialog opens with: a saved recipient to edit, or the number a delivery named to save.
export type RecipientDraft = Partial<SaveRecipientFields>;

type RecipientFormValues = {
  id?: string | null;
  identifier: string;
  name: string;
  kind: (typeof RECIPIENT_KINDS)[number];
  accountId: string | null;
  categoryId: string | null;
};

export function RecipientFormDialog({
  draft,
  options,
  onOpenChange,
}: {
  draft: RecipientDraft | null;
  options: RecipientOptions;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("recipients");

  return (
    <Dialog.Root open={draft !== null} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t(draft?.id ? "editTitle" : "addTitle")}</Dialog.Title>
        {/* Closing unmounts the content, so the form is born with fresh defaults. */}
        {draft && <RecipientForm key={draft.id ?? "create"} draft={draft} options={options} onOpenChange={onOpenChange} />}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function RecipientForm({
  draft,
  options,
  onOpenChange,
}: {
  draft: RecipientDraft;
  options: RecipientOptions;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("recipients");
  // Root-scoped: the keys arriving from the schema and the action are full paths.
  const tKey = useTranslations();
  const isEdit = !!draft.id;

  const form = useForm<RecipientFormValues>({
    resolver: zodResolver(saveRecipientSchema) as unknown as Resolver<RecipientFormValues>,
    defaultValues: {
      id: draft.id ?? undefined,
      identifier: draft.identifier ?? "",
      name: draft.name ?? "",
      kind: draft.kind ?? "person",
      accountId: draft.accountId ?? null,
      categoryId: draft.categoryId ?? null,
    },
  });
  const kind = useWatch({ control: form.control, name: "kind" });

  const onActionError = useActionErrorToast();
  const save = useAction(saveRecipientAction, {
    onSuccess() {
      toast.success(t(isEdit ? "updated" : "created"));
      onOpenChange(false);
    },
    onError: onActionError,
  });

  const expenseCategories = options.categories.filter((category) => category.kind === "expense");
  const categoryItems = (scope: "group" | "personal") =>
    expenseCategories
      .filter((category) => category.scope === scope)
      .map((category) => (
        <Select.Item key={category.id} value={category.id}>
          {category.name}
        </Select.Item>
      ));

  return (
    <form onSubmit={form.handleSubmit((values) => save.execute(values as SaveRecipientFields))} noValidate>
      <FieldGroup>
        <Controller
          name="identifier"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="recipient-identifier">{t("identifierLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="recipient-identifier"
                  size="3"
                  inputMode="numeric"
                  autoComplete="off"
                  disabled={save.isPending}
                />
              </FieldControl>
              <FieldDescription>{t("identifierHint")}</FieldDescription>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="recipient-name">{t("nameLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root {...field} id="recipient-name" size="3" autoComplete="off" disabled={save.isPending} />
              </FieldControl>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />
        <Controller
          name="kind"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="recipient-kind">{t("kindLabel")}</FieldLabel>
              <Select.Root value={field.value} onValueChange={field.onChange} disabled={save.isPending}>
                <FieldControl>
                  <Select.Trigger id="recipient-kind" />
                </FieldControl>
                <Select.Content position="popper">
                  {RECIPIENT_KINDS.map((one) => (
                    <Select.Item key={one} value={one}>
                      {t(`kind.${one}`)}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />
        {kind !== "payee" && (
          <Controller
            name="accountId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="recipient-account">
                  {t(kind === "own_account" ? "accountLabel" : "debtAccountLabel")}
                </FieldLabel>
                <Select.Root
                  value={field.value ?? NONE}
                  onValueChange={(value) => field.onChange(value === NONE ? null : value)}
                  disabled={save.isPending}
                >
                  <FieldControl>
                    <Select.Trigger id="recipient-account" />
                  </FieldControl>
                  <Select.Content position="popper">
                    {kind === "person" && <Select.Item value={NONE}>{t("none")}</Select.Item>}
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
        )}
        {kind === "payee" && (
          <Controller
            name="categoryId"
            control={form.control}
            render={({ field, fieldState }) => (
              <Field invalid={fieldState.invalid}>
                <FieldLabel htmlFor="recipient-category">{t("categoryLabel")}</FieldLabel>
                <Select.Root
                  value={field.value ?? NONE}
                  onValueChange={(value) => field.onChange(value === NONE ? null : value)}
                  disabled={save.isPending}
                >
                  <FieldControl>
                    <Select.Trigger id="recipient-category" />
                  </FieldControl>
                  <Select.Content position="popper">
                    <Select.Item value={NONE}>{t("none")}</Select.Item>
                    <ScopedSelectGroups
                      fundHeading={tKey("categories.selectFundHeading")}
                      personalHeading={tKey("categories.selectPersonalHeading")}
                      fund={categoryItems("group")}
                      personal={categoryItems("personal")}
                    />
                  </Select.Content>
                </Select.Root>
                <FieldMessage error={fieldState.error} />
              </Field>
            )}
          />
        )}
        <Field>
          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray" disabled={save.isPending}>
                {tKey("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Spinner />}
              {tKey("common.save")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
