"use client";

import { Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { useQuickEntry } from "@/components/transactions/quick-entry-provider";
import {
  Card,
  CategoryTile,
  Flex,
  Panel,
  PanelButton,
  TapTarget,
  Text,
} from "@/components/ui";

// The dashboard's one tap into expense quick entry (RF-22): a card that reads like
// the sheet's field but raises it in place, no route change. The provider wraps
// the app layout, so the hook is always in scope wherever this renders.
//
// `wide` is the row the Inicio artboard draws on the desktop: the same tap, plus
// the income-or-transfer hand-off the sheet also offers (RF-18), which is a
// button of its own so no control nests inside another.
export function QuickEntryPill({
  variant = "compact",
}: {
  variant?: "compact" | "wide";
}) {
  const t = useTranslations("transactions");
  const { openQuick, openFull } = useQuickEntry();

  if (variant === "wide") {
    return (
      <Panel variant="inline">
        <Flex asChild align="center" gap="3" flexGrow="1" minWidth="0">
          <PanelButton onClick={openQuick}>
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
        <PanelButton onClick={openFull}>
          <TapTarget align="center" px="1">
            <Text size="2" weight="medium" color="jade">
              {t("quickTypeLink")}
            </Text>
          </TapTarget>
        </PanelButton>
      </Panel>
    );
  }

  return (
    <Card asChild>
      <PanelButton variant="surface" onClick={openQuick}>
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
