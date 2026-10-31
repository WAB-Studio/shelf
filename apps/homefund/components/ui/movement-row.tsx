import type { ReactNode } from "react";
import { Badge, Box, Flex, Text } from "@radix-ui/themes";

import styles from "./movement-row.module.css";

// The signed amount only turns jade for income; an expense and a transfer both
// read in the plain ink of the row (per the ledger designs).
type MovementTone = "expense" | "income" | "transfer";

// One ledger line: a leading tile, the title over an optional subtitle, and the
// caller-formatted amount. A generated movement wears the `badge` label beside its
// title, a movement that names a cause the `caused` one (RF-132). Pure — every
// string and the sign arrive as props.
export function MovementRow({
  tile,
  title,
  subtitle,
  amount,
  tone = "expense",
  badge,
  caused,
  wrap = false,
}: {
  tile: ReactNode;
  title: string;
  subtitle?: string;
  amount: ReactNode;
  tone?: MovementTone;
  badge?: string;
  // The marker a charge wears; the screen passes the word, never the style.
  caused?: string;
  // Lets a long title run on to as many lines as it needs instead of clamping.
  wrap?: boolean;
}) {
  return (
    <Flex align="center" gap="3">
      {tile}
      <Box flexGrow="1" minWidth="0">
        <Flex align="center" gap="2">
          <Text
            as="div"
            size="3"
            weight="medium"
            className={styles.title}
            data-wrap={wrap || undefined}
          >
            {title}
          </Text>
          {badge && (
            <Badge color="jade" variant="soft" radius="full">
              {badge}
            </Badge>
          )}
          {caused && (
            <Badge color="gray" variant="surface" radius="full">
              {caused}
            </Badge>
          )}
        </Flex>
        {subtitle && (
          <Text as="div" size="2" color="gray" truncate>
            {subtitle}
          </Text>
        )}
      </Box>
      <Text
        size="3"
        weight="medium"
        color={tone === "income" ? "jade" : undefined}
        className={styles.amount}
      >
        {amount}
      </Text>
    </Flex>
  );
}
