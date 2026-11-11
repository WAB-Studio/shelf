"use client";

import { useFigureText } from "@/lib/use-privacy";

/**
 * A sentence a Server Component wrote with its figures tagged (`tagFigure`): the
 * tags come off, and each figure reads as a mask while amounts are hidden (RF-174).
 */
export function Figures({ children }: { children: string }) {
  const reveal = useFigureText();
  return <>{reveal(children)}</>;
}
