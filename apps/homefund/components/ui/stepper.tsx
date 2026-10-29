import { Fragment, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Box, Flex, Text } from "@radix-ui/themes";

import { Disc } from "./disc";

export type StepperStep = {
  key: string | number;
  label: ReactNode;
  // The number a waiting or active step wears; a done step wears a check.
  number: number;
  state: "done" | "active" | "todo";
};

/**
 * The first-run steps: a disc and a label per step, joined by a hairline. Done
 * and active steps fill with the accent; the rest wait in grey.
 */
export function Stepper({ steps }: { steps: StepperStep[] }) {
  return (
    <Flex align="start" py="4">
      {steps.map(({ key, label, number, state }, index) => {
        const filled = state !== "todo";

        return (
          <Fragment key={key}>
            {index > 0 && (
              <Box
                flexGrow="1"
                style={{
                  height: 2,
                  marginTop: 15,
                  marginInline: 6,
                  borderRadius: 999,
                  backgroundColor: "var(--gray-5)",
                }}
              />
            )}
            <Flex direction="column" align="center" gap="2" style={{ width: 60 }}>
              <Disc
                size={32}
                fontSize={14}
                fontWeight={700}
                surface={filled ? "var(--accent-9)" : "var(--gray-4)"}
                ink={filled ? "var(--accent-contrast)" : "var(--gray-9)"}
              >
                {state === "done" ? <Check size={16} strokeWidth={2.6} aria-hidden /> : number}
              </Disc>
              <Text
                size="1"
                weight={filled ? "medium" : "regular"}
                color={filled ? undefined : "gray"}
              >
                {label}
              </Text>
            </Flex>
          </Fragment>
        );
      })}
    </Flex>
  );
}
