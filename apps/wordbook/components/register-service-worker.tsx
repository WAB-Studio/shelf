"use client";

import { useEffect } from "react";

// Renders nothing. A refused registration is swallowed: the shell opens either
// way and nothing here waits on it.
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The browser refused it. The app works without one.
    });
  }, []);

  return null;
}
