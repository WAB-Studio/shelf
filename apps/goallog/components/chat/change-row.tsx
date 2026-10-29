"use client";

import { useTranslations } from "next-intl";

import { Button, Flex, Mark, Separator, Text } from "@/components/ui";
import type { StoredChange } from "@/lib/chat/conversation";
import { messageKey } from "@/i18n/translator";

/**
 * One change a turn proposes (`ChatPropuestas`, `ChatHecho`, `ChatRechazada`):
 * what it changes, «antes → después» under it in mono, and at the end «Hacer»
 * or where it stands. A refused change shows its reason and offers nothing.
 */
export function ChangeRow({
  change,
  only,
  shut,
  onMake,
}: {
  change: StoredChange;
  // The turn proposes this one change alone: «Hacer» is solid.
  only: boolean;
  // Another change is being made; «Hacer» waits.
  shut: boolean;
  onMake: () => void;
}) {
  const t = useTranslations();
  const { words, state, reason } = change;
  const lapsed = state === "lapsed";
  const name = words ? t(messageKey(words.key), words.values) : null;
  const before = words?.values.before;
  const after = words?.values.after;
  const reasonText = reason ? ("key" in reason ? t(messageKey(reason.key)) : reason.text) : null;

  return (
    <>
      <Separator />
      <Flex gap="3" align="center">
        {state === "made" ? <Mark state="declared" /> : null}
        <Flex direction="column" gap="1" flexGrow="1" minWidth="0">
          {name ? (
            <Text as="span" variant="name" tone={lapsed ? "muted" : undefined} breakWords>
              {name}
            </Text>
          ) : null}
          {name && before && after ? (
            <Text as="span" variant="meta" tone={lapsed ? "muted" : undefined} breakWords>
              {`${before} → ${after}`}
            </Text>
          ) : null}
          {state === "refused" && reasonText ? (
            <Text as="p" variant="sentence" tone="ink" breakWords>
              {reasonText}
            </Text>
          ) : null}
        </Flex>
        {state === "open" ? (
          <Button variant={only ? "solid" : "outline"} disabled={shut} onClick={onMake}>
            {t("chat.do")}
          </Button>
        ) : null}
        {state === "made" ? (
          <Text as="span" variant="meta" tone="muted">
            {t("chat.made")}
          </Text>
        ) : null}
        {lapsed ? (
          <Text as="span" variant="meta" tone="muted">
            {t("chat.lapsed")}
          </Text>
        ) : null}
      </Flex>
    </>
  );
}
