"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Controller, useForm, type Resolver } from "react-hook-form";
import { toast } from "sonner";

import {
  createCategoryAction,
  updateCategoryAction,
} from "@/app/actions/categories";
import {
  Button,
  ColorSwatchPicker,
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
import { CATEGORY_COLORS, nextCategoryColor } from "@/lib/fund/category-color";
import { useActionErrorToast } from "@/lib/use-action-toast";
import {
  createCategorySchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type UpdateCategoryInput,
} from "@/lib/validation/category";

// Radix's Select rejects an empty-string item value, so "no parent" needs its own sentinel.
const NO_PARENT_VALUE = "none";

// A superset of both schemas' shapes: the resolver strips whichever key the
// active schema does not declare, so only the fields that schema needs ever
// reach the matching action.
type CategoryFormValues = {
  categoryId: string;
  kind: "expense" | "income";
  name: string;
  parentId: string | null;
  color: string | null;
};

type Category = {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
};

type CategoryFormProps = {
  kind: "expense" | "income";
  parents: { id: string; name: string; hasChildren: boolean }[];
  usedColors: string[];
  onOpenChange: (open: boolean) => void;
  category?: Category;
  defaultParentId?: string | null;
  hasChildren: boolean;
};

export function CategoryFormDialog({
  open,
  ...props
}: CategoryFormProps & { open: boolean }) {
  const t = useTranslations("categories");

  return (
    <Dialog.Root open={open} onOpenChange={props.onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>
          {t(props.category ? "editTitle" : "addTitle")}
        </Dialog.Title>
        {/* Closing unmounts the content, and the key remounts on a change of
            subject, so the form below is always born with fresh defaults. */}
        <CategoryForm key={props.category?.id ?? "create"} {...props} />
      </Dialog.Content>
    </Dialog.Root>
  );
}

function CategoryForm({
  kind,
  parents,
  usedColors,
  onOpenChange,
  category,
  defaultParentId,
  hasChildren,
}: CategoryFormProps) {
  const t = useTranslations("categories");
  // Root-scoped: the keys arriving from the schema and the action are full paths.
  const tKey = useTranslations();

  const isEdit = !!category;

  const form = useForm<CategoryFormValues>({
    resolver: (isEdit
      ? zodResolver(updateCategorySchema)
      : zodResolver(createCategorySchema)) as unknown as Resolver<CategoryFormValues>,
    defaultValues: (() => {
      const parentId = category ? category.parentId : (defaultParentId ?? null);
      return {
        categoryId: category?.id ?? "",
        kind,
        name: category?.name ?? "",
        parentId,
        // Own colour whether this node is a parent or a child (D8): a
        // subcategory picks its own instead of inheriting one at write time.
        color: category?.color ?? nextCategoryColor(usedColors),
      };
    })(),
  });

  function onActionSuccess() {
    toast.success(t(isEdit ? "updated" : "created"));
    onOpenChange(false);
  }

  const onActionError = useActionErrorToast();

  // Two hooks, not one behind a ternary: the actions' input types differ, and
  // rules of hooks forbid picking which one to call.
  const create = useAction(createCategoryAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });
  const update = useAction(updateCategoryAction, {
    onSuccess: onActionSuccess,
    onError: onActionError,
  });

  const isPending = isEdit ? update.isPending : create.isPending;

  function onSubmit(values: CategoryFormValues) {
    // The resolver already parsed `values` against the schema for this mode,
    // stripping the field the other mode's action does not accept.
    if (isEdit) {
      update.execute(values as UpdateCategoryInput);
    } else {
      create.execute(values as CreateCategoryInput);
    }
  }

  // RF-63 caps nesting at one level: a category with children offers no
  // parent at all, and a category that already has children never appears as
  // an option — except the option that is already this subcategory's parent,
  // kept selectable so an existing value is never orphaned mid-edit.
  const parentOptions = hasChildren
    ? []
    : parents.filter(
        (parent) =>
          parent.id !== category?.id &&
          (!parent.hasChildren || parent.id === category?.parentId),
      );

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Controller
          name="name"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="category-name">
                {t("nameLabel")}
              </FieldLabel>
              <FieldControl>
                <TextField.Root
                  {...field}
                  id="category-name"
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
        <Controller
          name="parentId"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldLabel htmlFor="category-parent">
                {t("parentLabel")}
              </FieldLabel>
              <Select.Root
                value={field.value ?? NO_PARENT_VALUE}
                onValueChange={(value) => {
                  const nextParentId =
                    value === NO_PARENT_VALUE ? null : value;
                  field.onChange(nextParentId);
                  // A category keeps its own colour whichever parent it has
                  // (D8): moving it under or out of a parent never touches it.
                }}
                disabled={isPending}
              >
                <FieldControl>
                  <Select.Trigger id="category-parent" />
                </FieldControl>
                <Select.Content>
                  <Select.Item value={NO_PARENT_VALUE}>
                    {t("parentNone")}
                  </Select.Item>
                  {parentOptions.map((parent) => (
                    <Select.Item key={parent.id} value={parent.id}>
                      {parent.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
              <FieldMessage error={fieldState.error} />
            </Field>
          )}
        />
        <Field>
          {/* Not labelable: a read-only Text names nothing a <label> can target. */}
          <FieldLabel>{t("kindLabel")}</FieldLabel>
          <Text size="3">
            {t(kind === "expense" ? "kindExpense" : "kindIncome")}
          </Text>
          <FieldDescription>{t("kindLocked")}</FieldDescription>
        </Field>
        <Controller
          name="color"
          control={form.control}
          render={({ field, fieldState }) => (
            <Field invalid={fieldState.invalid}>
              <FieldControl>
                <ColorSwatchPicker
                  id="category-color"
                  name="color"
                  value={field.value ?? ""}
                  onValueChange={field.onChange}
                  colors={CATEGORY_COLORS}
                  label={t("colorLabel")}
                  optionLabel={(index) =>
                    t("colorOption", { number: index + 1 })
                  }
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
