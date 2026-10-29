"use client";

import { useEffect } from "react";

import { answerPending } from "@/lib/log/answer-pending";

/** Renders nothing. Answers the rows waiting for the network (RL-76) on mount and on each `online`. */
export function AnswerPending() {
  useEffect(() => {
    const run = () => void answerPending({ online: navigator.onLine, now: Date.now() });
    run();
    window.addEventListener("online", run);
    return () => window.removeEventListener("online", run);
  }, []);

  return null;
}
