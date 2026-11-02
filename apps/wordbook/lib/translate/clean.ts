// MyMemory answers in HTML: «Es que ya no tengo tiempo.&#10;». The text reaches the screen, the record and the
// notes request as plain prose, so the entities are decoded and the line breaks folded here, at the source.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// One pass, so «&amp;#10;» decodes to «&#10;» and stops there instead of decoding twice.
const ENTITY = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/g;

function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, decimal?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? whole;
    const code = decimal !== undefined ? Number(decimal) : parseInt(hex ?? "", 16);
    return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

export function cleanProviderText(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}
