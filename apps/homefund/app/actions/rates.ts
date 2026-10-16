"use server";

import { z } from "zod";

import { fetchRate } from "@/lib/rates/source";
import { authActionClient } from "@/lib/safe-action";

// Any ISO code, not only the two the selector offers: the foreign side of a
// movement can be a currency an account settled in before the selector was
// narrowed to COP and USD (RF-121).
const proposeRateSchema = z.object({
  from: z.string().length(3),
  to: z.string().length(3),
});

/**
 * Proposes an exchange rate for the counterpart amount, read from a public
 * source with no key and no registration (RF-122, RNF-13). Returns `null`
 * rather than throwing on a network failure, a timeout or a currency the
 * source does not cover, so the form has one shape to handle: fill the field,
 * or leave it for a person to type.
 */
export const proposeRateAction = authActionClient
  .inputSchema(proposeRateSchema)
  .action(async ({ parsedInput: { from, to } }) => {
    return await fetchRate(from, to);
  });
