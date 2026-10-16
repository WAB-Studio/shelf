"use client";

import { EllipsisVertical, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";
import { useState } from "react";
import { toast } from "sonner";

import { deleteCategoryAction } from "@/app/actions/categories";
import { CategoryFormDialog } from "@/components/categories/category-form-dialog";
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

// A desktop row carries its own scope back to `onEdit`/`onAddSub`, so the
// dialog reads the parent picker of the scope the row came from, never the
// other one's.
type ManagedCategoryRow = CategoryTableRow & { scope: "personal" | "group" };

// What the form dialog opens for: a blank top-level category, a subcategory
// preselected under `defaultParentId`, or an existing category to edit.
// `hasChildren` is absent whenever `category` is, since a target with no
// category never gates the parent picker. `scope` is absent from every mobile
// call site and every group-section call: both already mean the effective
// scope, which is what an absent value resolves to.
type FormTarget = {
  category?: { id: string; name: string; parentId: string | null; color: string | null };
  defaultParentId?: string | null;
  hasChildren?: boolean;
  scope?: "personal" | "group";
};

// A top-level category names its children before the cascade removes them;
// a subcategory never carries any of its own.
type DeleteTarget = { id: string; childCount: number };

export function CategoriesScreen({
  kind,
  categories,
  personal,
  group,
  groupName,
  canManageGroup,
  parents,
  usedColors,
}: {
  kind: CategoryKind;
  categories: CategoryNode[];
  // The same scope split the Etiquetas screen already draws (RF-70): one list
  // per scope, personal and the group's, read once and reshaped for the table.
  personal: CategoryNode[];
  group: CategoryNode[];
  groupName: string | null;
  // RF-57: only the group's leader manages the group's categories.
  canManageGroup: boolean;
  parents: { id: string; name: string }[];
  usedColors: string[];
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

  // RF-63 caps nesting at one level: a would-be parent that already has
  // children is marked here, so the dialog can keep it off the picker
  // without a second pass over `categories`.
  const parentOptions = parents.map((parent) => ({
    id: parent.id,
    name: parent.name,
    hasChildren:
      (categories.find((category) => category.id === parent.id)?.children
        .length ?? 0) > 0,
  }));

  // The scope every mutation not started from the desktop's personal section
  // already runs in: the group's while one exists, the caller's own
  // otherwise — the same rule `createCategoryAction` applies server-side.
  const effectiveScope: "personal" | "group" =
    groupName !== null ? "group" : "personal";

  // `personal` already carries its own children, so no cross-referencing
  // against a second list is needed to know which of its top-level rows has
  // any (unlike `parentOptions`, built from the id-only `parents`).
  const personalParentOptions = personal.map((node) => ({
    id: node.id,
    name: node.name,
    hasChildren: node.children.length > 0,
  }));

  // A desktop row's own scope decides the picker: the effective one already
  // matches `parentOptions`, and only the personal section shown beside a
  // group (RF-63) reads its own instead.
  const activeScope = formTarget?.scope ?? effectiveScope;
  const activeParentOptions =
    activeScope === effectiveScope ? parentOptions : personalParentOptions;

  // One row per category and one right under it per subcategory (RF-116): the
  // count a parent's cell reads is `childCount`, never `children.length`
  // recomputed here, and a subcategory's own cell reads a dash — nesting
  // stops at one level, so it never has a count of its own.
  function tableRows(
    nodes: CategoryNode[],
    scope: "personal" | "group",
    canManage: boolean,
  ): ManagedCategoryRow[] {
    // Only the effective scope's create action writes where this row's
    // "add subcategory" would land (RF-63); the other section stays a
    // read-and-edit view, never a broken write.
    const canAddSub = canManage && scope === effectiveScope;
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
        scope,
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
          scope,
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
    ...(groupName !== null
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
      scope: row.scope,
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
    setFormTarget({ scope: row.scope, defaultParentId: row.id });
  }

  function onDeleteRow(row: ManagedCategoryRow) {
    setDeleteTarget({ id: row.id, childCount: row.childCount ?? 0 });
  }

  // Rewrites the query string so the active tab survives a reload and can be linked to.
  function onKindChange(nextKind: string) {
    router.push({ pathname, query: { kind: nextKind } }, { scroll: false });
  }

  const addButton = (
    <Button type="button" onClick={() => setFormTarget({})}>
      <Plus size={16} />
      {t("add")}
    </Button>
  );

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
      {categories.length === 0 ? (
        <EmptyState
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          action={addButton}
        />
      ) : (
        <Flex direction="column" gap="3">
          {categories.map((category) => (
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
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger>
                      <IconButton
                        type="button"
                        variant="ghost"
                        color="gray"
                        size="3"
                        aria-label={tKey("common.actionsFor", {
                          name: category.name,
                        })}
                      >
                        <EllipsisVertical size={16} />
                      </IconButton>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Content>
                      <DropdownMenu.Item
                        onSelect={() =>
                          setFormTarget({
                            category: {
                              id: category.id,
                              name: category.name,
                              parentId: null,
                              color: category.color,
                            },
                            hasChildren: category.children.length > 0,
                          })
                        }
                      >
                        {tKey("common.edit")}
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        onSelect={() =>
                          setFormTarget({ defaultParentId: category.id })
                        }
                      >
                        {t("addSub")}
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator />
                      <DropdownMenu.Item
                        color="red"
                        onSelect={() =>
                          setDeleteTarget({
                            id: category.id,
                            childCount: category.children.length,
                          })
                        }
                      >
                        {tKey("common.delete")}
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Root>
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
                          <DropdownMenu.Root>
                            <DropdownMenu.Trigger>
                              <IconButton
                                type="button"
                                variant="ghost"
                                color="gray"
                                size="3"
                                aria-label={tKey("common.actionsFor", {
                                  name: child.name,
                                })}
                              >
                                <EllipsisVertical size={16} />
                              </IconButton>
                            </DropdownMenu.Trigger>
                            <DropdownMenu.Content>
                              <DropdownMenu.Item
                                onSelect={() =>
                                  setFormTarget({
                                    category: {
                                      id: child.id,
                                      name: child.name,
                                      parentId: category.id,
                                      color: child.color,
                                    },
                                  })
                                }
                              >
                                {tKey("common.edit")}
                              </DropdownMenu.Item>
                              <DropdownMenu.Separator />
                              <DropdownMenu.Item
                                color="red"
                                onSelect={() =>
                                  setDeleteTarget({ id: child.id, childCount: 0 })
                                }
                              >
                                {tKey("common.delete")}
                              </DropdownMenu.Item>
                            </DropdownMenu.Content>
                          </DropdownMenu.Root>
                        </Flex>
                      ))}
                    </Flex>
                  </Box>
                )}
              </Flex>
            </Card>
          ))}
        </Flex>
      )}
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
        parents={activeParentOptions}
        usedColors={usedColors}
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
