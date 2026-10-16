"use client";

import type { CSSProperties } from "react";
import {
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner } from "sonner";

import { Spinner } from "@radix-ui/themes";
import { useTheme } from "@/lib/use-theme";

// Reads Radix Themes tokens, so the toast surface flips with the resolved appearance.
const toasterStyle = {
  "--normal-bg": "var(--color-panel-solid)",
  "--normal-text": "var(--gray-12)",
  "--normal-border": "var(--gray-6)",
  "--border-radius": "var(--radius-4)",
} as CSSProperties;

export function Toaster() {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={resolvedTheme}
      position="top-center"
      richColors
      style={toasterStyle}
      icons={{
        success: <CircleCheckIcon size={16} />,
        info: <InfoIcon size={16} />,
        warning: <TriangleAlertIcon size={16} />,
        error: <OctagonXIcon size={16} />,
        loading: <Spinner />,
      }}
    />
  );
}
