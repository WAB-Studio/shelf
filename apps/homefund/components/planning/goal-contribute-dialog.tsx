"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";

import { contributeGoalAction } from "@/app/actions/savings-goals";
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
import type { GoalProgress } from "@/db/queries/savings-goals";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  contributeGoalSchema,
  refineContributionAmount,
  type ContributeGoalInput,
} from "@/lib/validation/savings-goal";

export function GoalContributeDialog({
  open,
  onOpenChange,
  goal,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  goal?: GoalProgress;
}) {
  const t = useTranslations("goals");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t("contributeTitle", { name: goal?.name ?? "" })}</Dialog.Title>
        {/* Remounts per goal so the amount field is always born empty. */}
        {goal && (
          <ContributeForm
            key={goal.id}
            goal={goal}
            onOpenChange={onOpenChange}
          />
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ContributeForm({
  goal,
  onOpenChange,
}: {
  goal: GoalProgress;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("goals");
  const tKey = useTranslations();

  const form = useForm<ContributeGoalInput>({
    // An aporte is set aside in the goal's own currency, so the field reads in it
    // here exactly as the action reads it back (RF-121, RNF-10).
    resolver: zodResolver(
      contributeGoalSchema.superRefine(refineContributionAmount(goal.currency)),
    ),
    defaultValues: { goalId: goal.id, amount: "" },
  });

  const onActionError = useActionErrorToast();

  // A virtual aporte: the action earmarks no movement, so only the amount
  // crosses and the derived apartado rises on the next refresh (RF-87).
  const contribute = useAction(contributeGoalAction, {
    onSuccess() {
      toast.success(t("contributed"));
      onOpenChange(false);
    },
    onError: onActionError,
  });

  return (
    <form
      onSubmit={form.handleSubmit((values) => contribute.execute(values))}
      noValidate
    >
      <FieldGroup>
        <Controller
          name="amount"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="goal-amount">{t("amountLabel")}</FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="goal-amount"
                  size="3"
                  inputMode="numeric"
                  autoFocus
                  disabled={contribute.isPending}
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
                disabled={contribute.isPending}
              >
                {tKey("common.cancel")}
              </Button>
            </Dialog.Close>
            <Button type="submit" disabled={contribute.isPending}>
              {contribute.isPending && <Spinner />}
              {t("contribute")}
            </Button>
          </Flex>
        </Field>
      </FieldGroup>
    </form>
  );
}
