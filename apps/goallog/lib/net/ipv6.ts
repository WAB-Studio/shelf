// The 16 bytes of an IPv6 literal, however it is written: `::`, a dotted v4 tail, a zone id.
// Null when it does not parse.
export function ipv6Bytes(address: string): number[] | null {
  let text = address.split("%")[0].toLowerCase();
  const dotted = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  const tail: number[] = [];
  if (dotted) {
    const octets = dotted.slice(2).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    tail.push(octets[0] * 256 + octets[1], octets[2] * 256 + octets[3]);
    text = `${dotted[1]}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const read = (part: string) => (part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16)));
  const head = read(halves[0]);
  const rest = halves.length === 2 ? read(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest];
  if (!words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)) return null;
  if (dotted) words.splice(6, 2, ...tail);

  return words.flatMap((word) => [word >> 8, word & 0xff]);
}
