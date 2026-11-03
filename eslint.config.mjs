import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// F-21 : portes qualité réactivées. Seules dérogations assumées :
// - react/prop-types : redondant avec la validation statique TypeScript ;
// - no-console limité à warn/error (logs serveur légitimes dans les routes API) ;
// - no-empty tolère les catch vides (pattern `.catch(() => ({}))` assumé).
const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TypeScript
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-non-null-assertion": "error",
    "@typescript-eslint/ban-ts-comment": "error",
    "@typescript-eslint/prefer-as-const": "error",

    // React
    "react-hooks/exhaustive-deps": "error",
    "react-hooks/purity": "error",
    "react/no-unescaped-entities": "error",
    "react/display-name": "error",
    "react/prop-types": "off", // redondant avec TypeScript

    // Next.js
    "@next/next/no-img-element": "error",
    "@next/next/no-html-link-for-pages": "error",

    // JavaScript général
    "prefer-const": "error",
    "no-unused-vars": "off", // couvert par @typescript-eslint/no-unused-vars
    "no-console": ["error", { allow: ["warn", "error"] }],
    "no-debugger": "error",
    "no-empty": ["error", { allowEmptyCatch: true }],
    "no-irregular-whitespace": "error",
    "no-case-declarations": "error",
    "no-fallthrough": "error",
    "no-mixed-spaces-and-tabs": "error",
    "no-redeclare": "error",
    "no-undef": "off", // couvert par TypeScript (no-dupe-keys etc.) en scope TS
    "no-unreachable": "error",
    "no-useless-escape": "error",
  },
}, {
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills", "mobile/**"]
}, {
  // Outils (scripts, tests, mini-services) : les console.log sont des sorties légitimes
  files: ["scripts/**", "tests/**", "mini-services/**"],
  rules: {
    "no-console": "off",
  },
}];

export default eslintConfig;
