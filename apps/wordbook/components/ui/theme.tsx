import type { ReactNode } from "react";
import { Theme } from "@radix-ui/themes";

// The palette, fixed once for the whole app; no screen passes or overrides these.
export function AppTheme({ children }: { children?: ReactNode }) {
  return (
    <Theme
      accentColor="indigo"
      grayColor="slate"
      radius="large"
      scaling="100%"
    >
      {children}
    </Theme>
  );
}
