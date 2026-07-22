import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

const strictTypeChecked = tseslint.configs.strictTypeChecked.map((config) => ({
  ...config,
  files: ["**/*.ts"],
}));

export default tseslint.config(
  { ignores: ["dist/**", "drizzle/**", "node_modules/**"] },
  eslint.configs.recommended,
  ...strictTypeChecked,
  prettier,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
    rules: {
      "max-lines": [
        "error",
        { max: 500, skipBlankLines: false, skipComments: false },
      ],
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "max-lines": [
        "error",
        { max: 500, skipBlankLines: false, skipComments: false },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
    },
  },
  {
    files: ["**/*.module.ts"],
    rules: {
      "@typescript-eslint/no-extraneous-class": "off",
    },
  },
  {
    files: [
      "src/common/db/schema.ts",
      "src/common/db/artifact-schema.ts",
      "src/common/db/studio-schema.ts",
    ],
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
);
