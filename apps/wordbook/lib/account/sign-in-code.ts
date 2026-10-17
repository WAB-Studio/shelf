import { z } from "zod";

export const signInCodeSchema = z.string().trim().regex(/^\d{6}$/);
