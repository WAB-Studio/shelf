import { User } from "lucide-react";

// The mark a person's own account or category wears where it stands beside the
// fund's: a glyph, never a suffix on the name. The caller passes the word it
// stands for so a reader announces it.
export function PersonalMark({ label }: { label: string }) {
  return (
    <User
      size={13}
      strokeWidth={2.2}
      role="img"
      aria-label={label}
      color="var(--gray-10)"
    />
  );
}
