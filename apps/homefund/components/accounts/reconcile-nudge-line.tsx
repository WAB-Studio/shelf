import { useTranslations } from "next-intl";

import { Card, PlainLink, Text } from "@/components/ui";

// Inicio's «3 cuentas sin cuadrar hace más de un mes · Cuadrar todo» (RF-262): the one quiet line that
// stands for every account not counted in a month, and opens the screen that counts them.
export function ReconcileNudgeLine({ count }: { count: number }) {
  const t = useTranslations("dashboard");

  return (
    <Card asChild>
      <PlainLink href="/settings/accounts/reconcile">
        <Text size="2" weight="medium">
          {t("reconcileNudgeLine", { count })}
        </Text>
      </PlainLink>
    </Card>
  );
}
