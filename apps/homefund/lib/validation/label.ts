import { z } from "zod";

import { currencySchema, type CurrencyCode } from "@/lib/currency";
import { isCivilDate, todayInBogota } from "@/lib/dates";
import { CATEGORY_COLORS } from "@/lib/fund/category-color";
import { maxAmountMinor, parseAmount, toCents } from "@/lib/money";

const labelNameSchema = z
  .string()
  .trim()
  .min(1, { error: "labels.errors.nameRequired" })
  .max(80, { error: "labels.errors.nameTooLong" });

// A label shares the category palette (RF-70). It has no parent to inherit
// from, so it always carries its own colour.
const labelColorSchema = z
  .enum(CATEGORY_COLORS, { error: "labels.errors.colorRequired" })
  .nullable();

function requireColor(
  data: { color: string | null },
  ctx: z.RefinementCtx,
) {
  if (data.color === null) {
    ctx.addIssue({
      code: "custom",
      message: "labels.errors.colorRequired",
      path: ["color"],
    });
  }
}

// Where a new label lands: the caller's own set, or their group's (RF-70). The
// action turns this into the owner/group XOR the schema keeps off the wire.
export const LABEL_PLACEMENTS = ["personal", "group"] as const;

export const LABEL_KINDS = ["tag", "person"] as const;

// «Se le cobra» is the default of a person alone (RF-242): a tag has nobody to charge.
function requirePersonToCharge(
  data: { kind?: (typeof LABEL_KINDS)[number]; chargeDefault?: boolean; alreadyOwed?: unknown },
  ctx: z.RefinementCtx,
) {
  if (data.chargeDefault && data.kind === "tag") {
    ctx.addIssue({
      code: "custom",
      message: "labels.errors.chargeNeedsPerson",
      path: ["chargeDefault"],
    });
  }
  if (data.alreadyOwed && data.kind === "tag") {
    ctx.addIssue({
      code: "custom",
      message: "labels.errors.alreadyOwedNeedsPerson",
      path: ["alreadyOwed"],
    });
  }
}

// What a person already owed before any movement here (RF-319): the amount as the field writes it, read in its own
// currency, and the day it counts from. A person who owes nothing old sends no object at all.
export const alreadyOwedSchema = z
  .object({
    amount: z.string().trim().min(1, { error: "labels.errors.alreadyOwedAmountRequired" }),
    currency: z.enum(currencySchema.options, { error: "labels.errors.alreadyOwedCurrencyInvalid" }),
    since: z.string().superRefine((value, ctx) => {
      if (!isCivilDate(value)) ctx.addIssue("labels.errors.alreadyOwedDateInvalid");
      else if (value > todayInBogota()) ctx.addIssue("labels.errors.alreadyOwedDateInFuture");
    }),
  })
  .superRefine((data, ctx) => {
    // The field said so already; saying it twice puts two messages on one control.
    if (data.amount.length === 0) return;
    const minor = parseAmount(data.amount);
    if (minor === null || minor <= 0) {
      ctx.addIssue({ code: "custom", message: "labels.errors.alreadyOwedAmountInvalid", path: ["amount"] });
    } else if (minor > maxAmountMinor(data.currency)) {
      ctx.addIssue({ code: "custom", message: "labels.errors.alreadyOwedAmountTooLarge", path: ["amount"] });
    }
  });

export type AlreadyOwedInput = z.infer<typeof alreadyOwedSchema>;

export type AlreadyOwed = { cents: number; currency: CurrencyCode; since: string };

/** The stored shape of a validated field: `undefined` keeps what is stored, `null` removes it. */
export function alreadyOwedOf(value: AlreadyOwedInput | null | undefined): AlreadyOwed | null | undefined {
  if (value === undefined || value === null) return value;
  return { cents: toCents(value.amount), currency: value.currency, since: value.since };
}

export const createLabelSchema = z
  .object({
    name: labelNameSchema,
    color: labelColorSchema,
    // A free tag, or a person a movement is for (RF-242); fixed once created.
    kind: z.enum(LABEL_KINDS, { error: "labels.errors.kindInvalid" }).default("tag"),
    chargeDefault: z.boolean().default(false),
    // A person alone; setting it makes the person «se le cobra» (RF-319).
    alreadyOwed: alreadyOwedSchema.nullable().optional(),
    // The owner or group is resolved from the session, so only the placement travels.
    placement: z.enum(LABEL_PLACEMENTS, { error: "labels.errors.placementInvalid" }),
  })
  .superRefine(requireColor)
  .superRefine(requirePersonToCharge);

export type CreateLabelInput = z.infer<typeof createLabelSchema>;

// A label never changes scope, so the placement is absent from an edit.
export const updateLabelSchema = z
  .object({
    labelId: z.uuid({ error: "errors.notFound" }),
    name: labelNameSchema,
    color: labelColorSchema,
    // Absent keeps what is stored; a tag stores false whatever arrives.
    chargeDefault: z.boolean().optional(),
    // Absent keeps what is stored; null removes it; a value sets it and turns «se le cobra» on (RF-319).
    alreadyOwed: alreadyOwedSchema.nullable().optional(),
  })
  .superRefine(requireColor);

export type UpdateLabelInput = z.infer<typeof updateLabelSchema>;

export const deleteLabelSchema = z.object({
  labelId: z.uuid({ error: "errors.notFound" }),
});

