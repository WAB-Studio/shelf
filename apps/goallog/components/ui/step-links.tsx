import { ChevronLeft, ChevronRight } from "lucide-react";

import { Flex } from "@radix-ui/themes";
import { TextLink } from "./text-link";

function Step({ href, label, icon }: { href: string | null; label: string; icon: "prev" | "next" }) {
  // An empty slot keeps the other arrow on its own side of the row.
  if (href === null) return <Flex flexGrow="1" aria-hidden />;
  return (
    <TextLink href={href} nowrap>
      <Flex as="span" align="center" gap="1">
        {icon === "prev" ? <ChevronLeft size={16} aria-hidden /> : null}
        {label}
        {icon === "next" ? <ChevronRight size={16} aria-hidden /> : null}
      </Flex>
    </TextLink>
  );
}

/** ‹ › one step back and forward, for Semana and «Mes»; a null end draws nothing. */
export function StepLinks({ prev, next }: { prev: { href: string | null; label: string }; next: { href: string | null; label: string } }) {
  return (
    <>
      <Step {...prev} icon="prev" />
      <Step {...next} icon="next" />
    </>
  );
}
