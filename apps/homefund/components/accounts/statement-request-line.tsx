"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useAction } from "next-safe-action/hooks";

import { dismissStatementRequestAction, stopStatementRequestsAction } from "@/app/actions/accounts";
import { Button, Card, Flex, Text } from "@/components/ui";
import { civilDateToDate } from "@/lib/dates";
import type { StatementRequest } from "@/lib/statement-cadence";
import { useActionErrorToast } from "@/lib/use-action-toast";

/** «oct» for a month, «oct–dic» for a quarter: the period a statement covers, as a person says it. */
export function usePeriodLabel() {
  const format = useFormatter();

  return (period: { start: string; end: string; cadence: StatementRequest["cadence"] }) => {
    const month = (day: string) => format.dateTime(civilDateToDate(day), { month: "short" }).replace(/\.$/, "");
    return period.cadence === "monthly" ? month(period.start) : `${month(period.start)}–${month(period.end)}`;
  };
}

// Inicio's «Llegó el extracto de Ahorros 3397 (jul–sep). Pásaselo a Claude.» (RF-259): a statement is optional, so the
// line is one account's at a time and answers itself: «Ahora no» leaves that period alone, «No me lo pidas» turns the
// account's cadence off. It blocks nothing; the next account waiting shows once this one is answered.
export function StatementRequestLine({ requests }: { requests: StatementRequest[] }) {
  const t = useTranslations("dashboard");
  const periodLabel = usePeriodLabel();
  const onError = useActionErrorToast();
  const dismiss = useAction(dismissStatementRequestAction, { onError });
  const stop = useAction(stopStatementRequestsAction, { onError });
  const [first] = requests;
  if (!first) return null;

  const pending = dismiss.isPending || stop.isPending;

  return (
    <Card>
      <Flex direction="column" gap="2">
        <Text size="2" weight="medium">
          {t("statementRequest", { name: first.name, period: periodLabel(first) })}
        </Text>
        <Flex gap="3" wrap="wrap">
          <Button
            type="button"
            variant="ghost"
            color="gray"
            size="2"
            tap
            disabled={pending}
            onClick={() => dismiss.execute({ accountId: first.accountId })}
          >
            {t("statementRequestLater")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            color="gray"
            size="2"
            tap
            disabled={pending}
            onClick={() => stop.execute({ accountId: first.accountId })}
          >
            {t("statementRequestStop")}
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}
