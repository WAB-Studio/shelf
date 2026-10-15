"use client";

// THROWAWAY prototype of the «cuadre» dialog (boards B1-B7). Hardwired figures,
// the state read from `?cuadre=`, no action behind any button.
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";

import {
  Button,
  Dialog,
  Field,
  FieldControl,
  FieldError,
  FieldGroup,
  FieldLabel,
  Flex,
  Heading,
  Money,
  Separator,
  Spinner,
  Text,
  TextField,
} from "@/components/ui";

const DERIVED = 125_000_000;

type Variant = {
  real: string;
  history: "empty" | "full";
  pending?: boolean;
  error?: string;
  gap?: number;
};

const VARIANTS: Record<string, Variant> = {
  B1: { real: "", history: "full" },
  B2: { real: "1.262.000", history: "full", gap: 1_200_000 },
  B3: { real: "1.242.000", history: "full", gap: -800_000 },
  B4: { real: "1.250.000", history: "full", gap: 0 },
  B5: { real: "1.262.000", history: "full", gap: 1_200_000, pending: true },
  B5b: { real: "", history: "full", error: "Escribe el saldo real." },
  "B5b-stale": {
    real: "1.262.000",
    history: "full",
    gap: 1_200_000,
    error:
      "Los movimientos de la cuenta cambiaron. Revisa el descuadre y vuelve a confirmar.",
  },
  B6: { real: "", history: "empty" },
  B7: { real: "", history: "full" },
};

function Signed({ cents }: { cents: number }) {
  return (
    <>
      {cents > 0 ? "+" : ""}
      <Money minor={cents} currency="COP" tone="plain" size="inherit" />
    </>
  );
}

function HistoryRow({
  day,
  gap,
  derived,
  real,
}: {
  day: string;
  gap: number;
  derived: number;
  real: number;
}) {
  return (
    <Flex direction="column">
      <Flex justify="between" align="baseline">
        <Text size="3" weight="bold">
          {day}
        </Text>
        <Text size="3" weight="medium">
          {gap === 0 ? "Cuadró" : <Signed cents={gap} />}
        </Text>
      </Flex>
      <Text size="2" color="gray">
        Según HomeFund{" "}
        <Money minor={derived} currency="COP" tone="plain" size="inherit" signed={false} /> ·
        Real <Money minor={real} currency="COP" tone="plain" size="inherit" signed={false} />
      </Text>
    </Flex>
  );
}

export function ProtoCuadreDialog({
  accountName,
  open,
  onOpenChange,
}: {
  accountName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const params = useSearchParams();
  const key = params.get("cuadre") ?? "B1";
  const v = VARIANTS[key] ?? VARIANTS.B1;
  const isDone = key === "B7";

  useEffect(() => {
    if (open && isDone) toast.success("Cuenta cuadrada");
  }, [open, isDone]);

  const pastRows = isDone
    ? [{ day: "14 oct 2026", gap: 1_200_000, derived: DERIVED, real: DERIVED + 1_200_000 }]
    : [];
  const rows = [
    ...pastRows,
    { day: "30 sep 2026", gap: 0, derived: 98_000_000, real: 98_000_000 },
    { day: "2 sep 2026", gap: -800_000, derived: 101_500_000, real: 100_700_000 },
  ];
  const derived = isDone ? DERIVED + 1_200_000 : DERIVED;
  const typed = v.real !== "";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>Cuadrar {accountName}</Dialog.Title>
        <Text as="p" size="2" color="gray" mb="4">
          En COP
        </Text>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="cuadre-day">Día</FieldLabel>
            <FieldControl>
              <TextField.Root
                id="cuadre-day"
                size="3"
                type="date"
                defaultValue="2026-10-14"
                readOnly={v.pending}
              />
            </FieldControl>
          </Field>
          <Flex justify="between" align="baseline">
            <Text size="3" color="gray">
              Según HomeFund
            </Text>
            <Text size="3" weight="medium">
              <Money minor={derived} currency="COP" tone="plain" size="inherit" />
            </Text>
          </Flex>
          <Field invalid={!!v.error}>
            <FieldLabel htmlFor="cuadre-real">Saldo real</FieldLabel>
            <FieldControl>
              <TextField.Root
                id="cuadre-real"
                size="3"
                inputMode="numeric"
                defaultValue={isDone ? "" : v.real}
                readOnly={v.pending}
                key={key}
              />
            </FieldControl>
            {v.error && <FieldError>{v.error}</FieldError>}
          </Field>
          {typed && v.gap !== undefined && !isDone && (
            <Flex direction="column" gap="1">
              <Flex justify="between" align="baseline">
                <Text size="3" color="gray">
                  Descuadre
                </Text>
                <Text size="3" weight="medium">
                  {v.gap === 0 ? (
                    <Money minor={0} currency="COP" tone="plain" size="inherit" />
                  ) : (
                    <Signed cents={v.gap} />
                  )}
                </Text>
              </Flex>
              <Text size="2" color="gray">
                {v.gap === 0
                  ? "Cuadra. No se registra ningún movimiento."
                  : "Se registra como un movimiento de descuadre del 14 oct."}
              </Text>
            </Flex>
          )}
          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button type="button" variant="ghost" color="gray" disabled={v.pending}>
                Cancelar
              </Button>
            </Dialog.Close>
            <Button type="button" disabled={v.pending}>
              {v.pending && <Spinner />}
              {v.pending ? "Cuadrando…" : "Cuadrar"}
            </Button>
          </Flex>
        </FieldGroup>
        <Separator size="4" my="4" />
        <Heading as="h3" size="3" mb="3">
          Cuadres
        </Heading>
        {v.history === "empty" ? (
          <Text size="2" color="gray">
            Aún no has cuadrado esta cuenta.
          </Text>
        ) : (
          <Flex direction="column" gap="3">
            {rows.map((row) => (
              <HistoryRow key={row.day} {...row} />
            ))}
          </Flex>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
