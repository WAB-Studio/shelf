import { PiggyBank } from "lucide-react";
import { Flex } from "@radix-ui/themes";

// The app's logo tile: the accent rounded square with the piggy-bank glyph. Sized
// from one prop so the login screen and any header share the same mark.
export function AppMark({ size = 60 }: { size?: number }) {
  return (
    <Flex
      align="center"
      justify="center"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        backgroundColor: "var(--accent-9)",
      }}
    >
      <PiggyBank
        size={size * 0.5}
        color="var(--accent-contrast)"
        strokeWidth={1.9}
        aria-hidden
      />
    </Flex>
  );
}
