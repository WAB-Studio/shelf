"use client";

import { SegmentedControl } from "@radix-ui/themes";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import { chooseTheme, currentTheme, subscribeTheme, type ThemeChoice as Mode } from "@/lib/theme-choice";
import styles from "./theme-choice.module.css";

// RNL-07's control, «Claro» · «Oscuro», showing the mode on screen now: the system's until one is chosen.
// Each item saves on its own tap, so the mode already showing can be kept too: the root fires nothing then.
// The server never knows it, so the first paint shows none selected and the real one lands a commit later.
export function ThemeChoice() {
  const t = useTranslations("theme");
  const mode = useSyncExternalStore<Mode | "">(subscribeTheme, currentTheme, () => "");
  return (
    <SegmentedControl.Root
      size="3"
      className={styles.root}
      aria-label={t("label")}
      value={mode}
    >
      <SegmentedControl.Item value="light" onClick={() => chooseTheme("light")}>
        {t("light")}
      </SegmentedControl.Item>
      <SegmentedControl.Item value="dark" onClick={() => chooseTheme("dark")}>
        {t("dark")}
      </SegmentedControl.Item>
    </SegmentedControl.Root>
  );
}
