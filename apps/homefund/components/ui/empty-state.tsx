import type { ReactNode } from "react";
import { Box, Flex, Text } from "@radix-ui/themes";

// Matches the dashboard's empty state so no screen invents its own.
// `filtered` is the same stack without the page-filling growth: it sits inside
// the table container that framed the rows, so the column headers stay on screen
// and the text never accuses of filtering when no filter is on (RF-23, RF-48).
export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = "first",
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  variant?: "first" | "filtered";
}) {
  return (
    <Flex
      direction="column"
      flexGrow="1"
      align="center"
      justify="center"
      gap="2"
      py={variant === "filtered" ? "7" : undefined}
      // Inside the table's frame the stack keeps its own height; only the
      // first-run state stretches to fill the content pane.
      style={variant === "filtered" ? { flexGrow: 0 } : undefined}
    >
      {icon && (
        <Flex
          align="center"
          justify="center"
          mb="2"
          style={{
            width: 96,
            height: 96,
            borderRadius: "9999px",
            background: "var(--gray-a3)",
            color: "var(--gray-9)",
          }}
        >
          {icon}
        </Flex>
      )}
      <Text size="4" weight="medium" align="center">
        {title}
      </Text>
      {description && (
        <Box maxWidth="65ch">
          <Text color="gray" align="center">
            {description}
          </Text>
        </Box>
      )}
      {action}
    </Flex>
  );
}
