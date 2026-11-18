import { z } from "zod";

import { CATEGORY_COLORS } from "@/lib/fund/category-color";

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
  data: { kind?: (typeof LABEL_KINDS)[number]; chargeDefault?: boolean },
  ctx: z.RefinementCtx,
) {
  if (data.chargeDefault && data.kind === "tag") {
    ctx.addIssue({
      code: "custom",
      message: "labels.errors.chargeNeedsPerson",
      path: ["chargeDefault"],
    });
  }
}

export const createLabelSchema = z
  .object({
    name: labelNameSchema,
    color: labelColorSchema,
    // A free tag, or a person a movement is for (RF-242); fixed once created.
    kind: z.enum(LABEL_KINDS, { error: "labels.errors.kindInvalid" }).default("tag"),
    chargeDefault: z.boolean().default(false),
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
  })
  .superRefine(requireColor);

export type UpdateLabelInput = z.infer<typeof updateLabelSchema>;

export const deleteLabelSchema = z.object({
  labelId: z.uuid({ error: "errors.notFound" }),
});

