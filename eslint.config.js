// Flat config. Scope is deliberately narrow: this repo runs TypeScript through
// Node's type stripping with no build step, and `tsc --noEmit` already gates
// types in CI. What eslint adds here is the class tsc cannot see — unused
// bindings, unreachable code, promises dropped on the floor — so the rule set
// is the recommended baseline rather than a style opinion, and formatting is
// left alone entirely.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "models/**",
      "data/**",
      "docs/**",
      ".vigil/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly" },
    },
    rules: {
      // The codebase leans on `any` in a few SQLite row casts that are checked
      // by hand at the call site; tsc governs those. Keep it visible, not fatal.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
