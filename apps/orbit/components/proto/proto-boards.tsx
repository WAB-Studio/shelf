"use client";

// THROWAWAY prototype of boards B9-B12, hardwired. Never merged.
import { ChevronLeftIcon, Scale } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { DashboardSummary } from "@/components/reports/dashboard-summary";
import { ReportsScreen } from "@/components/reports/reports-screen";
import {
  Card,
  CategoryTile,
  Flex,
  Heading,
  IconButton,
  Money,
  MovementRow,
  Page,
  Separator,
  StackedSegmentedControl,
  Text,
} from "@/components/ui";
import type { DashboardData } from "@/db/queries/reports/dashboard";
import type { ReportsData } from "@/db/queries/reports/reports-screen";

const AdjustTile = () => (
  <CategoryTile color={null} icon={<Scale size={18} color="var(--gray-11)" />} />
);

function Signed({ cents }: { cents: number }) {
  return (
    <>
      {cents > 0 ? "+" : ""}
      <Money minor={cents} currency="COP" tone="plain" size="inherit" />
    </>
  );
}

function AdjustRow({ cents, account }: { cents: number; account: string }) {
  return (
    <Card>
      <MovementRow
        tile={<AdjustTile />}
        title="Descuadre"
        subtitle={account}
        amount={<Signed cents={cents} />}
      />
    </Card>
  );
}

function OrdinaryRow({
  title,
  subtitle,
  cents,
  color,
}: {
  title: string;
  subtitle: string;
  cents: number;
  color: string;
}) {
  return (
    <Card>
      <MovementRow
        tile={<CategoryTile color={color} />}
        title={title}
        subtitle={subtitle}
        amount={<Money minor={cents} currency="COP" tone="expense" size="inherit" />}
      />
    </Card>
  );
}

function Day({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Flex direction="column" gap="2">
      <Text size="1" weight="bold" color="gray">
        {label}
      </Text>
      <Flex direction="column" gap="2">
        {children}
      </Flex>
    </Flex>
  );
}

function B9() {
  return (
    <Flex direction="column" gap="4">
      <Flex direction="column" gap="1">
        <Heading size="5">Movimientos</Heading>
        <Text size="2" color="gray">
          5 movimientos · −$ 112.500 COP
        </Text>
      </Flex>
      <StackedSegmentedControl.Root value="all" onValueChange={() => {}}>
        <StackedSegmentedControl.Item value="all">Todos</StackedSegmentedControl.Item>
        <StackedSegmentedControl.Item value="expense">Gastos</StackedSegmentedControl.Item>
        <StackedSegmentedControl.Item value="income">Ingresos</StackedSegmentedControl.Item>
        <StackedSegmentedControl.Item value="transfer">Transferencias</StackedSegmentedControl.Item>
      </StackedSegmentedControl.Root>
      <Day label="HOY">
        <AdjustRow cents={1_200_000} account="Bancolombia ahorros" />
        <OrdinaryRow title="Supermercado" subtitle="Bancolombia ahorros" cents={8_450_000} color="var(--tomato-9)" />
      </Day>
      <Day label="AYER">
        <AdjustRow cents={-800_000} account="Efectivo" />
        <OrdinaryRow title="Transporte" subtitle="Efectivo" cents={1_200_000} color="var(--blue-9)" />
      </Day>
    </Flex>
  );
}

function B10() {
  return (
    <Flex direction="column" gap="4">
      <Flex align="center" gap="3">
        <IconButton variant="ghost" color="gray" aria-label="Movimientos">
          <ChevronLeftIcon size={18} />
        </IconButton>
        <Heading size="5" style={{ flex: 1 }}>
          Detalle
        </Heading>
      </Flex>
      <Flex direction="column" align="center" gap="2" py="4">
        <CategoryTile
          color={null}
          size={60}
          icon={<Scale size={26} color="var(--gray-11)" />}
        />
        <Heading size="5">Descuadre</Heading>
        <span style={{ fontSize: 40, fontWeight: 700, letterSpacing: "-0.03em" }}>
          <Signed cents={1_200_000} />
        </span>
      </Flex>
      <Card>
        <Flex direction="column">
          <Flex justify="between">
            <Text size="2" color="gray">Cuenta</Text>
            <Text size="3">Bancolombia ahorros</Text>
          </Flex>
          <Separator size="4" my="3" />
          <Flex justify="between">
            <Text size="2" color="gray">Día</Text>
            <Text size="3">14 de octubre de 2026</Text>
          </Flex>
        </Flex>
      </Card>
      <Text size="2" color="gray">
        Se corrige cuadrando la cuenta de nuevo.
      </Text>
    </Flex>
  );
}

const DASH: DashboardData = {
  hasAccounts: true,
  netWorth: [
    {
      bucket: "member",
      ownerUserId: "u",
      groupId: null,
      currency: "COP",
      netWorthCents: 482_350_000,
      name: null,
      isSelf: true,
    },
  ],
  totalNetWorth: [{ currency: "COP", netWorthCents: 482_350_000 }],
  monthFlow: [
    {
      currency: "COP",
      incomeCents: 380_000_000,
      expenseCents: 214_500_000,
      netCents: 165_500_000,
      adjustmentCents: -800_000,
    } as DashboardData["monthFlow"][number],
  ],
  unreviewedCount: 0,
  pendingDeliveryCount: 0,
};

function B11() {
  return (
    <Flex direction="column" gap="4">
      <Heading size="5">Inicio</Heading>
      <DashboardSummary data={DASH} />
      <Flex direction="column" gap="2">
        <Text size="1" weight="bold" color="gray">
          RECIENTES
        </Text>
        <AdjustRow cents={-800_000} account="Efectivo" />
        <OrdinaryRow title="Supermercado" subtitle="Bancolombia ahorros" cents={8_450_000} color="var(--tomato-9)" />
      </Flex>
    </Flex>
  );
}

const months = ["2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01"];
const inc = [360, 372, 355, 380, 366, 380];
const exp = [290, 310, 270, 320, 301, 214];
const REPORTS: ReportsData = {
  expensesByCategory: [
    { categoryId: "1", name: "Mercado", color: "var(--tomato-9)", currency: "COP", totalCents: 84_500_000 },
    { categoryId: "2", name: "Transporte", color: "var(--blue-9)", currency: "COP", totalCents: 42_000_000 },
    { categoryId: "3", name: "Servicios", color: "var(--amber-9)", currency: "COP", totalCents: 31_800_000 },
  ],
  sixMonthFlow: months.map((monthStart, i) => ({
    monthStart,
    currency: "COP" as const,
    incomeCents: inc[i] * 1_000_000,
    expenseCents: exp[i] * 1_000_000,
  })),
  contributions: [],
  hasGroup: false,
};

export function ProtoBoards() {
  const board = useSearchParams().get("b") ?? "B9";

  return (
    <Page>
      {board === "B9" && <B9 />}
      {board === "B10" && <B10 />}
      {board === "B11" && <B11 />}
      {board === "B12" && <ReportsScreen data={REPORTS} adjustments={{ COP: -800_000 }} />}
    </Page>
  );
}
