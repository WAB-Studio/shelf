"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { useMovementEntry } from "@/components/transactions/movement-entry-provider";
import {
  Button,
  Card,
  CategoryTile,
  Flex,
  Panel,
  PanelButton,
  Text,
} from "@/components/ui";

// The dashboard's one tap into the movement form (RF-272): a card that reads like
// the form's first field but raises it in place, no route change. The provider wraps
// the app layout, so the hook is always in scope wherever this renders.
//
// `wide` is the row the Inicio artboard draws on the desktop.
export function QuickEntryPill({
  variant = "compact",
}: {
  variant?: "compact" | "wide" | "action";
}) {
  const t = useTranslations("transactions");
  const { openForm } = useMovementEntry();

  // The empty list's call to action: the same tap as a plain button.
  if (variant === "action") {
    return (
      <Button tap onClick={openForm}>
        <Plus size={16} strokeWidth={2.4} aria-hidden />
        {t("quickAction")}
      </Button>
    );
  }

  if (variant === "wide") {
    return (
      <Panel variant="inline">
        <Flex asChild align="center" gap="3" flexGrow="1" minWidth="0">
          <PanelButton onClick={openForm}>
            <CategoryTile
              color="var(--accent-9)"
              size={36}
              icon={<Plus size={19} strokeWidth={2.4} color="var(--accent-contrast)" />}
            />
            <Text size="3" color="gray" truncate>
              {t("quickPlaceholder")}
            </Text>
          </PanelButton>
        </Flex>
      </Panel>
    );
  }

  return (
    <Card asChild>
      <PanelButton variant="surface" onClick={openForm}>
        <Flex align="center" gap="3">
          <CategoryTile
            color="var(--accent-9)"
            size={34}
            icon={<Plus size={19} strokeWidth={2.4} color="var(--accent-contrast)" />}
          />
          <Text size="3" color="gray">
            {t("quickPlaceholder")}
          </Text>
        </Flex>
      </PanelButton>
    </Card>
  );
}
