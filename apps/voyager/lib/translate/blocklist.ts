// RL-64: explicit and obscene terms (never a neutral or clinical word), Spanish and English, that MyMemory's public
// memory must not draw to a reader. Matched whole-word on the folded text.
const TERMS = [
  // Spanish
  "follar", "folla", "follo", "follamos", "follan", "follen", "follando", "polla", "pollas", "verga", "vergas",
  "coño", "coños", "chupar", "chupes", "chupa", "chupo", "chupame", "mamada", "mamadas", "pajas",
  "puta", "putas", "puto", "putos", "putear", "culo", "culos", "cojones", "cojon", "joder", "jodido", "jodida", "pija", "pijas", "coger",
  "pendejo", "pendeja", "mierda", "cabron", "cabrona", "gilipollas", "capullo", "zorra",
  "zorras", "ramera", "tetona", // English
  "fuck", "fucks", "fucked", "fucking", "fucker", "motherfucker", "shit", "bullshit", "cunt", "cunts", "dick",
  "dicks", "cock", "cocks", "pussy", "pussies", "asshole", "assholes", "blowjob", "blowjobs",
  "handjob", "cum", "cums", "cumming", "cumshot", "slut", "sluts", "whore", "whores", "bitch", "bitches", "bastard", "horny", "suck", "sucking", "dildo", "boner", "wank", "wanker", 
];

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

// Folded the same way as the text, so «coño» and «COÑO» and «cono» all land
// on one entry. Letters only on either side of a term count as part of a word.
const PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${[...new Set(TERMS.map(fold))].map((t) => t).join("|")})(?![\\p{L}\\p{N}])`,
  "u",
);

export function containsBlockedTerm(text: string): boolean {
  return PATTERN.test(fold(text));
}
