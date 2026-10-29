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

const importSyntax = {
  selector:
    "ImportExpression[source.value=/(^|\\/)db\\/client(\\.[cm]?[jt]sx?)?$/]",
  message:
    "The only doors to this app's tables are `withGoalsDb` and `withReadingDb`, from `@/lib/session`.",
};

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
  ]),
  {
    rules: {
      "no-restricted-globals": [
        "error",
        {
          name: "localStorage",
          message: "Reach a store from `lib/` only.",
        },
        {
          name: "sessionStorage",
          message: "Reach a store from `lib/` only.",
        },
        { name: "indexedDB", message: "Reach a store from `lib/` only." },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // `group`'s gitignore-style matching takes the source string
              // literally: a `.js` (or `.jsx`) suffix — legal ESM, and the
              // one TS resolves without a `TS5097`/`TS2307` — slips past
              // `**/db/client`. `regex` matches the module path underneath
              // whatever extension, real or not, the import spells out.
              regex: "(^|/)db/client(\\.[cm]?[jt]sx?)?$",
              message:
                "The only doors to this app's tables are `withGoalsDb` and `withReadingDb`, from `@/lib/session`.",
            },
          ],
        },
      ],
      // `no-restricted-imports` does not see `import()`: it inspects
      // `ImportDeclaration` and `Export...Declaration`, never `ImportExpression`.
      "no-restricted-syntax": ["error", importSyntax],
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
    rules: {
      "no-restricted-syntax": ["error", importSyntax, ...screenSyntax],
    },
  },
  // The root layout puts the font variables on <html>; no primitive owns that tag.
  {
    files: ["app/layout.tsx", "app/global-error.tsx"],
    rules: { "no-restricted-syntax": ["error", importSyntax] },
  },
  // `session.ts` settles the connection before every query it runs — the one
  // file allowed to hold the raw pool the rules above forbid everywhere else.
  {
    files: ["lib/session.ts"],
    rules: { "no-restricted-imports": "off", "no-restricted-syntax": "off" },
  },
  // `resolveBearer` runs before any person exists, so it has no settle to
  // offer: it calls one `SECURITY DEFINER` function and reads nothing else.
  // The call counter has no person either: it claims through one such function.
  // `allowlist.ts` reads the invitation list before a person exists (RP-131).
  // `spend.ts` counts the whole app's day (RP-126), rows its person's role cannot see.
  {
    files: ["lib/mcp/tokens.ts", "lib/oauth/grants.ts", "lib/oauth/throttle.ts", "lib/import/spend.ts", "lib/auth/allowlist.ts", "lib/auth/sign-in-budget.ts"],
    rules: { "no-restricted-imports": "off" },
  },
  // A spec asserts what the device really holds, so it reads the store the
  // browser exposes rather than the one the app imports.
  {
    files: ["e2e/**"],
    rules: { "no-restricted-globals": "off" },
  },
]);

export default eslintConfig;
