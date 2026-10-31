import type { ReactNode } from "react";

// A progress ring: the share (0 to 100) of a circle in the accent, the figure or
// word the caller passes at its centre. Announces `aria-label` once.
export function Ring({
  value,
  size = 84,
  color = "var(--violet-9)",
  children,
  "aria-label": ariaLabel,
}: {
  value: number;
  size?: number;
  color?: string;
  children?: ReactNode;
  "aria-label": string;
}) {
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const share = Math.min(100, Math.max(0, value));

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      style={{ position: "relative", width: size, height: size, flexShrink: 0 }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--gray-a4)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(share / 100) * circumference} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          placeItems: "center",
        }}
      >
        {children}
      </div>
    </div>
  );
}
