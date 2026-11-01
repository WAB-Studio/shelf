import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanProviderText } from "./clean";

test("a numeric newline entity becomes nothing at the end of the sentence", () => {
  assert.equal(cleanProviderText("Es que ya no tengo tiempo.&#10;"), "Es que ya no tengo tiempo.");
});

test("named, decimal and hexadecimal entities decode to their characters", () => {
  assert.equal(cleanProviderText("Tom &amp; Jerry &quot;juegan&quot; &#39;ya&#39; &#x27;hoy&#x27;"), `Tom & Jerry "juegan" 'ya' 'hoy'`);
});

test("line breaks and runs of spaces fold into one space", () => {
  assert.equal(cleanProviderText("uno\r\n dos\t\ttres\n"), "uno dos tres");
  assert.equal(cleanProviderText("uno&#10;dos"), "uno dos");
});

test("an unknown entity is left as written and a double-encoded one decodes once", () => {
  assert.equal(cleanProviderText("a &nosuch; b"), "a &nosuch; b");
  assert.equal(cleanProviderText("&amp;#10;"), "&#10;");
});
