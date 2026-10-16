import type { ReactNode } from "react";
import { Flex } from "@radix-ui/themes";

// The circular coloured chip a category wears in a movement row. The colour is a
// stored CSS value; a category without one falls back to the neutral surface.
export function CategoryTile({
  color,
  icon,
  size = 40,
}: {
  color: string | null;
  icon?: ReactNode;
  size?: number;
}) {
  return (
    <Flex
      align="center"
      justify="center"
      flexShrink="0"
      style={{
        width: size,
        height: size,
        borderRadius: "9999px",
        background: color ?? "var(--gray-a3)",
      }}
    >
      {icon}
    </Flex>
  );
}
