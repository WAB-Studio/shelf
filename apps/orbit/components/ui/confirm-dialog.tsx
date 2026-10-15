"use client";

import type { ReactNode } from "react";
import { AlertDialog, Button, Flex, Spinner } from "@radix-ui/themes";

import { returnFocus, useFocusOrigin } from "./dialog";

type BaseProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  cancelLabel: string;
  pending?: boolean;
};

// `dismissOnly` drops the confirm button rather than letting a caller pass the
// same label twice: a notice has one way out, and it is the only button shown.
type ConfirmDialogProps = BaseProps &
  (
    | {
        dismissOnly: true;
        confirmLabel?: never;
        onConfirm?: never;
        tone?: never;
      }
    | {
        dismissOnly?: false;
        confirmLabel: string;
        onConfirm: () => void;
        tone?: "danger" | "neutral";
      }
  );

// The only file allowed to reach for Radix Themes' AlertDialog.
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  pending = false,
  tone = "danger",
  dismissOnly = false,
}: ConfirmDialogProps) {
  const origin = useFocusOrigin(open);

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Content onCloseAutoFocus={(event) => returnFocus(origin, event)}>
        <AlertDialog.Title>{title}</AlertDialog.Title>
        <AlertDialog.Description>{description}</AlertDialog.Description>
        <Flex gap="3" justify="end" mt="4">
          <AlertDialog.Cancel>
            {/* Standing alone it is the action, not the way past one. */}
            <Button
              variant={dismissOnly ? "solid" : "soft"}
              color={dismissOnly ? undefined : "gray"}
              disabled={pending}
            >
              {cancelLabel}
            </Button>
          </AlertDialog.Cancel>
          {!dismissOnly && (
            <AlertDialog.Action>
              <Button
                color={tone === "danger" ? "red" : undefined}
                disabled={pending}
                onClick={(event) => {
                  // Keeps the dialog under the caller's control instead of AlertDialog's default auto-close.
                  event.preventDefault();
                  onConfirm?.();
                }}
              >
                {pending && <Spinner />}
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          )}
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
