import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
    },
    rules: {
      "no-restricted-imports": ["error", {
        "patterns": [
          {
            "group": ["src/workspace/**/*"],
            "message": "❌ Avoid importing internal workspace modules directly. Import from 'src/workspace/index.ts' (the public API barrel) instead.",
            "importNames": ["*"]
          }
        ]
      }]
    }
  },
  {
    files: [
      "src/orchestrator/**/*.ts",
      "src/orchestrator/**/*.tsx",
      "src/copilotSdk/boundary.ts"
    ],
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "warn"
    }
  }
];
