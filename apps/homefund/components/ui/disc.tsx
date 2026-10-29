import type { ReactNode } from "react";
import { Flex } from "@radix-ui/themes";

type DiscRadius = "full" | 1 | 2 | 3 | 4 | 5 | 6 | (number & {});

// Radix's own scale is 1–6; any other number is pixels.
function radiusOf(radius: DiscRadius): string {
  if (radius === "full") return "9999px";
  if (Number.isInteger(radius) && radius >= 1 && radius <= 6) {
    return `var(--radius-${radius})`;
  }
  return `${radius}px`;
}

/**
 * A fixed square that centres its child: an icon well, a step number, a legend
 * dot. `radius` is `full`, a Radix token (1–6) or px; `surface` and `ink` are CSS
 * colours. Not a tap target: the 44px floor belongs to the link around it.
 */
export function Disc({
  size,
  radius = "full",
  surface,
  ink,
  fontSize,
  fontWeight,
  children,
}: {
  size: number;
  radius?: DiscRadius;
  surface?: string;
  ink?: string;
  fontSize?: number;
  fontWeight?: number;
  children?: ReactNode;
}) {
  return (
    <Flex
      align="center"
      justify="center"
      style={{
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: radiusOf(radius),
        background: surface,
        color: ink,
        fontSize,
        fontWeight,
      }}
    >
      {children}
    </Flex>
  );
}
