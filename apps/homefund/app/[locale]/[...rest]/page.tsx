import { notFound } from "next/navigation";

// A path no route claims inside a locale lands here, so the locale's own
// `not-found.tsx` answers it instead of Next's unstyled default.
export default function UnmatchedRoute() {
  notFound();
}
