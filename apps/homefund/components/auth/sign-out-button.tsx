"use client";

import { LogOutIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";

import { signOutAction } from "@/app/actions/auth";
import { Box, Button, Text } from "@/components/ui";
import { useActionErrorToast } from "@/lib/use-action-toast";

export function SignOutButton({ compact = false }: { compact?: boolean }) {
  const t = useTranslations("auth");
  const { execute, isPending } = useAction(signOutAction, { onError: useActionErrorToast() });

  return (
    <Button
      type="button"
      variant="outline"
      aria-label={t("signOut")}
      disabled={isPending}
      onClick={() => execute()}
    >
      <LogOutIcon size={16} />
      {/* Compact hides the word below `sm`; the button's own `aria-label` keeps the name regardless. */}
      <Box display={compact ? { initial: "none", sm: "inline" } : "inline"} asChild>
        <Text>{t("signOut")}</Text>
      </Box>
    </Button>
  );
}
