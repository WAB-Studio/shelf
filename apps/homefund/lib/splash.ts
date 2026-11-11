// iOS draws a launch image only when one matches the device's CSS size, pixel ratio,
// orientation and theme exactly; these are the iPhones that run a current iOS, portrait.
const IPHONES = [
  [440, 956, 3],
  [402, 874, 3],
  [430, 932, 3],
  [393, 852, 3],
  [428, 926, 3],
  [390, 844, 3],
  [414, 896, 3],
  [414, 896, 2],
  [375, 812, 3],
  [414, 736, 3],
  [375, 667, 2],
] as const;

export type SplashTheme = "light" | "dark";

export type Splash = {
  width: number;
  height: number;
  ratio: number;
  theme: SplashTheme;
  // The file name under `/splash/`, e.g. `393x852-3-dark.png`.
  name: string;
};

// The page's own background, as the viewport's theme colour paints the status bar.
export const SPLASH_BACKGROUND: Record<SplashTheme, string> = {
  light: "#ffffff",
  dark: "#110c20",
};

export const SPLASHES: Splash[] = IPHONES.flatMap(([width, height, ratio]) =>
  (["light", "dark"] as const).map((theme) => ({
    width,
    height,
    ratio,
    theme,
    name: `${width}x${height}-${ratio}-${theme}.png`,
  })),
);

export function splashMedia({ width, height, ratio, theme }: Splash): string {
  return [
    `(device-width: ${width}px)`,
    `(device-height: ${height}px)`,
    `(-webkit-device-pixel-ratio: ${ratio})`,
    "(orientation: portrait)",
    `(prefers-color-scheme: ${theme})`,
  ].join(" and ");
}
