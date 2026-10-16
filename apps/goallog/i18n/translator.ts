import type { Messages, MessageKeys, NamespaceKeys, NestedKeyOf } from "next-intl";
import type { getTranslations } from "next-intl/server";

// What `getTranslations(namespace)` returns, spelled out: the bare
// `ReturnType<typeof getTranslations>` leaves the namespace at its constraint
// and no key matches it.
export type Translator<Namespace extends NamespaceKeys<Messages, NestedKeyOf<Messages>> = never> = Awaited<
  ReturnType<typeof getTranslations<Namespace>>
>;

// Every key of the root translator, `week.today` and the like.
export type MessageKey = MessageKeys<Messages, NestedKeyOf<Messages>>;

// An evidence source's label: a key whose `…Unit` twin names its unit.
export type SourceKey = Extract<MessageKey extends infer K ? (K extends `${infer Base}Unit` ? Base : never) : never, MessageKey>;

// For a source key a database row or a command line carries.
export function sourceKey(raw: string): SourceKey {
  return raw as SourceKey;
}

// For a key that data carries rather than source code: a Zod issue's message,
// a draft's refusal. The producers write catalogue keys, and next-intl prints
// the path for one that is not.
export function messageKey(raw: string): MessageKey {
  return raw as MessageKey;
}
