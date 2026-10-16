"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import { createMemberAction, updateMemberAction } from "@/app/actions/members";
import {
  Button,
  Dialog,
  Field,
  FieldControl,
  FieldGroup,
  FieldLabel,
  FieldMessage,
  Flex,
  Spinner,
  TextField,
} from "@/components/ui";
import { useActionErrorToast } from "@/lib/use-action-toast";
import { createMemberSchema, updateMemberSchema } from "@/lib/validation/member";

type FormValues = { memberId?: string; name: string };

type Member = { id: string; name: string };

export function MemberFormDialog({
  open,
  onOpenChange,
  member,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member?: Member;
}) {
  const t = useTranslations("members");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Flex direction="column" gap="4">
          <Dialog.Title>{t(member ? "editTitle" : "addTitle")}</Dialog.Title>
          {/* Closing unmounts the content, and the key remounts on a change of
              subject, so the form below is always born with fresh defaults. */}
          <MemberForm
            key={member?.id ?? "create"}
            member={member}
            onOpenChange={onOpenChange}
          />
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function MemberForm({
  member,
  onOpenChange,
}: {
  member?: Member;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("members");
  // Root-scoped: `common` is a full catalogue path, not this component's namespace.
  const tKey = useTranslations();
  const isEdit = !!member;
  const schema = member ? updateMemberSchema : createMemberSchema;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema) as Resolver<FormValues>,
    defaultValues: member
      ? { memberId: member.id, name: member.name }
      : { name: "" },
  });

  function onActionSuccess() {
    toast.success(t(isEdit ? "updated" : "created"));
    onOpenChange(false);
  }

  const onActionError = useActionErrorToast();

  // Two hooks, not one behind a ternary: the actions' input types differ, and
  // rules of hooks forbid picking which one to call.
  const create = useAction(createMemberAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });
  const update = useAction(updateMemberAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });

  const isPending = isEdit ? update.isPending : create.isPending;

  function onSubmit(values: FormValues) {
    if (isEdit) {
      update.execute({ memberId: values.memberId!, name: values.name });
    } else {
      create.execute({ name: values.name });
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="member-name">{t("nameLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="member-name"
                  size="3"
                  autoFocus
                  autoComplete="off"
                  disabled={isPending}
                />
              </FieldControl>
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
                disabled={isPending}
              >
                {tKey("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button type="submit" disabled={isPending}>
              {isPending && <Spinner />}
              {tKey("common.save")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
