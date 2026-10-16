"use client";

import { LogOutIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";

import { signOutAction } from "@/app/actions/auth";
import { Box, Button, Text } from "@/components/ui";

export function SignOutButton() {
  const t = useTranslations("auth");
  const { execute, isPending } = useAction(signOutAction);

  return (
    <Button
      type="button"
      variant="outline"
      aria-label={t("signOut")}
      disabled={isPending}
      onClick={() => execute()}
    >
      <LogOutIcon size={16} />
      {/* Hidden below `sm`; the button's own `aria-label` keeps the name regardless. */}
      <Box display={{ initial: "none", sm: "inline" }} asChild>
        <Text>{t("signOut")}</Text>
      </Box>
    </Button>
  );
}
