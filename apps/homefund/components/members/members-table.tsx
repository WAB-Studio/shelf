"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import {
  Badge,
  DataTable,
  Flex,
  RowMenu,
  Text,
  type DataColumn,
} from "@/components/ui";
import type { MemberRow } from "@/db/queries/group-members";

// The tracks of the Miembros artboard, in order.
const WIDTHS = {
  member: "minmax(0, 1fr)",
  role: "140px",
  access: "260px",
  status: "120px",
  menu: "36px",
} as const;

type MenuItem = {
  key: string;
  label: string;
  onSelect: () => void;
  tone?: "danger";
};

/**
 * The dense Miembros of `private/design-desktop/Miembros.dc.html` (RF-07,
 * RF-57, RF-59): a role transfers only to another member who already holds a
 * login (`group_members_leader_has_user`) and never from the leader's own row,
 * because that row never offers to manage itself — the same gate the phone's
 * card enforces.
 */
export function MembersTable({
  rows,
  currentUserId,
  isLeader,
  empty,
  onEdit,
  onArchive,
  onRestore,
  onDelete,
  onTransfer,
}: {
  rows: MemberRow[];
  // Each row derives its own read: `archivedAt` says whether it is archived,
  // never a tab-wide flag the caller would have to keep in step with it.
  currentUserId: string;
  isLeader: boolean;
  empty?: ReactNode;
  onEdit: (row: MemberRow) => void;
  onArchive: (row: MemberRow) => void;
  onRestore: (row: MemberRow) => void;
  onDelete: (row: MemberRow) => void;
  onTransfer: (row: MemberRow) => void;
}) {
  const t = useTranslations("members");
  const tKey = useTranslations();

  // Mirrors the mobile card's own gates: the database refuses archive,
  // restore, delete and transfer on a caller who is not the leader, and on
  // the session user's own row, so the row menu never offers what the row
  // policy would reject.
  function menuItems(row: MemberRow): MenuItem[] | null {
    const isSelf = row.userId === currentUserId;
    const canEdit = isLeader || isSelf;
    const canManage = isLeader && !isSelf;
    const hasMenu = row.archivedAt ? canManage : canEdit;
    if (!hasMenu) return null;

    if (row.archivedAt) {
      return [
        { key: "restore", label: tKey("common.restore"), onSelect: () => onRestore(row) },
        {
          key: "delete",
          label: tKey("common.delete"),
          tone: "danger",
          onSelect: () => onDelete(row),
        },
      ];
    }

    const items: MenuItem[] = [
      { key: "edit", label: tKey("common.edit"), onSelect: () => onEdit(row) },
    ];
    if (canManage) {
      // A member with no login cannot hold the role, so the item never
      // offers what `group_members_leader_has_user` refuses.
      if (row.userId !== null) {
        items.push({
          key: "transfer",
          label: t("transfer"),
          onSelect: () => onTransfer(row),
        });
      }
      items.push({
        key: "archive",
        label: tKey("common.archive"),
        onSelect: () => onArchive(row),
      });
      items.push({
        key: "delete",
        label: tKey("common.delete"),
        tone: "danger",
        onSelect: () => onDelete(row),
      });
    }
    return items;
  }

  const columns: DataColumn<MemberRow>[] = [
    {
      key: "member",
      header: t("columnMember"),
      width: WIDTHS.member,
      cell: (row) => (
        <Flex align="center" gap="2" wrap="wrap" minWidth="0">
          <Text size="2" weight="medium" truncate>
            {row.name}
          </Text>
          {row.userId === currentUserId && <Badge>{t("you")}</Badge>}
        </Flex>
      ),
    },
    {
      key: "role",
      header: t("columnRole"),
      width: WIDTHS.role,
      cell: (row) =>
        row.role === "leader" ? (
          <Badge color="blue">{t("ownerBadge")}</Badge>
        ) : (
          <Text size="2" color="gray">
            {t("roleMember")}
          </Text>
        ),
    },
    {
      key: "access",
      header: t("columnAccess"),
      width: WIDTHS.access,
      cell: (row) => {
        if (row.userId !== null) {
          return (
            <Text size="2" color="gray">
              {t("hasAccessBadge")}
            </Text>
          );
        }
        if (row.inviteEmail) {
          return (
            <Flex align="center" gap="2" wrap="wrap" minWidth="0">
              <Badge color="amber">{t("pendingBadge")}</Badge>
              <Text size="1" color="gray" truncate>
                {row.inviteEmail}
              </Text>
            </Flex>
          );
        }
        return <Badge color="gray">{t("noLoginBadge")}</Badge>;
      },
    },
    {
      key: "status",
      header: t("columnStatus"),
      width: WIDTHS.status,
      cell: (row) =>
        row.archivedAt ? (
          <Badge color="gray">{t("statusArchived")}</Badge>
        ) : (
          <Text size="2" color="gray">
            {t("statusActive")}
          </Text>
        ),
    },
    {
      key: "menu",
      header: "",
      width: WIDTHS.menu,
      align: "end",
      cell: (row) => {
        const items = menuItems(row);
        return items ? <RowMenu rowName={row.name} items={items} /> : null;
      },
    },
  ];

  return (
    <DataTable
      label={t("title")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      empty={empty}
    />
  );
}
