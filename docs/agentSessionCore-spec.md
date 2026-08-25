# agentSessionCore: Session Unit Extraction (SYS-REQ-029)

## Context

`SessionWrapper` (issue #246, SYS-REQ-026/027/028) already enforces a strict
boundary around SDK session creation: it is the only sanctioned caller of
`CopilotClient.createSession`/`resumeSession`, enforced by a
`no-restricted-syntax` lint rule. The *tooling* wired around that boundary is
not yet under any equivalent discipline:

- `RUN_TERMINAL_DOCKER_TOOL.function.{name,description,parameters}` is
  hand-mapped into an SDK `Tool` object independently in three places:
  `scripts/verify-run-terminal-docker.ts`, `src/utils/auditorHelper.ts`
  (`buildAuditorSessionSettings`), and `src/orchestrator/gateLoop.ts`
  (~line 973).
- There are two divergent exec-tool handler implementations:
  `toolHandlers.ts:makeDockerToolHandler` (SSE-streaming via `secureWrite`,
  enforces `checkActiveOrchestrationSession`, used by `gateLoop.ts`) and
  `auditorHelper.ts:makeAuditorExecToolHandler` (no streaming, **no**
  orchestration-lock check, used by `audit-codebase.ts` and, transitively,
  `review-pr.ts`). Both independently reimplement the same `workingDir`
  path-traversal check and `truncateOutput`/`sanitizeSensitives` cleanup.
- `gateLoop.ts` also wires a `run_tests` tool through the same
  `checkActiveOrchestrationSession` gate alongside `run_terminal_docker`
  (~line 990), so the unit being extracted cannot be docker-exec-specific
  without leaving that consumer behind.

This spec covers the extraction of a self-contained, tool-agnostic "agent
session" unit into `src/agentSessionCore/` (issue #415), the call-site
migration onto it (issue #416), and records the deferred, WIP-blocked
`gateLoop.ts` migration (issue #417) for continuity. It supersedes nothing in
SYS-REQ-026/027/028 -- `SessionWrapper` itself is unchanged; this unit is a
consumer of it, the same way the three current call sites are.

---

## Decisions carried from handoff (not re-litigated here)

- **Directory: `src/agentSessionCore/`.** Not `dockerSession` (too narrow --
  see the `run_tests` case above) and not `agentSession` alone (the "Core"
  signals this is the load-bearing primitive other orchestration code sits
  on top of, not a full orchestration layer itself).
- **No file moves.** `src/workspace/workspace.ts` and
  `src/orchestrator/sessionState.ts` stay where they are and are imported by
  `src/agentSessionCore/`, not relocated into it -- both have consumers
  (gates, test harnesses, `pathGuard.ts`, `taskManager.ts`, SSE bookkeeping,
  logging) far outside this unit's scope.
- **Build approach: hotswap**, mirroring how `SessionWrapper` itself
  superseded `hardenedSession.ts` and how `getOrCreateSessionWrapper`
  (`sessionState.ts:410`) coexists with the legacy `getOrCreateSession`.
  `src/agentSessionCore/` is built and tested standalone under #415 without
  touching any existing call site; #416 migrates callers one at a time; the
  three duplicated tool-mapping sites and `makeAuditorExecToolHandler` are
  left in place, dormant, until their caller has moved.
- **Lint enforcement is an #416 acceptance criterion, not part of #415.**
  Mirrors the `no-restricted-syntax` rule added for `SessionWrapper` --
  see Requirements below for its shape.

---

## Requirements

### Scope and composition (#415)

- **SYS-REQ-029 (Ubiquitous):** `src/agentSessionCore/` **shall** be the
  single module tree that constructs agent-executed tool schemas (starting
  with, but not limited to, `run_terminal_docker`) for use with
  `SessionWrapper`, and that decides the orchestration-lock behavior
  (SYS-REQ-029e) for each such tool.

- **SYS-REQ-029a:** `src/agentSessionCore/` **shall** re-export or wrap the
  following without relocating their source files: `SessionWrapper`
  (`src/copilotSdk/sessionWrapper.ts`), `getExecCommand`/`getWorkspaceRoot`/
  `getWorkspaceHostLocation`/`getGitSandbox`/`initializeWorkspace`
  (`src/workspace/`), `checkActiveOrchestrationSession`
  (`src/orchestrator/sessionState.ts`), and `runForcedToolTurnUntilTimeout`
  (`src/utils/toolCallEnforcement.ts`).

- **SYS-REQ-029b:** `src/agentSessionCore/` **shall** expose exactly one
  canonical tool-definition factory for `run_terminal_docker` -- e.g.
  `createExecToolDefinition(...)` -- that maps
  `RUN_TERMINAL_DOCKER_TOOL.function.{name,description,parameters}`
  (`src/config/tools.ts`) into an SDK `Tool`. No other module **shall**
  perform this mapping once #416 completes (see SYS-REQ-029m).

- **SYS-REQ-029c:** `src/agentSessionCore/` **shall** expose a top-level
  session factory -- e.g. `createAgentSession(...)` -- that is tool-agnostic:
  it **shall** accept an array of tool definitions to register (not only the
  canonical exec tool), so `gateLoop.ts`'s `run_tests` tool (and any future
  non-exec tool) can be composed through the same unit rather than being left
  outside it. The factory **shall** return a configured `SessionWrapper`
  instance with the supplied tools already registered per SYS-REQ-028a --
  nothing downstream of `createAgentSession(...)` **shall** re-derive tool
  schemas by hand.

- **SYS-REQ-029d:** The canonical exec-tool handler (backing
  SYS-REQ-029b's factory) **shall** perform the `workingDir` path-traversal
  check and `truncateOutput`/`sanitizeSensitives` output cleanup exactly
  once, shared by every caller, superseding the duplicated logic currently
  in both `makeDockerToolHandler` and `makeAuditorExecToolHandler`.

### Orchestration-lock: explicit, not defaulted

The handoff flags this as needing "an explicit decision during #415/#416,
not an accident of whichever handler gets kept." The resolution below keeps
it a per-call-site decision rather than picking one of the two existing
behaviors as a silent default:

- **SYS-REQ-029e:** The canonical exec-tool handler factory **shall**
  require an explicit `orchestrationLock` parameter with no default value.
  Omitting it **shall** be a compile-time (TypeScript) error, not a runtime
  fallback. Valid values:
  - `'enforced'` -- wraps the handler with `checkActiveOrchestrationSession`
    exactly as `makeDockerToolHandler` does today (rejects with the existing
    "requires an active, authorized orchestration session context" message
    when the gate fails).
  - `'bypassed'` -- no gate check, exactly as `makeAuditorExecToolHandler`
    does today.

  This turns the divergence identified in #415/#416 into a mandatory,
  visible choice at every call site instead of leaving it implicit in which
  of the two legacy handlers a given caller happened to copy.

- **SYS-REQ-029f (Unwanted Behavior):** **If** a call site constructs the
  canonical exec-tool handler without supplying `orchestrationLock`, **then**
  the build **shall** fail to compile.

- **SYS-REQ-029g:** SSE stream write-back (`secureWrite`/`res`, currently
  baked into `makeDockerToolHandler` only) **shall** be an independent,
  optional parameter of the canonical handler factory, orthogonal to
  `orchestrationLock`. This is required because the three concrete
  combinations in use today are not the same axis:
  - `gateLoop.ts`: streaming **and** `'enforced'`.
  - `audit-codebase.ts` / `review-pr.ts` (via `auditorHelper.ts`):
    non-streaming **and** `'bypassed'`.
  - `verify-run-terminal-docker.ts`: non-streaming **and** `'bypassed'`,
    against a real container.

  Collapsing streaming and lock-mode into one flag would force a fourth,
  bespoke handler back into existence the next time a caller needs a
  combination other than these three -- exactly the duplication this
  extraction exists to close.

- **SYS-REQ-029h:** Every #416 call-site migration **shall** record, in a
  code comment at the call site, which `orchestrationLock` value it passes
  and one sentence of rationale. This satisfies #416's acceptance criterion
  that the lock behavior be "a deliberate, documented choice," and gives
  reviewers a single grep target (`orchestrationLock:`) to audit all
  decisions at once during #416 review.

### Raw/bypass mode for `verify-run-terminal-docker.ts` (#416)

- **SYS-REQ-029i:** `verify-run-terminal-docker.ts` **shall** migrate to
  `createExecToolDefinition(...)` with `orchestrationLock: 'bypassed'` and no
  streaming callback, rather than keeping its local `makeExecToolHandler()`.
  This does not reintroduce a fourth handler (SYS-REQ-029g already makes
  `'bypassed'` + non-streaming an expressible, shared combination) and
  preserves the script's own documented intent -- exercising "the exact
  production handler" -- more faithfully than the current copy, since
  after migration the script and `auditorHelper.ts` genuinely share one
  implementation instead of two independently-drifting ones.
- **SYS-REQ-029i-1:** This migration **shall not** change
  `verify-run-terminal-docker.ts`'s observable pass/fail behavior against a
  real container (#416 acceptance criterion) -- canary-file and
  workspace-root assertions are unaffected by which module constructed the
  tool definition.

### Call-site migration (#416)

- **SYS-REQ-029j:** Once `src/agentSessionCore/` passes its own tests
  (#415), `scripts/verify-run-terminal-docker.ts`, `scripts/audit-codebase.ts`
  (via `auditorHelper.ts:buildAuditorSessionSettings`), and
  `scripts/review-pr.ts` (via `auditorHelper.ts:executeAuditSession`)
  **shall** construct their `run_terminal_docker` tool exclusively through
  `createExecToolDefinition(...)` (SYS-REQ-029b), not via manual
  `RUN_TERMINAL_DOCKER_TOOL.function.*` mapping.
- **SYS-REQ-029k:** `auditorHelper.ts:makeAuditorExecToolHandler` **shall**
  be deleted once `buildAuditorSessionSettings` and `executeAuditSession`
  both route through SYS-REQ-029j, per SYS-REQ-029b's "no other module
  performs this mapping" clause.
- **SYS-REQ-029l:** A `no-restricted-syntax` (or `no-restricted-imports`)
  lint rule **shall** be added, mirroring the `createSession`/`resumeSession`
  rule in `eslint.config.js`, restricting direct references to
  `RUN_TERMINAL_DOCKER_TOOL.function.*` outside `src/agentSessionCore/`
  itself. This is the #415/#416 boundary's enforcement mechanism and
  **shall** land as part of #416 (per the handoff's "enforcement is a
  migration task, not part of the extraction issue").
- **SYS-REQ-029m:** `runForcedToolTurnUntilTimeout` call sites in the three
  #416 consumers **shall** be updated to take the `SessionWrapper` produced
  by `createAgentSession(...)` (SYS-REQ-029c), consistent with its existing
  signature (`wrapper: SessionWrapper`, ...) -- no change to
  `toolCallEnforcement.ts` itself is implied by this spec.

### `gateLoop.ts` (#417, deferred)

- **SYS-REQ-029n (Deferred):** Migrating `gateLoop.ts`'s two
  `loopSessionOptions`/`getOrCreateSession` call sites (~line 965-1013,
  ~line 1805) onto `createAgentSession(...)` is filed for tracking only
  (issue #417) and **shall not** begin before gateLoop's own design has
  stabilized, per #417's stated status. When it does happen: `gateLoop.ts`
  currently registers `run_terminal_docker` **and** `run_tests` under the
  same `checkActiveOrchestrationSession` gate in one `tools` array
  (~line 973-1010) plus a session-level `onPermissionRequest:
  handleGateRunPermission` -- SYS-REQ-029c's tool-agnostic factory shape is
  a prerequisite for expressing this without special-casing gateLoop, but
  folding `handleGateRunPermission` into `enableTools`/`disableTools` (as
  #417 proposes) is out of scope for this spec and belongs to gateLoop's own
  design work.

---

## Test coverage implied by this spec

1. **No re-derivation outside the unit (029, 029b):** assert (via the
   SYS-REQ-029l lint rule, plus a unit test enumerating `src/agentSessionCore/`
   as the sole importer of `RUN_TERMINAL_DOCKER_TOOL.function.*` post-#416)
   that no other module maps the raw tool schema by hand.
2. **Tool-agnostic factory (029c):** construct `createAgentSession(...)` with
   two tool definitions, one of them not `run_terminal_docker` (e.g. a stub
   mirroring `run_tests`'s shape); assert both are present in the returned
   `SessionWrapper`'s construction-time tool list (SYS-REQ-028a).
3. **Shared cleanup logic (029d):** assert a `workingDir` containing `..`
   is rejected identically regardless of `orchestrationLock` value or
   streaming callback presence; assert `truncateOutput`/`sanitizeSensitives`
   is applied exactly once per call, not duplicated.
4. **Explicit lock, no default (029e, 029f):** a TypeScript compile-only
   test (`// @ts-expect-error`) asserting `createExecToolDefinition({...})`
   without `orchestrationLock` fails to compile.
5. **`'enforced'` gates, `'bypassed'` doesn't (029e):** with an
   `orchestrationLock: 'enforced'` handler and no active orchestration
   session, assert the call is rejected with the existing gate message;
   with `'bypassed'`, assert the same setup executes the command.
6. **Streaming is orthogonal (029g):** construct with
   `orchestrationLock: 'bypassed'` and a streaming callback supplied; assert
   both the gate is skipped and the streaming callback fires. Construct the
   inverse (`'enforced'`, no callback); assert the gate runs and no
   streaming write is attempted.
7. **Verify-script parity (029i, 029i-1):** re-run
   `verify-run-terminal-docker.ts`'s existing canary/workspace-root/exit-code
   assertions post-migration; all three **shall** still pass unchanged
   against a real container.
8. **`auditorHelper.ts` cleanup (029k):** assert
   `makeAuditorExecToolHandler` is no longer exported/referenced once
   `buildAuditorSessionSettings` migrates.

---

## Open Questions

1. **Whether `checkActiveOrchestrationSession` itself should physically move**
   from `src/orchestrator/sessionState.ts` into `src/agentSessionCore/`
   (currently: imported, not moved, per the handoff). Flagged there as a
   separate, independently reviewable step if/when it happens -- not
   resolved by this spec.
2. **`SessionWrapper.adopt()`** remains an unresolved escape hatch pending
   owner sign-off (see `sessionWrapper.ts`'s own TODO(#78) comments on
   SYS-REQ-028f/028j tension). Unrelated to this extraction, but
   `createAgentSession(...)` (SYS-REQ-029c) should be checked against it
   during implementation: if any #416/#417 consumer needs to adopt an
   already-created session (as `audit-codebase.ts`/`gateLoop.ts` do
   elsewhere via `SessionPolicy`), the factory may need an `adopt`-based
   variant rather than assuming construction-only use. Not decided here.
3. **Rationale-comment enforcement (SYS-REQ-029h)** is specified as a
   code-review convention (grep-able comment), not a machine-checked rule.
   Whether it's worth a custom lint rule (e.g. requiring a `// lock-rationale:`
   comment adjacent to every `orchestrationLock:` literal) is left to #416
   implementation judgment -- called out here so it isn't silently dropped.
