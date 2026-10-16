"use client";

import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Dialog, Flex, IconButton } from "@radix-ui/themes";

import styles from "./nav-panel.module.css";

// The sliding panel every destination opens from. Dialog.Root supplies the
// scrim, the Escape/outside-click dismissal and the trapped focus; this file
// only pins Dialog.Content to the left edge and slides it in.
export function NavPanel({
  open,
  onOpenChange,
  title,
  closeLabel,
  trigger,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  closeLabel: string;
  trigger: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Trigger>{trigger}</Dialog.Trigger>
      <Dialog.Content className={styles.content}>
        <Flex direction="column" gap="4">
          <Flex align="center" justify="between" gap="3">
            <Dialog.Title mb="0">{title}</Dialog.Title>
            <Dialog.Close>
              <IconButton
                type="button"
                variant="ghost"
                color="gray"
                aria-label={closeLabel}
              >
                <X size={20} />
              </IconButton>
            </Dialog.Close>
          </Flex>
          {children}
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
