import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "out/**", "node_modules/**"],
    rules: { "@typescript-eslint/consistent-type-imports": "error" },
  },
];
