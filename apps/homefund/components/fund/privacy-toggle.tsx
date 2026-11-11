"use client";

import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "next-intl";

import { IconButton } from "@/components/ui";
import { usePrivacy } from "@/lib/use-privacy";

/**
 * The one switch for «hide amounts» (RF-174). Its label names what a press does,
 * and `aria-pressed` says whether amounts are hidden now.
 */
export function PrivacyToggle({ size = "2" }: { size?: "1" | "2" }) {
  const t = useTranslations("privacy");
  const { hidden, toggle } = usePrivacy();

  return (
    <IconButton
      type="button"
      size={size}
      variant="ghost"
      color="gray"
      aria-label={hidden ? t("show") : t("hide")}
      aria-pressed={hidden}
      data-testid="privacy-toggle"
      onClick={toggle}
    >
      {hidden ? <EyeOff size={18} /> : <Eye size={18} />}
    </IconButton>
  );
}
