// The three cyan bars on graphite (docs/timelog/DESIGN.md), drawn for ImageResponse, which takes inline styles alone.
// `app/icon.svg` carries the same drawing as a file.
export function BrandMark({ size, radius }: { size: number; radius: number }) {
  const bar = (height: number) => ({ width: size * 0.16, height: size * height, borderRadius: size * 0.03, background: "#22d3ee" });
  return (
    <div style={{ width: size, height: size, display: "flex", alignItems: "flex-end", justifyContent: "center", gap: size * 0.06, padding: size * 0.19, borderRadius: radius, background: "#232c37" }}>
      <div style={bar(0.34)} />
      <div style={bar(0.62)} />
      <div style={bar(0.46)} />
    </div>
  );
}

// The share card: the mark beside the name, on the ground.
export function BrandCard() {
  return (
    <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 56, background: "#0c0e11", color: "#eef2f6" }}>
      <BrandMark size={280} radius={64} />
      <div style={{ display: "flex", fontSize: 150, fontWeight: 700, letterSpacing: -4 }}>TimeLog</div>
    </div>
  );
}
