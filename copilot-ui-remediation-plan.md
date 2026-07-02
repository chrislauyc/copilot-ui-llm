# copilot-ui Remediation Plan

Status of each item: **confirmed** (traced/verified), **suspected** (static trace only,
needs a repro), or **structural** (no bug, just a seam to add).

---

## Phase 0 — Resolve open hypotheses (before any refactor)

Two items are suspected bugs. Verify them first; the Phase 2 work differs depending on
the outcome.

### 0-A — Gate `cwd` resolution in Docker mode (suspected)

**What to check:**
`serverRuntime.ts` line ~87 sets:
```ts
const DEFAULT_WORKSPACE_DIR = getWorkspaceHostLocation(); // e.g. "./workspace"
```
`AgentWorkspace.tsx` never passes an explicit `cwd` to `runWithGates`, so
`handleGateLoop` falls back to `DEFAULT_WORKSPACE_DIR` as `runCwd`.
`runGate(gateName, runCwd)` in `gates/index.ts` passes that value straight to
`runTests(cwd)` / `runLint(cwd)` (lines ~22 and ~55), whose default is `process.cwd()`.
In Docker mode `getWorkspaceHostLocation()` returns the *host* path
(`process.env.WORKSPACE_HOST_LOCATION || "./workspace"`), not the container path
(`/app`). The gate shell command therefore runs `cd ./workspace && npm test` inside the
container, which resolves to a path that probably does not exist.

**Verification step:** Run one gate-loop turn in Docker mode with an injected log
immediately before `runGate` that prints the resolved `runCwd`. Compare it against
`/app`. If they differ, the bug is confirmed.

**Outcome determines:** Whether Phase 2-A is a code fix or an AGENTS.md note.

---

### 0-B — Orphan process on abort/panic (suspected)

**What to check:**
`dockerRunner.ts:runDockerProcess` and `nativeRunner.ts:runNativeProcess` kill only the
`docker exec` / `bash` *spawned process* (`child.kill("SIGKILL")`). If the agent turn
backgrounded a long-running child inside the container, that inner process is not a
direct child of Node and will not be killed by `child.kill`.

**Verification step:** Have an agent turn run a background process
(e.g. `sleep 300 &`), trigger an abort, then list container processes
(`docker exec <container> ps aux`). If `sleep` is still running, the bug is confirmed.

**Outcome determines:** Whether Phase 2-B is a code fix or an AGENTS.md note.

---

## Phase 1 — Structural seams (do as one combined pass)

Extract the orchestrator AND create the SDK boundary in the same branch. Both touch the
same call-sites in `serverRuntime.ts`; splitting them doubles the merge work.

### 1-A — Create `src/copilotSdk/boundary.ts`

**Goal:** Every `@github/copilot-sdk` import in the app goes through one file.

**Files that currently import `@github/copilot-sdk` directly (must all be updated):**
- `src/serverRuntime.ts` — line 5: `CopilotClient`, `PermissionRequestResult`,
  `SessionConfig`, `ProviderConfig as SdkProviderConfig`, `Tool`
- `src/utils/auditorHelper.ts` — line 1: `CopilotClient`
- `src/mockEvents.ts` — line 1: `SessionEvent`, `ToolExecutionCompleteContent`
- `src/types/events.ts` — check for `SessionEvent` and related type imports
- `src/parser.test.ts` — line 5: `SessionEvent`
- any other test files that import from `@github/copilot-sdk` directly

**Steps:**
1. Create `src/copilotSdk/boundary.ts`. Re-export every type and the `CopilotClient`
   class that the rest of the app uses:
   ```ts
   export { CopilotClient } from '@github/copilot-sdk';
   export type {
     SessionEvent,
     ToolExecutionCompleteContent,
     PermissionRequestResult,
     SessionConfig,
     Tool,
   } from '@github/copilot-sdk';
   // Re-export as alias used by serverRuntime.ts
   export type { ProviderConfig as SdkProviderConfig } from '@github/copilot-sdk';
   ```
2. In each file listed above, replace the `@github/copilot-sdk` import path with
   `'../copilotSdk/boundary'` (adjust relative depth as needed). Do not change any
   other code in those files.
3. Run `npm run lint` and `npm test` — no functional change should occur.

---

### 1-B — Create `src/orchestrator/gateLoop.ts`

**Goal:** Move `handleGateLoop` (currently
`serverRuntime.ts` lines 1468–2833, roughly 1365 lines) into its own module.
Route handlers become thin: parse request → call orchestrator → stream response.

**Steps:**
1. Create `src/orchestrator/gateLoop.ts`.
2. Move the `handleGateLoop` async function body into it. The function signature
   accepted by Express is:
   ```ts
   export async function handleGateLoop(
     req: express.Request,
     res: express.Response,
   ): Promise<void>
   ```
3. Move any file-scoped helpers that are *only* used by `handleGateLoop` into the same
   file or a sibling module (e.g. `src/orchestrator/sessionLifecycle.ts` for
   `getOrCreateSession`).
