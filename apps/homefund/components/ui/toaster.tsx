"use client";

import { useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Toaster as Sonner } from "sonner";

import { Spinner, Theme } from "@radix-ui/themes";
import { useTheme } from "@/lib/use-theme";

import styles from "./toaster.module.css";

const noSubscription = () => () => {};

// Reads Radix Themes tokens, so the toast surface flips with the resolved appearance.
const toasterStyle = {
  "--normal-bg": "var(--color-panel-solid)",
  "--normal-text": "var(--gray-12)",
  "--normal-border": "var(--gray-6)",
  "--border-radius": "var(--radius-4)",
} as CSSProperties;

export function Toaster() {
  const { resolvedTheme } = useTheme();

  // False on the server and while hydrating, true after: the portal needs `document`.
  const mounted = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  if (!mounted) return null;

  // A dialog draws in its own Theme layer appended to <body>; the toaster takes a layer of
  // its own above those, so a refusal raised under an open dialog is read.
  return createPortal(
    <Theme className={styles.layer}>
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
    </Theme>,
    document.body,
  );
}
