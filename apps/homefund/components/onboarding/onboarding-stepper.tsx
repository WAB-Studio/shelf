"use client";

import { useTranslations } from "next-intl";

import { Stepper } from "@/components/ui";

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
    <Stepper
      steps={STEPS.map(({ step, label }) => ({
        key: step,
        label: t(label),
        number: step,
        state: step < current ? "done" : step === current ? "active" : "todo",
      }))}
    />
  );
}
