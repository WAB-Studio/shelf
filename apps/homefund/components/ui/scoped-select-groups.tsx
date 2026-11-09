import type { ReactNode } from "react";
import { Select } from "@radix-ui/themes";

/**
 * The fund's options and the person's own, under one heading each, so two
 * categories that share a name read apart. A list holding only one scope needs
 * no heading and is returned bare.
 */
export function ScopedSelectGroups({
  fund,
  personal,
  fundHeading,
  personalHeading,
}: {
  fund: ReactNode[];
  personal: ReactNode[];
  fundHeading: string;
  personalHeading: string;
}) {
  if (fund.length === 0 || personal.length === 0) {
    return <>{fund.length === 0 ? personal : fund}</>;
  }

  return (
    <>
      <Select.Group>
        <Select.Label>{fundHeading}</Select.Label>
        {fund}
      </Select.Group>
      <Select.Group>
        <Select.Label>{personalHeading}</Select.Label>
        {personal}
      </Select.Group>
    </>
  );
}
