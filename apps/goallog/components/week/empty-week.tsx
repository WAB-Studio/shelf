import Link from "next/link";

import { Button, Text } from "@/components/ui";

// A week with no goal open yet: the same shape and sentence family as the
// day's own empty state (`components/day/empty-day.tsx`), copied rather
// than imported — this screen owns nothing under `components/day/**`, and
// the two states are close enough in wording that inventing a second one
// would read as a second decision nobody took.
export function EmptyWeek({ title, action }: { title: string; action: string }) {
  return (
    <>
      <Text as="p">{title}</Text>
      <Button asChild>
        <Link href="/metas/nueva">{action}</Link>
      </Button>
    </>
  );
}
