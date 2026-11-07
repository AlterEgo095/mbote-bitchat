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
// ── Garde « composant client » (DEV-SETUP §6 — 2026-11-06, clarification É9+C1) ──
// 3 occurrences de la classe « Buffer/import node dans 'use client' » attrapées
// par les preuves navigateur et JAMAIS par le harnais bun (Buffer y existe).
// La 4ᵉ est désormais impossible : le lint échoue dès qu'un fichier commençant
// par 'use client' importe/requiert un module node ou référence Buffer/process
// (process.env.* excepté — remplacé inline par Next).
const mboteClientGuard = {
  rules: {
    "no-node-in-client": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Zéro import node (Buffer, process, fs, path, node:crypto, require) dans un fichier 'use client' — DEV-SETUP §6. Utiliser exclusivement les helpers de src/lib/mbote/.",
        },
        schema: [],
        messages: {
          forbidden:
            "Interdit dans un fichier 'use client' : {{what}} (DEV-SETUP §6 — helpers src/lib/mbote/ uniquement)",
        },
      },
      create(context) {
        const head = (context.sourceCode?.text ?? "").slice(0, 200).trimStart();
        if (!head.startsWith("'use client'") && !head.startsWith('"use client"')) return {};
        const nodeModules =
          /^(node:)?(buffer|fs|path|crypto|os|child_process|util|stream|http|https|url)$/;
        const report = (node, what) =>
          context.report({ node, messageId: "forbidden", data: { what } });
        const isDeclarationOrKey = (node, parent) =>
          parent.type === "VariableDeclarator" ||
          parent.type === "FunctionDeclaration" ||
          parent.type === "ClassDeclaration" ||
          parent.type === "ImportSpecifier" ||
          parent.type === "ImportDefaultSpecifier" ||
          parent.type === "ImportNamespaceSpecifier" ||
          parent.type === "ExportSpecifier" ||
          ((parent.type === "MemberExpression" || parent.type === "Property" ||
            parent.type === "MethodDefinition") && parent.key === node && !parent.computed);
        return {
          ImportDeclaration(node) {
            const name = String(node.source?.value ?? "");
            if (nodeModules.test(name)) report(node, `import "${name}"`);
          },
          CallExpression(node) {
            const callee = node.callee;
            if (callee?.type === "Identifier" && callee.name === "require") {
              const arg = node.arguments?.[0]?.value;
              if (typeof arg === "string" && nodeModules.test(arg)) {
                report(node, `require("${arg}")`);
              }
            }
          },
          Identifier(node) {
            const parent = node.parent;
            if (!parent) return;
            if (node.name === "Buffer" && !isDeclarationOrKey(node, parent)) {
              report(node, "Buffer (global node — absent du navigateur)");
            }
            if (node.name === "process") {
              // process.env.* est remplacé inline par Next (NODE_ENV, NEXT_PUBLIC_*)
              const envAccess =
                parent.type === "MemberExpression" && parent.object === node &&
                parent.property?.name === "env";
              const isDeclaration = isDeclarationOrKey(node, parent);
              if (!envAccess && !isDeclaration) {
                report(node, "process (global node — absent du navigateur, sauf process.env.*)");
              }
            }
          },
        };
      },
    },
  },
};

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  plugins: { "mbote-client-guard": mboteClientGuard },
  rules: {
    "mbote-client-guard/no-node-in-client": "error",
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
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills", "mobile/**", "admin/**"]
}, {
  // Outils (scripts, tests, mini-services) : les console.log sont des sorties légitimes
  // (la garde no-node-in-client reste active — scripts/tests ne sont jamais 'use client')
  files: ["scripts/**", "tests/**", "mini-services/**"],
  rules: {
    "no-console": "off",
  },
}];

export default eslintConfig;
