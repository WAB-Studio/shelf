import { Badge } from "@radix-ui/themes";

// The small pill that names the active fund wherever a write can happen.
export function FundChip({ label }: { label: string }) {
  return (
    <Badge color="gray" variant="soft" radius="full">
      {label}
    </Badge>
  );
}
