import type { ReactNode } from "react";
import { Theme } from "@radix-ui/themes";

// The palette (blue on cool grey; `radius="full"` makes every button a pill), fixed once for the whole app; no screen passes or overrides these.
export function AppTheme({ children }: { children?: ReactNode }) {
  return (
    <Theme
      accentColor="blue"
      grayColor="slate"
      radius="full"
      scaling="100%"
    >
      {children}
    </Theme>
  );
}
