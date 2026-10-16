// RL-26: a headword's answer can be heard. Nothing is fetched and nothing is
// recorded — the browser's own `speechSynthesis` carries the voice, so a
// headword with no IPA is spoken exactly like one that has it.

// Asked fresh every time, never cached and never inferred from the browser's
// name or version: the caller renders no control at all when this is false,
// rather than a button that does nothing when pressed.
export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

// Cancels whatever utterance is already in flight before starting the next
// one, so a second press restarts the word instead of queueing behind it.
export function speak(headword: string): void {
  if (!speechSupported()) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(headword);
  // The headword is English; the Spanish translation under it is not what
  // gets spoken.
  utterance.lang = "en-US";
  window.speechSynthesis.speak(utterance);
}
