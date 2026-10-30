"use client";

import { SegmentedControl } from "@radix-ui/themes";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import { chooseTheme, currentTheme, subscribeTheme, type ThemeChoice as Mode } from "@/lib/theme-choice";

// RNL-07's control, «Claro» · «Oscuro», showing the mode on screen now: the system's until one is chosen.
// The server never knows it, so the first paint shows none selected and the real one lands a commit later.
export function ThemeChoice() {
  const t = useTranslations("theme");
  const mode = useSyncExternalStore<Mode | "">(subscribeTheme, currentTheme, () => "");
  return (
    <SegmentedControl.Root
      size="3"
      aria-label={t("label")}
      value={mode}
      onValueChange={(value) => chooseTheme(value as Mode)}
    >
      <SegmentedControl.Item value="light">{t("light")}</SegmentedControl.Item>
      <SegmentedControl.Item value="dark">{t("dark")}</SegmentedControl.Item>
    </SegmentedControl.Root>
  );
}
