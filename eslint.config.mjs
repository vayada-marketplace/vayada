import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Scope all Next.js rules to product apps only. Lints from repo root
// (lint-staged, npm run lint) and from any app directory both resolve
// this config; the files glob keeps Docusaurus, infra scripts, and
// packages/ out of Next-specific rule scope.
const APP_GLOBS = ["apps/**/*.{js,jsx,ts,tsx,mjs,cjs}"];

const eslintConfig = defineConfig([
  {
    files: APP_GLOBS,
    extends: [...nextVitals, ...nextTs],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-empty-object-type": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      "@next/next/no-html-link-for-pages": "warn",
      "prefer-const": "warn",
      "react/no-children-prop": "warn",
      "react/no-unescaped-entities": "warn",
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  globalIgnores([
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/next-env.d.ts",
    "**/node_modules/**",
  ]),
]);

export default eslintConfig;
