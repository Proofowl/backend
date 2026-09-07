// Flat config, mirroring sdk/typescript/eslint.config.js in
// proofowl-contracts: @eslint/js recommended + typescript-eslint
// recommended, unused-vars with a `^_` ignore, generated code excluded
// from linting (it is verbatim codegen — Prisma client here, Stellar
// bindings there).

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "test-build/**",
      "node_modules/**",
      "src/generated/**",
      "prisma/migrations/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        URL: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        AbortController: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/explicit-function-return-type": "off",
      "no-console": "off",
    },
  },
);
