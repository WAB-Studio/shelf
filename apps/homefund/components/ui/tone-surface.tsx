import type { ComponentProps } from "react";
import { Card, Flex } from "@radix-ui/themes";

const TOKENS = {
  danger: { soft: "var(--red-a2)", strong: "var(--red-a3)" },
  success: { soft: "var(--grass-a3)", strong: "var(--grass-a3)" },
} as const;

type Shared = {
  // Absent, the surface keeps the background it has and only `faded` applies.
  tone?: keyof typeof TOKENS;
  // Danger only: the denser of its two washes.
  strong?: boolean;
  // A Radix radius token (1–6).
  radius?: 1 | 2 | 3 | 4 | 5 | 6;
  // A row that is switched off, drawn at 55% so it still reads.
  faded?: boolean;
};

type ToneSurfaceProps = Shared &
  (
    | ({ card?: false } & Omit<ComponentProps<typeof Flex>, "style" | "className">)
    | ({ card: true } & Omit<ComponentProps<typeof Card>, "style" | "className">)
  );

/**
 * A row or card washed with the colour of its state: danger for an overspent
 * budget or an unbalanced split, success for a balanced one, or dimmed with
 * `faded` for a rule that is paused. A Flex by default, a Radix Card with `card`.
 */
export function ToneSurface({ tone, strong, radius, faded, card, ...props }: ToneSurfaceProps) {
  const style = {
    ...(tone ? { background: TOKENS[tone][strong ? "strong" : "soft"] } : null),
    ...(radius ? { borderRadius: `var(--radius-${radius})` } : null),
    ...(faded ? { opacity: 0.55 } : null),
  };

  if (card) return <Card {...(props as ComponentProps<typeof Card>)} style={style} />;
  return <Flex {...(props as ComponentProps<typeof Flex>)} style={style} />;
}
