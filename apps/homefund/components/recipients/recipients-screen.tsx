"use client";

import { EllipsisVertical, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { toast } from "sonner";

import { deleteRecipientAction } from "@/app/actions/recipients";
import {
  RecipientFormDialog,
  type RecipientDraft,
  type RecipientOptions,
} from "@/components/recipients/recipient-form-dialog";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DropdownMenu,
  EmptyState,
  Flex,
  IconButton,
  ScreenHeader,
  Text,
} from "@/components/ui";
import type { RecipientRow } from "@/db/queries/recipients";
import { useActionErrorToast } from "@/lib/use-action-toast";

// RF-189: the numbers a bank message names, saved with a name and what they are.
export function RecipientsScreen({
  recipients,
  options,
}: {
  recipients: RecipientRow[];
  options: RecipientOptions;
}) {
  const t = useTranslations("recipients");
  // Root-scoped: `common`'s labels are full catalogue paths.
  const tKey = useTranslations();

  const [draft, setDraft] = useState<RecipientDraft | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RecipientRow | null>(null);

  const onActionError = useActionErrorToast();
  const remove = useAction(deleteRecipientAction, {
    onSuccess() {
      toast.success(t("deleted"));
      setDeleteTarget(null);
    },
    onError: onActionError,
  });

  return (
    <Flex direction="column" gap="4">
      <ScreenHeader
        title={t("title")}
        actions={
          <Button type="button" onClick={() => setDraft({})}>
            <Plus size={16} />
            {t("add")}
          </Button>
        }
      />

      {recipients.length === 0 ? (
        <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <Flex direction="column" gap="2">
          {recipients.map((row) => (
            <Card key={row.id}>
              <Flex justify="between" align="center" gap="3">
                <Flex direction="column" minWidth="0">
                  <Text weight="medium" truncate>
                    {row.name}
                  </Text>
                  <Flex gap="2" align="center" wrap="wrap">
                    <Text size="2" color="gray">
                      {row.identifier}
                    </Text>
                    <Badge color="gray">{t(`kind.${row.kind}`)}</Badge>
                    {(row.accountName ?? row.categoryName) && (
                      <Text size="2" color="gray">
                        {row.accountName ?? row.categoryName}
                      </Text>
                    )}
                  </Flex>
                </Flex>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger>
                    <IconButton
                      type="button"
                      variant="ghost"
                      color="gray"
                      size="3"
                      aria-label={tKey("common.actionsFor", { name: row.name })}
                    >
                      <EllipsisVertical size={16} />
                    </IconButton>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Content>
                    <DropdownMenu.Item
                      onSelect={() =>
                        setDraft({
                          id: row.id,
                          identifier: row.identifier,
                          name: row.name,
                          kind: row.kind,
                          accountId: row.accountId,
                          categoryId: row.categoryId,
                        })
                      }
                    >
                      {tKey("common.edit")}
                    </DropdownMenu.Item>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item color="red" onSelect={() => setDeleteTarget(row)}>
                      {tKey("common.delete")}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Root>
              </Flex>
            </Card>
          ))}
        </Flex>
      )}

      <RecipientFormDialog
        draft={draft}
        options={options}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
      />

      {deleteTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          title={t("deleteTitle")}
          description={t("deleteDescription", { name: deleteTarget.name })}
          confirmLabel={tKey("common.delete")}
          cancelLabel={tKey("common.cancel")}
          pending={remove.isPending}
          tone="danger"
          onConfirm={() => remove.execute({ id: deleteTarget.id })}
        />
      )}
    </Flex>
  );
}
