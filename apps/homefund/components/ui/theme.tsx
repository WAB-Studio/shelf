import type { ReactNode } from "react";
import { Theme } from "@radix-ui/themes";
import "@radix-ui/themes/styles.css";
import "./theme.css";

// The palette, fixed once for the whole app; no screen passes or overrides these.
export function AppTheme({ children }: { children?: ReactNode }) {
  return (
    <Theme
      accentColor="violet"
      grayColor="mauve"
      radius="large"
      scaling="100%"
    >
      {children}
    </Theme>
  );
}
