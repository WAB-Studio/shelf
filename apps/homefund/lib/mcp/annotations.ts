import type { ToolAnnotations } from "@modelcontextprotocol/server";

// What a client's permission prompt reads before it lets Claude call a tool (RF-225). Every tool takes one of
// these five and none sets a hint by hand, so a tool's weight is decided where the class is, not at the call.
// `destructiveHint` follows the MCP spec: an update that overwrites is destructive, one that only adds is not.

/** Reads, writes nothing. */
export const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** Creates, never overwrites; a repeat makes a second row. */
export const ADD: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Creates under a `requestRef` or a natural key: a repeat answers the first row. */
export const ADD_ONCE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Overwrites what is stored: the same call again leaves the same state. */
export const OVERWRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
/** Removes or changes what a person cannot put back by repeating the call. */
export const DESTROY: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

type Say = (key: string) => string;

/** The title a client shows beside the identifier, from `mcp.titles`. */
export function titled(t: Say, key: string): { title: string } {
  return { title: t(`titles.${key}`) };
}

/** What an overwrite replaced: the stored value of each field the call sent, so a later patch can put it back. */
export function previousFields(stored: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(stored).filter((key) => patch[key] !== undefined).map((key) => [key, stored[key] ?? null]));
}
