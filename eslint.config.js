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
    // Issue #246: CopilotClient.createSession/resumeSession must only be
    // called from the hardened wrapper (src/copilotSdk/hardenedSession.ts),
    // which binds and re-derives a session's tool policy on every
    // create/resume. Calling either method anywhere else can silently drop
    // `availableTools`/`onPermissionRequest`/`autoApproveAll` (the exact
    // regressions issue #246 was opened over). boundary.ts is exempt because
    // it *is* the SDK boundary -- its `super.createSession`/`super.resumeSession`
    // calls are the base-class delegation the override wraps, not a bypass.
    // Test files are exempt where they intentionally exercise the raw SDK
    // client itself (e.g. proxy/integration tests), not the hardened wrapper.
    files: ["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts"],
    ignores: [
      "src/copilotSdk/boundary.ts",
      "src/copilotSdk/hardenedSession.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    rules: {
      "no-restricted-syntax": ["error", {
        "selector": "CallExpression[callee.property.name='createSession']",
        "message": "❌ Do not call CopilotClient.createSession directly. Use createHardenedSession() from src/copilotSdk/hardenedSession.ts so the session's tool policy is bound and enforced (issue #246). If this call site predates the wrapper and hasn't been migrated yet (issue #246 item 7), add a documented eslint-disable-next-line referencing the issue rather than removing this rule."
      }, {
        "selector": "CallExpression[callee.property.name='resumeSession']",
        "message": "❌ Do not call CopilotClient.resumeSession directly. Use resumeHardenedSession() from src/copilotSdk/hardenedSession.ts so the full tool policy (availableTools/onPermissionRequest/autoApproveAll) is re-derived on resume instead of risking a partial config (issue #246). If this call site predates the wrapper and hasn't been migrated yet (issue #246 item 7), add a documented eslint-disable-next-line referencing the issue rather than removing this rule."
      }]
    }
  },
  {
    // Issue #320: `*.pure.ts` files hold decision logic split out from an
    // impure caller (config/args in, value out) so it can be tested and
    // reasoned about without any I/O. Mechanically enforced here rather
    // than left as a naming convention, because an unenforced convention
    // drifts silently -- see the issue for `buildAuditorSessionSettings`
    // failing this exact rule despite looking pure at a glance (it closed
    // over `getExecCommand()` via a handler closure).
    //
    // Banned: Node's I/O-bearing builtins, the workspace module (or
    // anything that transitively reaches getExecCommand()/getGitSandbox()),
    // and SDK client modules. This only catches *direct* imports in the
    // `*.pure.ts` file itself -- it does not (and can't, without a
    // transitive-import analyzer) catch a pure file importing a helper
    // that itself imports fs two hops away. Keep imports in `*.pure.ts`
    // files to other `*.pure.ts` files or plain type/config modules to
    // stay meaningfully pure in practice, not just by this rule's letter.
    files: ["**/*.pure.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        "paths": [
          { "name": "fs", "message": "❌ *.pure.ts files must not perform I/O. See issue #320." },
          { "name": "node:fs", "message": "❌ *.pure.ts files must not perform I/O. See issue #320." },
          { "name": "fs/promises", "message": "❌ *.pure.ts files must not perform I/O. See issue #320." },
          { "name": "node:fs/promises", "message": "❌ *.pure.ts files must not perform I/O. See issue #320." },
          { "name": "child_process", "message": "❌ *.pure.ts files must not shell out. See issue #320." },
          { "name": "node:child_process", "message": "❌ *.pure.ts files must not shell out. See issue #320." },
          { "name": "net", "message": "❌ *.pure.ts files must not perform network I/O. See issue #320." },
          { "name": "node:net", "message": "❌ *.pure.ts files must not perform network I/O. See issue #320." },
          { "name": "http", "message": "❌ *.pure.ts files must not perform network I/O. See issue #320." },
          { "name": "node:http", "message": "❌ *.pure.ts files must not perform network I/O. See issue #320." },
          { "name": "https", "message": "❌ *.pure.ts files must not perform network I/O. See issue #320." },
          { "name": "node:https", "message": "❌ *.pure.ts files must not perform network I/O. See issue #320." },
          { "name": "@github/copilot-sdk", "message": "❌ *.pure.ts files must not import SDK client modules. See issue #320." }
        ],
        "patterns": [
          {
            "group": ["**/workspace", "**/workspace/*", "**/workspace/index", "*/workspace", "*/workspace/*"],
            "message": "❌ *.pure.ts files must not import the workspace module (reaches getExecCommand()/getGitSandbox()). See issue #320."
          },
          {
            "group": ["**/copilotSdk/*", "**/copilotSdk/**"],
            "message": "❌ *.pure.ts files must not import SDK client modules. See issue #320."
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
      // Native ESLint is set to error for explicit ratcheting.
      // The check-explicit-any script runs as a secondary layer to ensure no eslint-disable escape hatches are used.
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": "error"
    }
  }
];
