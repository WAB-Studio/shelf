"use client";

import { Button, PrintHidden } from "@/components/ui";

// Hands the page to the browser's print on tap, never on load (RP-49). The
// label comes in as a prop, the way the nav's own do.
export function PrintButton({ label }: { label: string }) {
  return (
    <PrintHidden>
      <Button block onClick={() => window.print()}>
        {label}
      </Button>
    </PrintHidden>
  );
}
