// RL-41: the model is asked for a definition only when the caller wants one
// and no sense of the group carries the dictionary's own.
export function wantsDefinition(
  needDefinition: boolean,
  senses: readonly { definition: string | null }[],
): boolean {
  return needDefinition && senses.every((sense) => sense.definition === null);
}
