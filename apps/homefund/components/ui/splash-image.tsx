// The iOS launch image's drawing (RF-188): Satori reads inline styles, not classes.
export function SplashImage({
  background,
  markSrc,
  markSize,
}: {
  background: string;
  markSrc: string;
  markSize: number;
}) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Satori draws an img, not next/image. */}
      <img src={markSrc} width={markSize} height={markSize} alt="" />
    </div>
  );
}
