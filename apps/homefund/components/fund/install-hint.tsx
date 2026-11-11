"use client";

import { Share, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import { Box, Card, Flex, IconButton, Text } from "@/components/ui";
import {
  dismissInstallHint,
  readInstallHintShown,
  subscribeToInstallHint,
} from "@/lib/install-hint";

// The server and the hydration pass draw nothing; the browser decides right after mount.
function getServerSnapshot(): boolean {
  return false;
}

// RF-188: Safari on iOS has no install prompt, so this says where «Agregar a inicio» lives.
export function InstallHint() {
  const t = useTranslations("installHint");
  const shown = useSyncExternalStore(
    subscribeToInstallHint,
    readInstallHintShown,
    getServerSnapshot,
  );
  if (!shown) return null;

  return (
    <Box px="4" pt="2">
      <Card role="note" aria-label={t("title")}>
      <Flex align="start" gap="3">
        <Share size={18} aria-hidden />
        <Flex direction="column" gap="1" flexGrow="1" minWidth="0">
          <Text size="2" weight="medium">{t("title")}</Text>
          <Text size="2" color="gray">{t("steps")}</Text>
        </Flex>
        <IconButton
          type="button"
          size="1"
          variant="ghost"
          color="gray"
          aria-label={t("dismiss")}
          onClick={dismissInstallHint}
        >
          <X size={16} />
        </IconButton>
      </Flex>
      </Card>
    </Box>
  );
}
