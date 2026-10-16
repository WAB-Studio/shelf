"use client";

import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Dialog } from "@radix-ui/themes";

import { SectionLabel } from "./section-label";
import styles from "./sheet.module.css";

// The surface a fact is written on: it rises from the foot of the screen with
// 16px on its top corners (docs/goallog/DESIGN.md "The marks"). Controlled, so
// the screen that opens it owns when it closes.
export function Sheet({
  open,
  onOpenChange,
  label,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Names the goal or commitment the sheet's act belongs to, in the section
  // label's own type (docs/goallog/DESIGN.md "Decisions taken here" — "a
  // field's label takes the section label's type"). Never the sheet's
  // accessible name: `title` still owns that, as the one real `<h2>`.
  label?: string;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  // Radix points every dialog at a description; with none rendered the
  // attribute would name an element that is not there, so it is dropped.
  // No Trigger opens a sheet, so Radix has no element to give focus back to.
  // Layout, not passive: Radix moves focus in during a passive effect.
  const origin = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    origin.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);

  const described = description ? {} : { "aria-describedby": undefined };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        className={styles.sheet}
        {...described}
        onCloseAutoFocus={(event) => {
          const target = origin.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <div className={styles.grabber} aria-hidden />
        {label ? (
          <div className={styles.label}>
            <SectionLabel>{label}</SectionLabel>
          </div>
        ) : null}
        <Dialog.Title as="h2" className={styles.title}>{title}</Dialog.Title>
        {description ? (
          <Dialog.Description className={styles.description}>{description}</Dialog.Description>
        ) : null}
        <div className={styles.body}>{children}</div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
