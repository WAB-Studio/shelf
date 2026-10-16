// Pairs that RL-58 must resolve. One rule of `inflect.ts` at least, usually
// the irregular table, exercises every line here.
export const INFLECTION_FIXTURE: readonly { surface: string; lemma: string }[] = [
  // Named by the assignment.
  { surface: "left", lemma: "leave" },
  { surface: "went", lemma: "go" },
  { surface: "children", lemma: "child" },
  { surface: "better", lemma: "good" },
  { surface: "ran", lemma: "run" },
  { surface: "mice", lemma: "mouse" },
  { surface: "swum", lemma: "swim" },
  { surface: "bought", lemma: "buy" },
  { surface: "studies", lemma: "study" },
  { surface: "stopped", lemma: "stop" },
  { surface: "carrying", lemma: "carry" },
  { surface: "knives", lemma: "knife" },
  { surface: "chosen", lemma: "choose" },
  { surface: "worst", lemma: "bad" },
  { surface: "quickly", lemma: "quick" },
  // Identity: nothing to strip.
  { surface: "dog", lemma: "dog" },
  { surface: "cat", lemma: "cat" },
  // Regular plurals.
  { surface: "cats", lemma: "cat" },
  { surface: "boxes", lemma: "box" },
  { surface: "buses", lemma: "bus" },
  // Regular past tense, including the consonant-doubled and dropped-e forms.
  { surface: "walked", lemma: "walk" },
  { surface: "played", lemma: "play" },
  { surface: "planned", lemma: "plan" },
  { surface: "carried", lemma: "carry" },
  // Regular gerunds, including the dropped-e and doubled-consonant forms.
  { surface: "walking", lemma: "walk" },
  { surface: "loving", lemma: "love" },
  { surface: "running", lemma: "run" },
  // Comparatives and superlatives, plain and dropped-e.
  { surface: "faster", lemma: "fast" },
  { surface: "nicer", lemma: "nice" },
  { surface: "fastest", lemma: "fast" },
  { surface: "nicest", lemma: "nice" },
  // An adverb whose adjective ends in "-y".
  { surface: "happily", lemma: "happy" },
  // A possessive.
  { surface: "dog's", lemma: "dog" },
  // More irregular verbs, at both the past and the participle.
  { surface: "gone", lemma: "go" },
  { surface: "taken", lemma: "take" },
  { surface: "written", lemma: "write" },
  { surface: "eaten", lemma: "eat" },
  { surface: "flown", lemma: "fly" },
  { surface: "driven", lemma: "drive" },
  { surface: "spoken", lemma: "speak" },
  { surface: "brought", lemma: "bring" },
  { surface: "thought", lemma: "think" },
  { surface: "sought", lemma: "seek" },
  // More irregular plurals, English and Latin/Greek.
  { surface: "wolves", lemma: "wolf" },
  { surface: "leaves", lemma: "leaf" },
  { surface: "teeth", lemma: "tooth" },
  { surface: "men", lemma: "man" },
  { surface: "women", lemma: "woman" },
  { surface: "people", lemma: "person" },
  { surface: "criteria", lemma: "criterion" },
  { surface: "data", lemma: "datum" },
  { surface: "cacti", lemma: "cactus" },
  { surface: "indices", lemma: "index" },
];
