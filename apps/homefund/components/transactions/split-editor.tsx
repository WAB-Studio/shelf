"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";

import {
  Button,
  CategoryTile,
  Flex,
  IconButton,
  Select,
  Text,
  TextField,
} from "@/components/ui";
import type { ScopedCategory } from "@/db/queries/transaction-form";
import type { CurrencyCode } from "@/lib/currency";
import { formatMoney, parseAmount } from "@/lib/money";

// A split as the form owns it: a category and a typed string, minor units only
// under the hood. Kept identical to the form's `splits` element so
// `value`/`onChange` hand straight to a React Hook Form field.
type Split = { categoryId: string; amount: string };

// A row's typed string in minor units, or zero while it is empty or half-typed:
// the remainder must read as the whole total until a figure lands, never as NaN.
function toMinor(amount: string): number {
  return parseAmount(amount) ?? 0;
}

/**
 * Assigns an income or expense across categories of its own scope and kind
 * (RF-62). It mirrors `refineSplits` on screen — one or more rows summing to the
 * total (RF-69) — and shows the live remainder the form's schema enforces; a
 * transfer never mounts it. Every row is in the movement's own currency: a split
 * never changes currency (RF-121), and money stays an integer of its minor unit.
 */
export function SplitEditor({
  total,
  currency,
  scope,
  kind,
  categories,
  value,
  onChange,
}: {
  total: string;
  currency: CurrencyCode;
  scope: "personal" | "group";
  kind: "expense" | "income";
  categories: ScopedCategory[];
  value: Split[];
  onChange: (splits: Split[]) => void;
}) {
  const t = useTranslations("transactions");
  const locale = useLocale();

  // Only the movement's scope and kind, parents and their children flattened
  // into one pickable list (a child wears its parent's colour already).
  const options = useMemo(
    () =>
      categories
        .filter((category) => category.scope === scope && category.kind === kind)
        .flatMap((category) => [
          { id: category.id, name: category.name, color: category.color },
          ...category.children.map((child) => ({
            id: child.id,
            name: child.name,
            color: child.color,
          })),
        ]),
    [categories, scope, kind],
  );

  const remainderMinor =
    toMinor(total) - value.reduce((sum, split) => sum + toMinor(split.amount), 0);

  function updateSplit(index: number, patch: Partial<Split>) {
    onChange(
      value.map((split, at) => (at === index ? { ...split, ...patch } : split)),
    );
  }

  function removeSplit(index: number) {
    onChange(value.filter((_, at) => at !== index));
  }

  function addSplit() {
    onChange([...value, { categoryId: "", amount: "" }]);
  }

  return (
    <Flex direction="column" gap="3" width="100%">
      {value.map((split, index) => {
        // Three rows make three identical triples otherwise: each control names
        // the row it belongs to.
        const position = index + 1;
        const color =
          options.find((option) => option.id === split.categoryId)?.color ??
          null;

        return (
          <Flex key={index} align="center" gap="3">
            <CategoryTile color={color} size={14} />
            {/* The artboard draws the category and its amount on one 42px line.
                Only from `md` up: a phone has no width to spare, and the wider
                trigger pushes the sheet past the viewport. */}
            <Select.Root
              size={{ initial: "2", md: "3" }}
              value={split.categoryId || undefined}
              onValueChange={(categoryId) => updateSplit(index, { categoryId })}
            >
              {/* Takes the row and gives it back. Radix pins `flex-shrink: 0`
                  on its own trigger, so the floor at zero alone leaves the row
                  as wide as the longest category name and the sheet grows past
                  a phone's width to hold it. */}
              <Flex asChild flexGrow="1" flexShrink="1" minWidth="0">
                <Select.Trigger
                  placeholder={t("categoryLabel")}
                  aria-label={t("splitRowCategory", { position })}
                />
              </Flex>
              <Select.Content position="popper">
                {options.map((option) => (
                  <Select.Item key={option.id} value={option.id}>
                    {option.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            <TextField.Root
              size="3"
              value={split.amount}
              onChange={(event) =>
                updateSplit(index, { amount: event.target.value })
              }
              inputMode="numeric"
              aria-label={t("splitRowAmount", { position })}
              style={{ width: 110, fontVariantNumeric: "tabular-nums" }}
            />
            <IconButton
              type="button"
              tap
              variant="ghost"
              color="gray"
              aria-label={t("splitRowRemove", { position })}
              onClick={() => removeSplit(index)}
            >
              <XIcon size={16} />
            </IconButton>
          </Flex>
        );
      })}

      <Flex justify="center">
        <Button type="button" tap variant="ghost" onClick={addSplit}>
          <PlusIcon size={16} />
          {t("splitAddCategory")}
        </Button>
      </Flex>

      {/* The live gap the schema refuses to let through: green at rest, red the
          moment the rows stop summing to the total. */}
      <Flex
        align="center"
        justify="between"
        px="3"
        py="2"
        style={{
          borderRadius: "var(--radius-3)",
          background:
            remainderMinor === 0 ? "var(--grass-a3)" : "var(--red-a3)",
        }}
      >
        <Text size="2" weight="medium" color={remainderMinor === 0 ? "grass" : "red"}>
          {t("splitUnassigned")}
        </Text>
        <Text
          size="2"
          weight="bold"
          color={remainderMinor === 0 ? "grass" : "red"}
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {formatMoney(remainderMinor, currency, locale)}
        </Text>
      </Flex>
    </Flex>
  );
}
