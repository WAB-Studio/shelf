import { z } from "zod";

// The schemas a form checks before it sends and its action checks again on the server.
export const keyNameSchema = z.string().trim().min(1).max(60);

export const signInEmailSchema = z.string().trim().toLowerCase().pipe(z.email());
