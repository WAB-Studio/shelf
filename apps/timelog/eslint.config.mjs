import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const screenSyntax = [
  {
    selector: "JSXAttribute[name.name='className']",
    message: "Compose from `components/ui` and its props; no utility class outside it.",
  },
  {
    selector: "JSXAttribute[name.name='style']",
    message: "Compose from `components/ui` and its props; no inline style outside it.",
  },
  {
    selector: "ImportDeclaration[source.value=/\\.module\\.css$/]",
    message: "A CSS module belongs to `components/ui`; add a prop to the primitive instead.",
  },
  {
    selector: "JSXText[value=/\\p{L}/u]",
    message: "Move interface text into next-intl.",
  },
];

const dbDoor = "The only door to this app's tables is `withTimeDb`, from `@/lib/session`.";

const importSyntax = {
  selector: "ImportExpression[source.value=/(^|\\/)db\\/client(\\.[cm]?[jt]sx?)?$/]",
  message: dbDoor,
};

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "private/**"]),
  {
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "Reach a store from `lib/` only." },
        { name: "sessionStorage", message: "Reach a store from `lib/` only." },
        { name: "indexedDB", message: "Reach a store from `lib/` only." },
      ],
      "no-restricted-imports": [
        "error",
        { patterns: [{ regex: "(^|/)db/client(\\.[cm]?[jt]sx?)?$", message: dbDoor }] },
      ],
      "no-restricted-syntax": ["error", importSyntax],
    },
  },
  { files: ["lib/**"], rules: { "no-restricted-globals": "off" } },
  {
    files: ["app/**", "components/**"],
    ignores: ["components/ui/**"],
    rules: { "no-restricted-syntax": ["error", importSyntax, ...screenSyntax] },
  },
  { files: ["app/layout.tsx"], rules: { "no-restricted-syntax": ["error", importSyntax] } },
  // `session.ts` settles every connection; `keys.ts` resolves a key before any person exists,
  // through one definer function; `ingest.ts` writes as the person that key resolved.
  {
    files: ["lib/session.ts", "lib/keys.ts", "lib/ingest.ts"],
    rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" },
  },
  { files: ["scripts/**"], rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" } },
]);
