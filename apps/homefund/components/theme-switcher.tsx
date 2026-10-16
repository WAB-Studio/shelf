"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import { type Responsive, Select, ToolbarSelect } from "@/components/ui";
import { isTheme, THEMES } from "@/lib/theme";
import { useTheme } from "@/lib/use-theme";

const icons = { light: Sun, dark: Moon, system: Monitor };

const subscribe = () => () => {};

// False through hydration, true afterwards, without a setState the compiler lint rejects.
function useMounted() {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

export function ThemeSwitcher({ width }: { width?: Responsive<string> }) {
  const t = useTranslations("theme");
  const { theme, resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();

  // The stored value cannot be known on the server, so the first pass stays disabled.
  if (!mounted) {
    return (
      <ToolbarSelect
        value=""
        onValueChange={() => {}}
        disabled
        label={t("label")}
        icon={<Monitor size={16} />}
        text={t("label")}
        width={width}
      />
    );
  }

  // `resolvedTheme` decides the icon only; the value keeps "system" as its own option.
  const TriggerIcon = theme === "system" ? icons[resolvedTheme] : icons[theme];

  function onValueChange(value: string) {
    if (isTheme(value)) setTheme(value);
  }

  return (
    <ToolbarSelect
      value={theme}
      onValueChange={onValueChange}
      label={t("label")}
      icon={<TriggerIcon size={16} />}
      text={t(theme)}
      width={width}
    >
      {THEMES.map((option) => {
        const Icon = icons[option];

        return (
          <Select.Item key={option} value={option}>
            <Icon size={16} /> {t(option)}
          </Select.Item>
        );
      })}
    </ToolbarSelect>
  );
}
