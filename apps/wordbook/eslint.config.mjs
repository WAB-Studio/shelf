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

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "private/**",
    // The service worker is a browser script with its own globals, not app code.
    "public/sw.js",
  ]),
  {
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "localStorage",
          message:
            "Reach a store from `lib/` only. The payload lives in IndexedDB, whole or not at all, and the device holds exactly one copy of it (SPEC §2).",
        },
        { name: "indexedDB", message: "Reach a store from `lib/` only." },
        {
          name: "sessionStorage",
          message:
            "Reach a store from `lib/` only. The payload lives in IndexedDB, whole or not at all, and the device holds exactly one copy of it (SPEC §2).",
        },
      ],
    },
  },
  // `lib/` is where the stores live, so it is the one place allowed to name them.
  {
    files: ["lib/**"],
    rules: { "no-restricted-globals": "off" },
  },
  // Screens compose `components/ui`; styling lives there and copy in next-intl.
  {
    files: ["app/**", "components/**"],
    ignores: ["components/ui/**"],
    rules: { "no-restricted-syntax": ["error", ...screenSyntax] },
  },
  // The root layout puts the font variables on <html>; no primitive owns that tag.
  {
    files: ["app/layout.tsx", "app/global-error.tsx"],
    rules: { "no-restricted-syntax": "off" },
  },
  // A spec asserts what the device really holds, so it reads the store the
  // browser exposes rather than the one the app imports.
  {
    files: ["e2e/**"],
    rules: { "no-restricted-globals": "off" },
  },
]);

export default eslintConfig;