4. Update imports: `serverRuntime.ts` should import `handleGateLoop` from
   `'./orchestrator/gateLoop'` and register the routes exactly as before:
   ```ts
   app.post('/api/copilot/gate-run', handleGateLoop);
   app.post('/api/copilot/gate-resume', handleGateLoop);
   ```
5. Symbols that stay in `serverRuntime.ts` (still used by other routes): `activeSessions`,
   `sseResToSessionId`, `sessionWritePromises`, `activeLocks`, `getGlobalClient`,
   `resetSessionForNewRun`, `updateStateSnapshot`, `writeLog`, `DEFAULT_WORKSPACE_DIR`.
6. Run `npm run lint` and `npm test` — no functional change should occur.

**Note on `getGlobalClient`:** It is currently defined in `serverRuntime.ts` and called
inside `handleGateLoop`. After extraction, import it from `serverRuntime.ts` (or from
`src/copilotSdk/boundary.ts` once Phase 1-A is complete and you choose to move it
there). Moving it to the boundary is the cleaner final state but is not required in the
same commit — do it only if the diff stays focused.

---

## Phase 2 — Correctness fixes (contingent on Phase 0)

Do these *after* Phase 1. Phase 1 localises both changes to a single small file each.

### 2-A — Gate `cwd` fix (only if Phase 0-A confirms the bug)

**File:** `src/serverRuntime.ts` (or `src/orchestrator/gateLoop.ts` after Phase 1)

**Current code (line ~87):**
```ts
const DEFAULT_WORKSPACE_DIR = getWorkspaceHostLocation();
```

**Fix:**
```ts
// DEFAULT_WORKSPACE_DIR is used as CopilotClient.workingDirectory — host path is
// correct here. A separate constant is used as the gate cwd.
const DEFAULT_WORKSPACE_DIR = getWorkspaceHostLocation(); // for SDK client only
```

Then, wherever `runCwd` falls back to `DEFAULT_WORKSPACE_DIR` for gate execution, 
replace with `getWorkspaceRoot()`:
```ts
// Before (wrong in Docker mode — host path, not container path):
const runCwd = req.body.cwd || DEFAULT_WORKSPACE_DIR;

// After:
const runCwd = req.body.cwd || getWorkspaceRoot();
```

`getWorkspaceRoot` is already imported from `'./workspace'` in `serverRuntime.ts` (line
~19 import block). No new dependency needed.

**If Phase 0-A does NOT confirm the bug:** Add a comment at the `DEFAULT_WORKSPACE_DIR`
assignment and the `runCwd` fallback explaining that the host path and container path
coincide in non-Docker mode, so the fallback is safe.

---

### 2-B — Orphan process fix (only if Phase 0-B confirms the bug)

**Files:** `src/workspace/dockerRunner.ts`, `src/workspace/nativeRunner.ts`

**Option A (preferred, no new dependency):** Use `detached: true` + process group kill.
In `runDockerProcess` / `runNativeProcess`, spawn with `{ detached: true }` and replace
`child.kill("SIGKILL")` with `process.kill(-child.pid!, "SIGKILL")` to kill the entire
process group.

**Option B:** Add `tree-kill` package and call it on abort.
```ts
import treeKill from 'tree-kill';
// replace: child.kill("SIGKILL")
// with:    treeKill(child.pid!, 'SIGKILL')
```

**If Phase 0-B does NOT confirm the bug:** Add an AGENTS.md note that `docker exec`
commands run in the container's process namespace, so inner children are scoped to the
container lifecycle and orphan concerns don't apply in Docker mode. Note the remaining
native-mode risk separately.

---

## Phase 3 — Type discipline ratchet (independent, start anytime)

**Goal:** Prevent new `any` from being introduced in touched files. Not a cleanup of the
existing ~450 legacy instances.

**Steps:**
1. Add an ESLint rule (or extend an existing `tsconfig`) that enables
   `@typescript-eslint/no-explicit-any` as a warning (not error) in a specific set of
   files — start with `src/orchestrator/` and `src/copilotSdk/boundary.ts` since those
   are new files that should be clean.
2. Add a lint step to CI that fails on new `any` added in a PR diff. A lightweight way:
   `git diff origin/main...HEAD -- 'src/orchestrator/**' 'src/copilotSdk/**' | grep '+.*: any'`
   fails the build if it finds matches.
3. Do NOT touch `serverRuntime.ts`'s existing `any` instances unless already modifying
   those lines for another reason.

---

## Phase 4 — Documentation (after Phases 1–2 land)

README sections `SYS-REQ-022` through `SYS-REQ-025` and AGENTS.md should describe the
*actual* architecture after the refactor, not the aspirational one. Update them in the
same PR that lands Phase 1-B so the docs and code are always consistent.

---

## Sequencing summary

```
Phase 0-A (verify gate cwd) ─┐
Phase 0-B (verify orphans)   ─┤─→ Phase 1 (boundary + orchestrator, one pass)
                               │       → Phase 2 (targeted fixes, small diffs)
                               │       → Phase 4 (docs against real code)
                               └── Phase 3 (type ratchet) — independent, anytime
```

**Do not skip Phase 0.** Building Phase 2 fixes around an unconfirmed bug wastes effort
and risks introducing a regression. The verification is cheap (one manual test each).
