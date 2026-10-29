"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { toast } from "sonner";

// Root-scoped: the action's error and every screen's own keys are full catalogue paths.
export type MessageKey = Parameters<ReturnType<typeof useTranslations<never>>>[0];

/**
 * `onError` for `useAction`: toasts the server's catalogue key, or
 * `errors.unexpected` when the action threw something other than `ActionError`.
 */
export function useActionErrorToast() {
  const t = useTranslations();

  return useCallback(
    ({ error }: { error: { serverError?: string } }) => {
      toast.error(t((error.serverError ?? "errors.unexpected") as MessageKey));
    },
    [t],
  );
}
