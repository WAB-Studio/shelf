"use client";

import { EllipsisVertical, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { Fragment, useState } from "react";
import { toast } from "sonner";

import { deleteCategoryAction } from "@/app/actions/categories";
import {
  CategoryFormDialog,
  type CategoryPlacement,
} from "@/components/categories/category-form-dialog";
import {
  CategoriesTable,
  type CategoryTableRow,
} from "@/components/categories/categories-table";
import {
  Box,
  Button,
  Card,
  ColorSwatch,
  ConfirmDialog,
  DropdownMenu,
  EmptyState,
  Flex,
  Heading,
  IconButton,
  SegmentedControl,
  Text,
  type DataSection,
} from "@/components/ui";
import type { CategoryNode } from "@/db/queries/categories";
import { usePathname, useRouter } from "@/i18n/navigation";
import { useActionErrorToast } from "@/lib/use-action-toast";

type CategoryKind = "expense" | "income";

// A row carries its own placement back to `onEdit`/`onAddSub`, so the dialog
// reads the parent picker and the locked line of the place the row came from.
type ManagedCategoryRow = CategoryTableRow & { placement: CategoryPlacement };

// What the form dialog opens for: a blank top-level category (no `placement`:
// the dialog picks its default), a subcategory preselected under
// `defaultParentId`, or an existing category to edit. `hasChildren` is absent
// whenever `category` is, since a target with no category never gates the
// parent picker.
type FormTarget = {
  category?: { id: string; name: string; parentId: string | null; color: string | null };
  defaultParentId?: string | null;
  hasChildren?: boolean;
  placement?: CategoryPlacement;
};

// A top-level category names its children before the cascade removes them;
// a subcategory never carries any of its own.
type DeleteTarget = { id: string; childCount: number };

export function CategoriesScreen({
  kind,
  personal,
  group,
  groupName,
  canManageGroup,
  usedColorsByPlacement,
}: {
  kind: CategoryKind;
  // One list per place, read once and reshaped for the table and the cards.
  // With no fund `personal` is the caller's only set and `group` is empty.
  personal: CategoryNode[];
  group: CategoryNode[];
  groupName: string | null;
  // RF-57: only the group's leader manages the group's categories.
  canManageGroup: boolean;
  usedColorsByPlacement: Record<CategoryPlacement, string[]>;
}) {
  const t = useTranslations("categories");
  // Root-scoped: `common`'s labels are full catalogue paths.
  const tKey = useTranslations();

  const pathname = usePathname();
  const router = useRouter();

  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);

  const onActionError = useActionErrorToast();

  const deleteAction = useAction(deleteCategoryAction, {
    onSuccess() {
      toast.success(t("deleted"));
      setDeleteTarget(null);
    },
    onError: onActionError,
  });

  const hasFund = groupName !== null;

  // Only a leader is offered the fund, and the fund comes first so the
  // leader's default stays where the screen always wrote.
  const placements: CategoryPlacement[] =
    hasFund && canManageGroup ? ["group", "personal"] : ["personal"];

  // RF-63 caps nesting at one level: a would-be parent that already has
  // children is marked here, so the dialog can keep it off the picker.
  function parentOptionsOf(nodes: CategoryNode[]) {
    return nodes.map((node) => ({
      id: node.id,
      name: node.name,
      hasChildren: node.children.length > 0,
    }));
  }
  const parentsByPlacement = {
    personal: parentOptionsOf(personal),
    group: parentOptionsOf(group),
  };

  // One row per category and one right under it per subcategory (RF-63): the
  // count a parent's cell reads is `childCount`, never `children.length`
  // recomputed here, and a subcategory's own cell reads a dash — nesting
  // stops at one level, so it never has a count of its own.
  function tableRows(
    nodes: CategoryNode[],
    placement: CategoryPlacement,
    canManage: boolean,
  ): ManagedCategoryRow[] {
    // A section the caller manages takes a subcategory under any of its
    // parents, into that parent's own place (RF-63).
    const canAddSub = canManage;
    const rows: ManagedCategoryRow[] = [];
    for (const node of nodes) {
      rows.push({
        id: node.id,
        name: node.name,
        color: node.color,
        kind,
        parentId: null,
        childCount: node.childCount,
        canManage,
        canAddSub,
        placement,
      });
      for (const child of node.children) {
        rows.push({
          id: child.id,
          name: child.name,
          color: child.color,
          kind,
          parentId: node.id,
          childCount: null,
          canManage,
          canAddSub: false,
          placement,
        });
      }
    }
    return rows;
  }

  const sections: DataSection<ManagedCategoryRow>[] = [
    {
      key: "personal",
      label: t("personalSection"),
      rows: tableRows(personal, "personal", true),
    },
    ...(hasFund
      ? [
          {
            key: "group",
            label: groupName,
            rows: tableRows(group, "group", canManageGroup),
          },
        ]
      : []),
  ];

  function onEditRow(row: ManagedCategoryRow) {
    setFormTarget({
      placement: row.placement,
      category: {
        id: row.id,
        name: row.name,
        parentId: row.parentId,
        color: row.color,
      },
      hasChildren: row.parentId === null && (row.childCount ?? 0) > 0,
    });
  }

  function onAddSubRow(row: ManagedCategoryRow) {
    setFormTarget({ placement: row.placement, defaultParentId: row.id });
  }

  function onDeleteRow(row: ManagedCategoryRow) {
    setDeleteTarget({ id: row.id, childCount: row.childCount ?? 0 });
  }

  // Rewrites the query string so the active tab survives a reload and can be linked to.
  function onKindChange(nextKind: string) {
    router.push({ pathname, query: { kind: nextKind } }, { scroll: false });
  }

  // Everyone adds to their own set; the fund's is the leader's alone (RF-57).
  const addButton = (
    <Button type="button" onClick={() => setFormTarget({})}>
      <Plus size={16} />
      {t("add")}
    </Button>
  );

  function actionsMenu(
    name: string,
    items: { label: string; onSelect: () => void; danger?: boolean }[],
  ) {
    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          <IconButton
            type="button"
            variant="ghost"
            color="gray"
            size="3"
            aria-label={tKey("common.actionsFor", { name })}
          >
            <EllipsisVertical size={16} />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content>
          {items.map((item, index) => (
            <Fragment key={item.label}>
              {item.danger && index > 0 && <DropdownMenu.Separator />}
              <DropdownMenu.Item
                color={item.danger ? "red" : undefined}
                onSelect={item.onSelect}
              >
                {item.label}
              </DropdownMenu.Item>
            </Fragment>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    );
  }

  // The phone's cards of one place; `canManage` closes every menu at once.
  function cards(
    nodes: CategoryNode[],
    placement: CategoryPlacement,
    canManage: boolean,
  ) {
    return (
      <Flex direction="column" gap="3">
        {nodes.map((category) => (
          <Card key={category.id}>
            <Flex direction="column" gap="3">
              <Flex justify="between" align="center" gap="3">
                <Flex align="center" gap="2" minWidth="0">
                  {/* `color` is a nullable column; only the write-path schema
                      keeps a top-level category's colour set, so a row that
                      arrived any other way loses the swatch, not the row. */}
                  {category.color && (
                    <ColorSwatch color={category.color} label={category.name} />
                  )}
                  <Flex direction="column" minWidth="0">
                    <Text weight="medium" truncate>
                      {category.name}
                    </Text>
                    <Text size="2" color="gray">
                      {t("subcategoryCount", {
                        count: category.children.length,
                      })}
                    </Text>
                  </Flex>
                </Flex>
                {canManage &&
                  actionsMenu(category.name, [
                    {
                      label: tKey("common.edit"),
                      onSelect: () =>
                        setFormTarget({
                          placement,
                          category: {
                            id: category.id,
                            name: category.name,
                            parentId: null,
                            color: category.color,
                          },
                          hasChildren: category.children.length > 0,
                        }),
                    },
                    {
                      label: t("addSub"),
                      onSelect: () =>
                        setFormTarget({
                          placement,
                          defaultParentId: category.id,
                        }),
                    },
                    {
                      label: tKey("common.delete"),
                      danger: true,
                      onSelect: () =>
                        setDeleteTarget({
                          id: category.id,
                          childCount: category.children.length,
                        }),
                    },
                  ])}
              </Flex>
              {category.children.length > 0 && (
                <Box pl="6">
                  <Flex direction="column" gap="2">
                    {category.children.map((child) => (
                      <Flex
                        key={child.id}
                        justify="between"
                        align="center"
                        gap="3"
                      >
                        <Text truncate>{child.name}</Text>
                        {canManage &&
                          actionsMenu(child.name, [
                            {
                              label: tKey("common.edit"),
                              onSelect: () =>
                                setFormTarget({
                                  placement,
                                  category: {
                                    id: child.id,
                                    name: child.name,
                                    parentId: category.id,
                                    color: child.color,
                                  },
                                }),
                            },
                            {
                              label: tKey("common.delete"),
                              danger: true,
                              onSelect: () =>
                                setDeleteTarget({ id: child.id, childCount: 0 }),
                            },
                          ])}
                      </Flex>
                    ))}
                  </Flex>
                </Box>
              )}
            </Flex>
          </Card>
        ))}
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="4">
      <Flex justify="between" align="center" gap="3" wrap="wrap">
        <Heading size="5">{t("title")}</Heading>
        {addButton}
      </Flex>
      <SegmentedControl.Root value={kind} onValueChange={onKindChange}>
        <SegmentedControl.Item value="expense">
          {t("expenseTab")}
        </SegmentedControl.Item>
        <SegmentedControl.Item value="income">
          {t("incomeTab")}
        </SegmentedControl.Item>
      </SegmentedControl.Root>
      {/* The laptop's dense table and the phone's cards: exactly one of the
          two is displayed at any width. */}
      <Box display={{ initial: "block", lg: "none" }}>
        <Flex direction="column" gap="5">
          <Flex direction="column" gap="3">
            {hasFund && (
              <Heading as="h2" size="3">
                {t("personalSection")}
              </Heading>
            )}
            {personal.length === 0 ? (
              <EmptyState
                title={t(hasFund ? "personalEmptyTitle" : "emptyTitle")}
                description={t(
                  hasFund ? "personalEmptyDescription" : "emptyDescription",
                )}
                action={addButton}
              />
            ) : (
              cards(personal, "personal", true)
            )}
          </Flex>
          {hasFund && (
            <Flex direction="column" gap="3">
              <Flex direction="column" gap="1">
                <Heading as="h2" size="3">
                  {groupName}
                </Heading>
                {!canManageGroup && (
                  <Text size="2" color="gray">
                    {t("leaderOnly")}
                  </Text>
                )}
              </Flex>
              {group.length === 0 ? (
                <EmptyState
                  title={t("emptyTitle")}
                  description={t("emptyDescription")}
                  action={canManageGroup ? addButton : null}
                />
              ) : (
                cards(group, "group", canManageGroup)
              )}
            </Flex>
          )}
        </Flex>
      </Box>

      <Box display={{ initial: "none", lg: "block" }}>
        <CategoriesTable
          sections={sections}
          empty={
            <EmptyState
              variant="filtered"
              title={t("emptyTitle")}
              description={t("emptyDescription")}
              action={addButton}
            />
          }
          onEdit={onEditRow}
          onAddSub={onAddSubRow}
          onDelete={onDeleteRow}
        />
      </Box>

      {/* Below Dialog.Content the form keys itself on the subject; closing unmounts it. */}
      <CategoryFormDialog
        kind={kind}
        placements={placements}
        parentsByPlacement={parentsByPlacement}
        usedColorsByPlacement={usedColorsByPlacement}
        placement={formTarget?.placement}
        open={formTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFormTarget(null);
        }}
        category={formTarget?.category}
        defaultParentId={formTarget?.defaultParentId}
        hasChildren={formTarget?.hasChildren ?? false}
      />
      {deleteTarget && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
          title={t("deleteTitle")}
          description={
            deleteTarget.childCount > 0
              ? t("deleteWithChildrenDescription", {
                  count: deleteTarget.childCount,
                })
              : t("deleteDescription")
          }
          confirmLabel={tKey("common.delete")}
          cancelLabel={tKey("common.cancel")}
          pending={deleteAction.isPending}
          onConfirm={() =>
            deleteAction.execute({ categoryId: deleteTarget.id })
          }
        />
      )}
    </Flex>
  );
}
