import { pgSchema } from "drizzle-orm/pg-core";

// Every table this app owns lives here. A second app in the same database can
// then take a name this one already uses — `notes`, `categories`, `labels` —
// without either one having to rename anything.
export const finances = pgSchema("finances");
