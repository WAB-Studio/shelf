"use client";

import { useTranslations } from "next-intl";
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

import {
  MovementForm,
  movementFormDialogWidth,
} from "@/components/transactions/movement-form";
import { QuickEntrySheet } from "@/components/transactions/quick-entry-sheet";
import { Dialog, VisuallyHidden } from "@/components/ui";
import type { TransactionFormOptions } from "@/db/queries/transaction-form";

type QuickEntry = {
  // The expense quick sheet (RF-22): the FAB's one tap, no page change.
  openQuick: () => void;
  // The full form the sheet's income-or-transfer link reaches (RF-18).
  openFull: () => void;
};

const QuickEntryContext = createContext<QuickEntry | null>(null);

// The one way in for any surface that raises quick entry, the FAB included.
export function useQuickEntry(): QuickEntry {
  const context = useContext(QuickEntryContext);
  if (!context) {
    throw new Error("useQuickEntry must be used within a QuickEntryProvider");
  }
  return context;
}

/**
 * Mounts both entry surfaces once so quick entry never costs a route change: the
 * expense quick sheet (RF-22) and, behind the sheet's link, the full form in a
 * dialog (RF-18). The options are fetched once in the app layout and threaded
 * down, so opening either surface hits no network.
 */
export function QuickEntryProvider({
  options,
  children,
}: {
  options: TransactionFormOptions;
  children: ReactNode;
}) {
  const t = useTranslations("transactions");
  const [quickOpen, setQuickOpen] = useState(false);
  const [fullOpen, setFullOpen] = useState(false);

  const value = useMemo<QuickEntry>(
    () => ({
      openQuick: () => setQuickOpen(true),
      // The link hands off from the sheet to the full form: close one, open the other.
      openFull: () => {
        setQuickOpen(false);
        setFullOpen(true);
      },
    }),
    [],
  );

  return (
    <QuickEntryContext.Provider value={value}>
      {children}
      <QuickEntrySheet
        open={quickOpen}
        onOpenChange={setQuickOpen}
        options={options}
        onOpenFull={value.openFull}
      />
      <Dialog.Root open={fullOpen} onOpenChange={setFullOpen}>
        <Dialog.Content maxWidth={movementFormDialogWidth}>
          {/* The form carries its own heading; the title stays for the a11y tree. */}
          <VisuallyHidden>
            <Dialog.Title>{t("formTitle")}</Dialog.Title>
          </VisuallyHidden>
          {/* Closing unmounts the content, so the form is born fresh each open. */}
          {fullOpen && (
            <MovementForm
              mode="create"
              options={options}
              onDone={() => setFullOpen(false)}
            />
          )}
        </Dialog.Content>
      </Dialog.Root>
    </QuickEntryContext.Provider>
  );
}
