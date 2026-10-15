// RL-64: sexual and obscene terms, Spanish and English, that MyMemory's public
// memory must not draw to a reader. Matched whole-word on the folded text.
const TERMS = [
  // Spanish
  "follar", "folla", "follo", "follamos", "follan", "follen", "follando", "polla", "pollas", "verga", "vergas",
  "coño", "coños", "chupar", "chupes", "chupa", "chupo", "chupame", "mamada", "mamadas", "pajas",
  "puta", "putas", "puto", "putos", "putear", "pene", "penes", "vagina", "vaginas", "clitoris", "teta", "tetas",
  "pezon", "pezones", "culo", "culos", "semen",
  "esperma", "erecto", "erección", "ereccion", "orgasmo", "orgasmos", "masturbar", "masturbarse", "masturbacion",
  "cojones", "cojon", "joder", "jodido", "jodida", "pija", "pijas", "coger",
  "pendejo", "pendeja", "mierda", "cabron", "cabrona", "gilipollas", "capullo", "zorra",
  "zorras", "pornografia", "porno", "desnuda", "desnudo", "desnudas", "desnudos", "sexo", "sexual", "sexuales",
  "sexy", "violar", "violacion", "prostituta", "prostitutas", "ramera", "tetona", "pornografico",
  // English
  "fuck", "fucks", "fucked", "fucking", "fucker", "motherfucker", "shit", "bullshit", "cunt", "cunts", "dick",
  "dicks", "cock", "cocks", "pussy", "pussies", "tits", "boobs", "asshole", "assholes", "blowjob", "blowjobs",
  "handjob", "cum", "cums", "cumming", "cumshot", "orgasm", "orgasms", "masturbate", "masturbating", "porn",
  "porno", "pornography", "slut", "sluts", "whore", "whores", "bitch", "bitches", "bastard", "naked", "nude",
  "nudes", "erection", "penis", "penises", "vagina", "anal", "rape", "raped", "rapist", "horny", "sex", "sexual",
  "sexy", "suck", "sucking", "dildo", "boner", "wank", "wanker", 
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
