"use client";

import { useTranslations } from "next-intl";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import {
  MovementForm,
  movementFormDialogWidth,
} from "@/components/transactions/movement-form";
import { Dialog, VisuallyHidden } from "@/components/ui";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";

type MovementEntry = {
  // The one movement form, expense tab first (RF-272): the FAB's one tap, no page change.
  openForm: () => void;
  // The same form on «Ingreso» with «Te lo devolvió» already naming the person, for a friend's payment back.
  openReturn: (personId: string) => void;
};

const MovementEntryContext = createContext<MovementEntry | null>(null);

// The one way in for any surface that raises the form, the FAB included.
export function useMovementEntry(): MovementEntry {
  const context = useContext(MovementEntryContext);
  if (!context) {
    throw new Error("useMovementEntry must be used within a MovementEntryProvider");
  }
  return context;
}

/**
 * Mounts the movement form once so recording one never costs a route change (RF-272). The options are
 * fetched once in the app layout and threaded down, so opening it hits no network.
 */
export function MovementEntryProvider({
  options,
  children,
}: {
  options: TransactionFormOptions;
  children: ReactNode;
}) {
  const t = useTranslations("transactions");
  const [open, setOpen] = useState(false);
  const [returnedBy, setReturnedBy] = useState<string | null>(null);

  const value = useMemo<MovementEntry>(
    () => ({
      openForm: () => {
        setReturnedBy(null);
        setOpen(true);
      },
      openReturn: (personId) => {
        setReturnedBy(personId);
        setOpen(true);
      },
    }),
    [],
  );

  return (
    <MovementEntryContext.Provider value={value}>
      {children}
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Content maxWidth={movementFormDialogWidth} maxHeight="calc(100dvh - 48px)">
          {/* The form carries its own heading; the title stays for the a11y tree. */}
          <VisuallyHidden>
            <Dialog.Title>{t("formTitle")}</Dialog.Title>
          </VisuallyHidden>
          {/* Closing unmounts the content, so the form is born fresh each open. */}
          {open && (
            <MovementForm
              mode="create"
              options={options}
              defaults={returnedBy === null ? undefined : { tab: "income", forPersonId: returnedBy }}
              onDone={() => setOpen(false)}
            />
          )}
        </Dialog.Content>
      </Dialog.Root>
    </MovementEntryContext.Provider>
  );
}
