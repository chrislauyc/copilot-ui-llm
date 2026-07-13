# Roadmap: CIV Hardening — Compliance Auditing, Escalation, and Spec Currency

Format: [EARS](https://alistairmavin.com/ears/), consistent with `README.md`'s
`ORCH-REQ-*`/`SYS-REQ-*` conventions. New requirement IDs use the `RM-REQ-*` prefix to
avoid collision with existing requirements; cross-references to existing requirements
are given where a new item extends or reuses established behavior.

Legend: **U** = Ubiquitous, **E** = Event-driven, **S** = State-driven, **O** = Optional
feature, **UB** = Unwanted behavior.

**Governing principle:** every item below is a tiering or triggering rule layered on
top of one existing primitive — task parking (ORCH-REQ-006) — rather than a new
blocking mechanism. No requirement in this document introduces a synchronous human
prompt. Where human judgment is required, the task (or spec) is parked and an async
escalation entry is raised; the human reviews on their own schedule via the existing
escalation queue, never as an in-loop interruption.

---

## 1. Asynchronous Human-in-the-Loop (Foundational Principle)

- **RM-REQ-001 (U):** The system shall treat all human-facing checkpoints as
  asynchronous notifications rather than blocking prompts; no orchestration path shall
  pause execution indefinitely awaiting human input.
- **RM-REQ-002 (E):** When a checkpoint requires human judgment before a task or spec
  can safely continue, the system shall park it (transition status to `blocked`,
  commit or stash the active workspace state, checkout the base branch) and continue
  processing other unblocked work, per the existing park-and-continue behavior defined
  in ORCH-REQ-006.
- **RM-REQ-003 (U):** The system shall surface all parked/escalated tasks and specs in
  a single async queue (the existing escalation store), rather than as modal
  interruptions, so a human can review at a time of their choosing.
- **RM-REQ-004 (U):** Every escalation entry, regardless of which requirement below
  triggered it, shall record which trigger fired (see RM-REQ-043), so the async queue
  is self-describing without requiring the human to reconstruct why a given item is
  there.

---

## 2. Full-Spec Compliance Audit Phase

Distinct from per-task gates: a per-task gate validates one task's diff against that
task's own description; a compliance audit validates the entire current workspace diff
against the entire spec file, and is the automated form of the manual
Gemini-then-Sonnet final pass.

- **RM-REQ-010 (U):** The system shall provide a compliance-audit operation, distinct
  from per-task gates, that evaluates the entire current workspace diff against the
  entire spec file for a given `specId`.
- **RM-REQ-011 (E):** When all tasks for a given `specId` reach status `done`, the
  system shall automatically trigger a compliance audit for that spec.
- **RM-REQ-012 (O):** The system may also trigger a compliance audit periodically
  (e.g. after every N completed tasks for a spec) prior to full completion, as a
  standing drift check independent of the end-of-run trigger in RM-REQ-011.
- **RM-REQ-013 (E):** When a compliance audit reports one or more findings, the system
  shall create new tasks via a structured tool call (the same forced-tool-call
  discipline used for the Auditor and PR Reviewer), not by writing prose into
  `architecture-spec.md` for the existing regex-based decomposer to reparse, and shall
  mark the spec's completion state as not-yet-satisfied.

---

## 3. Tiered Escalation for Compliance Audit

- **RM-REQ-020 (S):** While remediation tasks created by a compliance audit (RM-REQ-013)
  are executing, the system shall apply the same tiered escalation policy used for
  ordinary tasks — retry on the same model, then escalate model tier, then park with
  async human notification — rather than a separate hard-coded path for
  compliance-audit remediation.
- **RM-REQ-021 (E):** When a subsequent compliance audit, run after a full remediation
  cycle for the same `specId`, still reports findings, the system shall escalate the
  compliance audit itself to the next configured model tier (e.g. from a Gemini-tier
  auditor to a Sonnet-tier auditor) before creating further remediation tasks.
- **RM-REQ-022 (UB):** If a compliance audit at the highest configured tier still
  reports findings after remediation, the system shall park the spec (not merely the
  individual task) and raise an async human escalation for the spec as a whole, rather
  than looping indefinitely or silently accepting the remaining findings.

---

## 3a. Dependency-Blocked Spec Escalation

Distinct from Section 3's model-tier escalation: a task can be individually correct to leave
`blocked` (per ORCH-REQ-006) with no further action, if nothing downstream needs its work yet.
This section governs the transition from "one task is parked" to "the spec is stuck" — triggered
lazily, by downstream need, not eagerly by elapsed time or retry exhaustion.

- **RM-REQ-060 (E):** When the system selects the next task to run for a spec and that task's
  branch point depends on a task currently in status `blocked`, the system shall park the spec
  (not merely the dependent task) and raise a single async escalation entry referencing the
  blocking task, rather than allowing the dependent task to attempt execution against
  incomplete prerequisite work.
- **RM-REQ-061 (U):** A task in status `blocked` with no other task depending on it shall not,
  by itself, trigger spec-level escalation. Parking is a valid resting state; time elapsed since
  parking is not, on its own, an escalation trigger.
- **RM-REQ-062 (U):** Each escalation entry raised under RM-REQ-060 shall record the count of
  tasks — direct and transitive — whose branch point depends on the blocked task, so the async
  queue (RM-REQ-003) can be sorted by downstream impact rather than by recency alone.
  - **Open/Unsolved:** The method for computing the transitive dependent count is not yet
    specified. The current decomposer produces no explicit task dependency graph — only
    branch-point ancestry recoverable after the fact from git history. A dependency-graph
    representation (produced at decomposition time, or reconstructed from branch lineage) needs
    its own design pass before RM-REQ-062 can be implemented; until then, entries may record a
    direct-dependent count only, with transitive counting deferred.

---

## 4. Auditor Model Rotation

- **RM-REQ-030 (U):** The system shall maintain a predefined, configured pool of
  auditor models (e.g. an `AUDITOR_POOL` configuration list), distinct from ad hoc
  per-call model selection.
- **RM-REQ-031 (E):** When an auditor is invoked for a new gate/verification attempt,
  the system shall select the next model from the pool using a deterministic,
  non-repeating-until-exhausted rotation (e.g. round-robin), rather than always using
  a single fixed auditor model.
- **RM-REQ-032 (UB):** If the pool contains only one model, or the selected auditor
  model for a given attempt matches the Implementor's model for that task, the system
  shall log a warning noting reduced decorrelation for that attempt, but shall not
  block execution on it.
- **RM-REQ-033 (U):** The compliance audit (Section 2) shall select its model
  according to the tiering rule in RM-REQ-021, independent of the per-task rotation
  pool defined in RM-REQ-030 — tiering escalates by capability, rotation diversifies
  by decorrelation, and the two shall not be conflated into a single pool.

---

## 5. Plateau-Based Escalation

- **RM-REQ-040 (U):** The system shall track, per retry attempt within a task's gate
  loop, the combined count of `blocking`- and `suggestion`-severity findings reported
  by the verifier for that attempt.
- **RM-REQ-041 (S):** While a task is retrying, if the combined blocking+suggestion
  count is flat or increases across two consecutive attempts, the system shall trigger
  escalation immediately, without waiting for `retryCount` to reach `maxRetries`.
- **RM-REQ-042 (E):** When plateau-triggered escalation (RM-REQ-041) fires, the system
  shall follow the same escalation ladder used for ceiling-triggered escalation
  (model-tier escalation, then park with async human notification) — the plateau
  condition changes only the trigger, not the ladder.
- **RM-REQ-043 (U):** The system shall record, on each escalation entry, whether it was
  ceiling-triggered (RM-REQ-... existing `retryCount === maxRetries` path) or
  plateau-triggered (RM-REQ-041), to support later analysis of which trigger fires
  most often and whether the plateau threshold needs tuning.

---

## 6. Spec-Change Notification for In-Flight Tasks

- **RM-REQ-050 (E):** When `architecture-spec.md` changes while one or more tasks
  derived from it are in status `running`, the system shall notify each affected
  in-flight agent session that the specification has changed, reusing the existing
  abort/inject-and-resume mechanism already defined for real-time spec patching
  (ORCH-REQ-015/ORCH-REQ-016), rather than mutating the task's stored fields in place.
- **RM-REQ-051 (U):** The system shall NOT automatically transition an in-flight task
  to `stale` or `superseded` on spec change; task status transitions remain driven by
  the task's own execution outcome, not by the act of editing the spec. The notified
  agent (RM-REQ-050) is responsible for judging whether its in-progress work is still
  aligned with the change.
- **RM-REQ-052 (UB):** If a task is not currently `running` (e.g. still `pending`) when
  the spec changes, the system shall re-run decomposition against the updated spec for
  that task's not-yet-started portion using existing `decomposeSpecIntoTasks` behavior,
  since there is no active session to notify.

---

## Open Items Deliberately Deferred

- Transitive dependent-count computation for RM-REQ-062 — no task dependency graph exists
  today; the decomposer produces flat `title`/`description` records only. Needs a design pass
  (decomposition-time graph vs. post-hoc branch-lineage reconstruction) before RM-REQ-062 can
  move past direct-dependent counting.
- A code-tracked, deterministic finding-status mechanism, mirroring `O-6.9` in
  `review-agent-spec.md` — still deferred pending enough runs of the model-judged
  approach (Section 5 above) to show whether its false-negative rate is acceptable.
- Content-quality checks on forced-tool-call output (distinguishing a genuine
  zero-findings result from a hollow/rubber-stamped one) — flagged as a real gap but
  not yet specified; needs its own design pass before EARS items are written.
- A golden-fixture regression harness for auditor model swaps — worth building once
  Section 4's rotation pool is in active use, so there is a stable baseline to regress
  against.
