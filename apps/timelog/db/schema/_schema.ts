import { pgSchema } from "drizzle-orm/pg-core";

// Every table TimeLog owns, beside `finances`, `reading` and `goals` in the same database.
export const timeSchema = pgSchema("timelog");
