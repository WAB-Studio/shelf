"use client";

import { Fragment } from "react";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";

import { Box, Flex, Text } from "@/components/ui";

// The three first-run steps, in order (RF-64). A step before `current` is done,
// the one that matches it is active, the rest wait their turn.
const STEPS = [
  { step: 1, label: "steps.fund" },
  { step: 2, label: "steps.accounts" },
  { step: 3, label: "steps.invite" },
] as const;

export function OnboardingStepper({ current }: { current: 1 | 2 | 3 }) {
  const t = useTranslations("onboarding");

  return (
    <Flex align="start" py="4">
      {STEPS.map(({ step, label }, index) => {
        const done = step < current;
        const active = step === current;
        const filled = done || active;

        return (
          <Fragment key={step}>
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
            <Flex
              direction="column"
              align="center"
              gap="2"
              style={{ width: 60 }}
            >
              <Flex
                align="center"
                justify="center"
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  fontSize: 14,
                  fontWeight: 700,
                  backgroundColor: filled ? "var(--accent-9)" : "var(--gray-4)",
                  color: filled ? "var(--accent-contrast)" : "var(--gray-9)",
                }}
              >
                {done ? <Check size={16} strokeWidth={2.6} aria-hidden /> : step}
              </Flex>
              <Text
                size="1"
                weight={filled ? "medium" : "regular"}
                color={filled ? undefined : "gray"}
              >
                {t(label)}
              </Text>
            </Flex>
          </Fragment>
        );
      })}
    </Flex>
  );
}
