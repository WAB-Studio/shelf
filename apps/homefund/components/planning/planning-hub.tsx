import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { PLANNING_KEYS, destinations } from "@/components/fund/destinations";
import { Box, Card, Flex, FundChip, Grid, Heading, Text } from "@/components/ui";
import { Link as LocaleLink } from "@/i18n/navigation";

// The hub's own order for its five cards. `PLANNING_KEYS` stays the sidebar's
// order — `PlanningSubNav`'s chips read it directly — so the hub keeps its own
// list rather than reordering the shared one.
const HUB_ORDER = [
  "budgets",
  "goals",
  "payments",
  "debts",
  "recurring",
] as const satisfies readonly (typeof PLANNING_KEYS)[number][];

// The one place a card's colour lives: `destinations.ts` owns the route and the
// icon, and neither carries a tint of its own.
const TINTS: Record<(typeof PLANNING_KEYS)[number], string> = {
  budgets: "jade",
  goals: "grass",
  payments: "amber",
  debts: "indigo",
  recurring: "violet",
};

/**
 * The Planeación hub: one card per area, each carrying a live one-line summary
 * derived on the server and a link into its screen. Its five areas and their
 * routes come from `destinations.ts`, the one file that lists them.
 */
export async function PlanningHub({
  groupName,
  budgetsSummary,
  goalsSummary,
  paymentsSummary,
  debtsSummary,
  recurringSummary,
}: {
  groupName: string | null;
  budgetsSummary: string;
  goalsSummary: string;
  paymentsSummary: string;
  debtsSummary: string;
  recurringSummary: string;
}) {
  const t = await getTranslations("planning");
  const tKey = await getTranslations();

  const titles: Record<(typeof PLANNING_KEYS)[number], string> = {
    budgets: t("budgetsTitle"),
    goals: t("goalsTitle"),
    payments: t("paymentsTitle"),
    debts: t("debtsTitle"),
    recurring: t("recurringTitle"),
  };
  const summaries: Record<(typeof PLANNING_KEYS)[number], string> = {
    budgets: budgetsSummary,
    goals: goalsSummary,
    payments: paymentsSummary,
    debts: debtsSummary,
    recurring: recurringSummary,
  };

  // `destinations()` answers the full catalogue's key type; PLANNING_KEYS never
  // asks it for anything outside its own five, so a lookup by key never misses.
  const areas = new Map(
    destinations(PLANNING_KEYS, true).map((area) => [area.key, area]),
  );

  return (
    <Flex direction="column" gap="4">
      <Flex align="center" gap="2">
        <Heading size="6">{t("title")}</Heading>
        {groupName !== null && <FundChip label={tKey("fund.label")} />}
      </Flex>

      <Flex direction="column" gap="3">
        {HUB_ORDER.map((key) => {
          const area = areas.get(key);
          if (!area) return null;
          return (
            <HubCard
              key={key}
              icon={area.icon}
              tint={TINTS[key]}
              title={titles[key]}
              summary={summaries[key]}
              href={area.href}
            />
          );
        })}
      </Flex>
    </Flex>
  );
}

// A row card: enabled when it names an href, muted with no chevron when it does
// not. The icon rides a soft tinted disc; the summary carries the derived line.
// Below `md` it stacks the title over the summary; from `md` up it gains a
// three-column row, title, summary and chevron each keeping their own width
// so the five rows line up.
function HubCard({
  icon: Icon,
  tint,
  title,
  summary,
  href,
}: {
  icon: LucideIcon;
  tint: string;
  title: string;
  summary: string;
  href?: string;
}) {
  const disc = (
    <Flex
      align="center"
      justify="center"
      style={{
        width: 44,
        height: 44,
        borderRadius: "var(--radius-5)",
        background: href ? `var(--${tint}-a3)` : "var(--gray-a3)",
        color: href ? `var(--${tint}-11)` : "var(--gray-9)",
        flexShrink: 0,
      }}
    >
      <Icon size={21} />
    </Flex>
  );

  const titleText = (
    <Text weight="bold" color={href ? undefined : "gray"} truncate>
      {title}
    </Text>
  );

  const summaryText = (
    <Text size="2" color="gray" truncate>
      {summary}
    </Text>
  );

  const chevron = href && <ChevronRight size={18} color="var(--gray-9)" />;

  const body = (
    <Card>
      <Box display={{ initial: "block", md: "none" }}>
        <Flex align="center" gap="3">
          {disc}
          <Flex direction="column" gap="1" style={{ flex: 1, minWidth: 0 }}>
            {titleText}
            {summaryText}
          </Flex>
          {chevron}
        </Flex>
      </Box>

      <Box display={{ initial: "none", md: "block" }}>
        <Grid columns="1fr 220px 210px" gap="4" align="center">
          <Flex align="center" gap="3" style={{ minWidth: 0 }}>
            {disc}
            {titleText}
          </Flex>
          {summaryText}
          <Flex justify="end">{chevron}</Flex>
        </Grid>
      </Box>
    </Card>
  );

  if (!href) return body;

  return (
    <LocaleLink href={href} style={{ textDecoration: "none", color: "inherit" }}>
      {body}
    </LocaleLink>
  );
}
