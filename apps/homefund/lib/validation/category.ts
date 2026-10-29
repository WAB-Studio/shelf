import { z } from "zod";

import { CATEGORY_COLORS } from "@/lib/fund/category-color";

// The list the screens and both sides of validation read for a category's kind (RF-27).
export const CATEGORY_KINDS = ["expense", "income"] as const;

const categoryNameSchema = z
  .string()
  .trim()
  .min(1, { error: "categories.errors.nameRequired" })
  .max(80, { error: "categories.errors.nameTooLong" });

const categoryParentIdSchema = z
  .uuid({ error: "categories.errors.parentInvalid" })
  .nullable();

// Every category picks its own colour, parent or child alike; a subcategory
// never inherits its parent's.
const categoryColorSchema = z.enum(CATEGORY_COLORS, {
  error: "categories.errors.colorRequired",
});

// The scope (personal or group) is resolved from the session (RF-63), so it
// never travels in the payload.
export const createCategorySchema = z.object({
  name: categoryNameSchema,
  kind: z.enum(CATEGORY_KINDS, { error: "categories.errors.kindInvalid" }),
  parentId: categoryParentIdSchema,
  color: categoryColorSchema,
});

export const CATEGORY_PLACEMENTS = ["personal", "group"] as const;

export const createCategoryInputSchema = createCategorySchema.extend({
  placement: z.enum(CATEGORY_PLACEMENTS, { error: "categories.errors.placementInvalid" }).optional(),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

// `kind` is immutable after creation, so it never appears in the update schema.
export const updateCategorySchema = z.object({
  categoryId: z.uuid({ error: "errors.notFound" }),
  name: categoryNameSchema,
  parentId: categoryParentIdSchema,
  color: categoryColorSchema,
});

export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const deleteCategorySchema = z.object({
  categoryId: z.uuid({ error: "errors.notFound" }),
});

