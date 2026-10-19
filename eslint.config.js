import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/", "**/build-test/", "site/public/", "site/resources/", "site/themes/"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Responses from Apple's servers are parsed as untyped JSON on purpose.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // node:test's describe() and it() return promises that are meant to be left unawaited.
    files: ["packages/aea/test/**"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  },
  {
    // Not part of any tsconfig, so no type information.
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["site/assets/js/**"],
    languageOptions: { globals: globals.browser },
  },
);
