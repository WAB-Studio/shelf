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

const insertSyntax = {
  selector:
    "CallExpression[callee.type='MemberExpression'][callee.property.name='insert']",
  message:
    "Insert through `insertRow` (db/insert-row.ts). Drizzle's insert builder names every column of the table and the per-column INSERT grants refuse it.",
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
      "no-restricted-syntax": ["error", insertSyntax],
      "no-restricted-globals": [
        "error",
        { name: "localStorage", message: "Reach a store from `lib/` only." },
        { name: "sessionStorage", message: "Reach a store from `lib/` only." },
        { name: "indexedDB", message: "Reach a store from `lib/` only." },
      ],
    },
  },
  // `lib/` is where the stores live, so it is the one place allowed to name them.
  {
    files: ["lib/**", "e2e/**"],
    rules: { "no-restricted-globals": "off" },
  },
  // Screens compose `components/ui`; styling lives there and copy in next-intl.
  {
    files: ["app/**", "components/**"],
    ignores: ["components/ui/**"],
    rules: {
      "no-restricted-syntax": ["error", insertSyntax, ...screenSyntax],
    },
  },
  // Debt: these files predate the rule above. Shrink the list, never grow it.
  {
    files: [
      "app/[[]locale]/(app)/page.tsx",
      "app/[[]locale]/layout.tsx",
      "components/onboarding/onboarding-invite-step.tsx",
      "components/reports/dashboard-summary.tsx",
      "components/reports/reports-screen.tsx",
      "components/transactions/movement-detail.tsx",
    ],
    rules: { "no-restricted-syntax": ["error", insertSyntax] },
  },
  // The RLS harness calls the builder on purpose, as the negative control that
  // shows the grants refusing it.
  {
    files: ["scripts/check-rls.ts"],
    rules: { "no-restricted-syntax": "off" },
  },
]);

export default eslintConfig;
