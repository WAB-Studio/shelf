"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const EVERY = 60_000;

// Today keeps moving: re-read it every minute while the tab is in front, and as soon as it comes back to the front.
export function AutoRefresh() {
  const router = useRouter();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(refresh, EVERY);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);
  return null;
}
