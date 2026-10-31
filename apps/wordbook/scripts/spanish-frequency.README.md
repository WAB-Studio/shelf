# spanish-frequency.txt

- Source: hermitdave/FrequencyWords, OpenSubtitles 2018 Spanish, `content/2018/es/es_50k.txt`
  (https://github.com/hermitdave/FrequencyWords).
- Author: Hermit Dave, from the OpenSubtitles corpus.
- Licence: CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Using it to order the shipped dictionary makes that
  asset a derived work under the same licence; the credit is shown at `/cuenta` (`components/account/account-info.tsx`).
- Downloaded: 2026-10-30. Counts dropped; the 20,000 commonest words (letters only, no repeats), one per line, commonest first.
  Only a word's presence matters: `translation-order.ts` demotes a translation the list lacks.
- Build input only: nothing in the app imports it, so the device never receives it.
