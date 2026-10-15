import { VisuallyHidden } from "@radix-ui/themes";

// A region a screen reader watches, drawn nowhere. Mount it before the text
// it will carry: a node that arrives already filled is often not announced.
// `assertive` is for failures alone.
export function Live({ children, assertive = false }: { children?: string | null; assertive?: boolean }) {
  return (
    <VisuallyHidden role={assertive ? "alert" : "status"} aria-live={assertive ? "assertive" : "polite"} aria-atomic>
      {children ?? ""}
    </VisuallyHidden>
  );
}
