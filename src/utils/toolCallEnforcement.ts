import { CopilotSession, MessageOptions } from '../copilotSdk/boundary';
import { SessionWrapper } from '../copilotSdk/sessionWrapper';

/**
 * How much of the model's last assistant message to include when we give up
 * retrying and throw. Long enough to diagnose, short enough not to flood logs.
 */
export const LAST_MESSAGE_TRUNCATE_LENGTH = 2000;

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... [truncated, ${text.length} chars total]`;
}

/**
 * Attaches a listener that accumulates the assistant's text content for the
 * current turn so that, if the tool is never called, we have something
 * meaningful to report instead of a bare "returned null".
 *
 * Returns a getter for the accumulated text and the unsubscribe function.
 */
export function trackLastAssistantMessage(session: CopilotSession): { readonly getText: () => string; readonly unsubscribe: () => void } {
  let text = '';
  const unsubscribe = session.on((event: unknown) => {
    if (!event || typeof event !== 'object') return;
    const ev = event as Record<string, unknown>;
    const evData = ev.data as Record<string, unknown> | undefined;
    if (ev.type === 'assistant.message') {
      text += (evData?.content as string | undefined) || '';
    } else if (ev.type === 'assistant.message_delta') {
      text += (evData?.delta as string | undefined) || (evData?.content as string | undefined) || '';
    }
  });
  return { getText: () => text, unsubscribe };
}

/**
 * How long to tolerate total silence from the SDK (no events of any kind)
 * before treating the current send as a stalled upstream stream rather than
 * a genuine timeout. Matches the watchdog gateLoop.ts uses for the same
 * failure mode (upstream provider issues a tool call, or nothing at all,
 * and then the connection just idles with no session.error ever emitted).
 */
export const STALL_TIMEOUT_MS = 90000;
const STALL_POLL_INTERVAL_MS = 5000;

/**
 * Passed to the SDK's own `session.sendAndWait()` as its internal timeout
 * parameter. Per the SDK's docs, that parameter is an ABSOLUTE deadline --
 * it "does not abort in-flight agent work" and fires purely based on
 * elapsed time, regardless of whether the turn is actively making
 * progress. Only applied when the caller's own `timeoutMs` already exceeds
 * STALL_TIMEOUT_MS -- i.e. they've already opted into a budget long enough
 * that the idle-based stall watchdog below is expected to be the real
 * governor.
 */
const SDK_HARD_TIMEOUT_CEILING_MS = 30 * 60 * 1000; // 30 minutes

export interface StallError extends Error {
  readonly isStall: true;
}

function isStallError(err: unknown): err is StallError {
  return err instanceof Error && (err as Partial<StallError>).isStall === true;
}

/**
 * Execution-aware silence tracking (see AGENTS.md: "Execution-aware silence
 * tracking" and the "Stall-watchdog recovery retired..." entry it's
 * cross-referenced from).
 *
 * Tracks time since the last SDK event of any kind, but treats time spent
 * inside a tool call -- between `tool.execution_start` and
 * `tool.execution_complete`, the only events bookending it -- as *not*
 * silence: a slow-but-healthy tool must not be mistaken for a dead upstream
 * connection (issues #188/#191, reproduced on PR #136).
 *
 * Currently only consumed by the dormant `sendAndWaitWithAbort` stall
 * watchdog below. Pulled out as a standalone, documented utility so the
 * pattern is easy to find and reuse if a genuine stall is ever observed
 * independently of turn duration (issue #207). Callers feed events in via
 * `recordEvent`.
 */
export function createExecutionAwareSilenceTracker() {
  let lastEventAt = Date.now();
  let lastEventType: string | undefined;
  let toolExecutionActive = false;

  return {
    recordEvent(event: unknown): void {
      lastEventAt = Date.now();
      if (!event || typeof event !== 'object' || !('type' in event)) return;
      const ev = event as Record<string, unknown>;
      lastEventType = String(ev.type);
      if (ev.type === 'tool.execution_start') toolExecutionActive = true;
      if (ev.type === 'tool.execution_complete') toolExecutionActive = false;
    },
    silentForMs(): number | null {
      if (toolExecutionActive) return null;
      return Date.now() - lastEventAt;
    },
    lastEventType: () => lastEventType,
  };
}

/**
 * Races a `SessionWrapper`'s `sendAndWait` against an abort signal (as
 * before) *and* a stall watchdog: if no SDK event of any kind arrives for
 * STALL_TIMEOUT_MS, this rejects with a distinguishable `isStall`-tagged
 * error instead of silently waiting out the full `timeoutMs`. Does not
 * retry by itself -- callers (`runForcedToolTurn`) decide whether/how to
 * retry on a stall.
 *
 * Takes a `SessionWrapper` rather than a raw `CopilotSession` (issue #346):
 * the wrapper decides create-vs-resume internally, so the stall tracker's
 * listener is attached via `SessionWrapper.sendAndWait`'s `onSessionReady`
 * callback -- invoked synchronously right after the (possibly brand-new, on
 * resume) underlying session is created, before the prompt is sent --
 * rather than being attached to a session object the caller already has in
 * hand. `onSessionReady`, if supplied, is called with that same session so
 * callers needing their own per-session listeners (tool-call tracking, in
 * `runForcedToolTurn` below) don't need a second, separately-timed
 * attachment point.
 *
 * `timeoutMs` is intentionally NOT passed straight through to the SDK's own
 * sendAndWait deadline -- see SDK_HARD_TIMEOUT_CEILING_MS.
 */
const USAGE_TELEMETRY_LOG_LIMIT = 3;

export async function sendAndWaitWithAbort(
  wrapper: SessionWrapper,
  prompt: MessageOptions,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  onSessionReady?: (session: CopilotSession) => void,
): Promise<void> {
  let usageTelemetryLogCount = 0;
  const silenceTracker = createExecutionAwareSilenceTracker();
  let unsubscribeStallTracker: (() => void) | undefined;

  const attach = (session: CopilotSession): void => {
    unsubscribeStallTracker = session.on((event: unknown) => {
      silenceTracker.recordEvent(event);
      if (!event || typeof event !== 'object' || !('type' in event)) return;
      const ev = event as Record<string, unknown>;

      if (ev.type === 'tool.execution_start') {
        const data = ev.data as Record<string, unknown> | undefined;
        const toolName = data?.toolName;
        if (typeof toolName === 'string' && toolName.length > 0) {
          console.log(`[sendAndWaitWithAbort] tool used: ${toolName}`);
        } else {
          console.error(
            `[sendAndWaitWithAbort] UNEXPECTED EVENT SHAPE: 'tool.execution_start' event is missing a valid ` +
            `string 'toolName' in its data (got: ${JSON.stringify(data)}). This violates an assumption about ` +
            `the SDK's event contract -- investigate before trusting this event's downstream handling.`,
          );
        }
      }

      if (
        (ev.type === 'assistant.usage' || ev.type === 'session.usage_info') &&
        usageTelemetryLogCount < USAGE_TELEMETRY_LOG_LIMIT
      ) {
        usageTelemetryLogCount++;
        if (ev.data && typeof ev.data === 'object') {
          console.log(`[UsageTelemetry] auditor session ${JSON.stringify(ev.data)}`);
        } else {
          console.error(
            `[sendAndWaitWithAbort] UNEXPECTED EVENT SHAPE: '${ev.type}' event has no usable 'data' object ` +
            `(got: ${JSON.stringify(ev.data)}). This violates an assumption about the SDK's event contract -- ` +
            `investigate before trusting this event's downstream handling.`,
          );
        }
      }
    });
    onSessionReady?.(session);
  };

  let stallTimer: ReturnType<typeof setInterval> | null = null;
  const stallPromise = new Promise<never>((_, reject) => {
    stallTimer = setInterval(() => {
      const elapsed = silenceTracker.silentForMs();
      if (elapsed !== null && elapsed > STALL_TIMEOUT_MS) {
        if (stallTimer) clearInterval(stallTimer);
        console.warn(
          `[sendAndWaitWithAbort] stall detected: no SDK event for ${elapsed}ms (threshold ${STALL_TIMEOUT_MS}ms); ` +
          `lastEventType=${silenceTracker.lastEventType() ?? 'none'}`,
        );
        const err = new Error(
          `Upstream stream stalled: no SDK event received for over ${STALL_TIMEOUT_MS / 1000}s.`,
        ) as StallError;
        (err as { isStall?: boolean }).isStall = true;
        reject(err);
      }
    }, STALL_POLL_INTERVAL_MS);
  });

  const racers: Promise<void>[] = [
    wrapper
      .sendAndWait(
        prompt,
        timeoutMs > STALL_TIMEOUT_MS ? Math.max(timeoutMs, SDK_HARD_TIMEOUT_CEILING_MS) : timeoutMs,
        attach,
      )
      .then(() => undefined),
    stallPromise,
  ];
  if (abortSignal) {
    racers.push(
      new Promise<never>((_, reject) => {
        const onAbort = () => reject(new Error('Auditor session aborted by client or timeout'));
        if (abortSignal.aborted) onAbort();
        else abortSignal.addEventListener('abort', onAbort, { once: true });
      }),
    );
  }

  try {
    await Promise.race(racers);
  } finally {
    if (stallTimer) clearInterval(stallTimer);
    unsubscribeStallTracker?.();
  }
}

export interface ForcedToolTurnOptions<T> {
  abortSignal?: AbortSignal;
  /** Wire-level provider identifier (e.g. `'openrouter'`), used only to decide whether to send an explicit `tool_choice` on a nudge retry. */
  provider?: unknown;
  timeoutMs?: number;
  maxRetries?: number;
  getResult: () => T | undefined;
  /**
   * The turn's full tool allowlist (as opposed to the narrower
   * `targetTools` allowlist a nudge-retry switches to). Used only to know
   * which construction-time tools to `disableTools()` before re-enabling
   * just `targetTools` on a nudge retry -- defaults to `targetTools` if
   * omitted. The wire-level tool schema itself is entirely owned by the
   * `SessionWrapper` the caller constructed and is never touched here
   * (SYS-REQ-028/028a).
   */
  availableTools?: string[];
  responseRequirements?: { toolCallExample?: string };
  /**
   * Called with every underlying session this turn runs on -- the initial
   * session, and each new session object the wrapper produces internally on
   * a nudge or stall retry (`SessionWrapper.sendAndWait`'s `onSessionReady`
   * callback returns a *different* CopilotSession object each time it
   * creates/resumes). Return an unsubscribe function so it can be cleaned
   * up before the next retry.
   */
  onSession?: (session: CopilotSession) => (() => void) | void;
  /**
   * How many times to retry after an upstream stall before giving up.
   * Tracked separately from `maxRetries`. Default 2.
   */
  maxStallRetries?: number;
  /**
   * When provided, a stall recovery whose first (resume-preserving-history)
   * attempt itself stalls abandons the wrapper it's holding and calls this
   * to construct a brand-new `SessionWrapper` instead of continuing to
   * resume -- replaces the pre-#346 `freshSessionConfig` option, which
   * created a second raw `CopilotSession` directly. Because a fresh
   * `SessionWrapper` has no conversation history, recovery always restarts
   * from `initialPrompt` rather than replaying whatever prompt was in
   * flight. If omitted, falls back to the wrapper's own internal resume
   * behavior (which does replay the exact in-flight prompt).
   */
  createFreshWrapper?: () => SessionWrapper;
  /**
   * Called with the id of every session this turn runs on, including ones
   * created mid-turn by stall recovery.
   */
  onSessionId?: (sessionId: string) => void;
}

/**
 * Detects whether a `tool.*` event matches one of `targetTools`, for the
 * shared tool-call-detection listener both forced-tool-turn functions below
 * install on every session they run on.
 */
function eventMatchesTargetTool(ev: Record<string, unknown>, targetTools: readonly string[]): boolean {
  return (
    (ev.type === 'tool.user_requested' && targetTools.includes((ev.data as any)?.toolName)) ||
    (ev.type === 'tool.execution_start' && targetTools.includes((ev.data as any)?.toolName)) ||
    (ev.type === 'external_tool.requested' && targetTools.includes((ev.data as any)?.toolName)) ||
    (ev.type === 'tool.execution_complete' && (ev.data as any)?.toolCallId && targetTools.some(t => (ev.data as any).toolCallId === `call-${t}`)) ||
    (ev.type === 'tool.execution_complete' && targetTools.includes((ev.data as any)?.toolName))
  );
}

/**
 * Restricts `wrapper` to only `targetTools` being enabled among
 * `turnAvailableTools`, for a nudge retry (SYS-REQ-028c: enablement is a
 * private, permission-layer-only concept -- the wire-level schema itself is
 * never touched). `turnAvailableTools` is disabled first (as a superset that
 * includes `targetTools`), then `targetTools` is re-enabled.
 */
function restrictToTargetTools(wrapper: SessionWrapper, turnAvailableTools: readonly string[], targetTools: readonly string[]): void {
  wrapper.disableTools(...turnAvailableTools);
  wrapper.enableTools(...targetTools);
}

/**
 * Zero production callers as of #362 (all migrated to
 * `runForcedToolTurnUntilTimeout`) -- intentionally retained, not dead code
 * to prune. See AGENTS.md "Stall-watchdog recovery retired in favor of a
 * single hard timeout": this is the stall-recovery path to reach for again
 * if a genuine dead-upstream-connection stall is ever observed independently
 * of turn duration. Do not delete as part of unrelated cleanup.
 */
export async function runForcedToolTurn<T>(
  wrapper: SessionWrapper,
  toolName: string | string[],
  initialPrompt: string,
  opts: ForcedToolTurnOptions<T>
): Promise<{ result: T; session: CopilotSession; lastAssistantText: string; toolCalled: boolean }> {
  let currentWrapper = wrapper;
  const timeoutMs = opts.timeoutMs ?? 300000;
  const maxRetries = opts.maxRetries ?? 2;
  const maxStallRetries = opts.maxStallRetries ?? 2;
  const responseRequirements = opts.responseRequirements ?? {};

  let toolCalled = false;
  const targetTools = Array.isArray(toolName) ? toolName : [toolName];
  const turnAvailableTools = opts.availableTools ?? targetTools;

  let tracker: { readonly getText: () => string; readonly unsubscribe: () => void } | undefined;
  let unsubTool: (() => void) | undefined;
  let unsubOnSession: (() => void) | undefined;

  const setupToolListener = (s: CopilotSession) => {
    return s.on((event: unknown) => {
      const ev = event as Record<string, unknown>;
      if (eventMatchesTargetTool(ev, targetTools)) {
        toolCalled = true;
      }
    });
  };

  const handleSessionReady = (session: CopilotSession): void => {
    unsubOnSession?.();
    tracker?.unsubscribe();
    unsubTool?.();
    tracker = trackLastAssistantMessage(session);
    toolCalled = false;
    unsubTool = setupToolListener(session);
    unsubOnSession = opts.onSession?.(session) ?? undefined;
    opts.onSessionId?.(session.sessionId);
  };

  const sendWithStallRetry = async (
    promptOpts: { prompt: string; tool_choice?: unknown },
  ): Promise<void> => {
    let stallAttempt = 0;
    let currentPromptOpts = promptOpts;
    let resumeAttempted = false;
    while (true) {
      try {
        await sendAndWaitWithAbort(currentWrapper, currentPromptOpts as MessageOptions, timeoutMs, opts.abortSignal, handleSessionReady);
        return;
      } catch (err) {
        if (!isStallError(err)) {
          throw err;
        }
        if (toolCalled) {
          console.warn(
            `[runForcedToolTurn] upstream went quiet after '${targetTools.join("', '")}' was already called; ` +
            `treating turn as complete instead of retrying.`,
          );
          return;
        }
        if (stallAttempt >= maxStallRetries) {
          throw err;
        }
        stallAttempt++;
        try {
          await currentWrapper.session?.disconnect?.();
        } catch (e) {
          console.warn(`[runForcedToolTurn] disconnect failed. ${e}`);
        }
        if (opts.createFreshWrapper) {
          if (!resumeAttempted && stallAttempt < maxStallRetries) {
            console.warn(
              `[runForcedToolTurn] upstream stall detected (attempt ${stallAttempt}/${maxStallRetries}); ` +
              `attempting to resume the stalled session before falling back to a fresh one...`,
            );
            resumeAttempted = true;
          } else {
            console.warn(
              `[runForcedToolTurn] resume attempt itself stalled (attempt ${stallAttempt}/${maxStallRetries}); ` +
              `starting a new session and retrying the original prompt...`,
            );
            currentWrapper = opts.createFreshWrapper();
            currentPromptOpts = { prompt: initialPrompt };
            resumeAttempted = false;
          }
        } else {
          console.warn(
            `[runForcedToolTurn] upstream stall detected (attempt ${stallAttempt}/${maxStallRetries}); ` +
            `resuming session and retrying the same prompt...`,
          );
        }
      }
    }
  };

  await sendWithStallRetry({ prompt: initialPrompt });

  let lastAssistantText = tracker?.getText() ?? '';

  let attempt = 0;

  while (!toolCalled && attempt < maxRetries) {
    attempt++;
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    console.warn(
      `[runForcedToolTurn] turn ended without ${toolNamesStr} being called ` +
      `(attempt ${attempt}/${maxRetries}); resuming session with restricted toolset...`
    );

    const exampleBlock = responseRequirements.toolCallExample
      ? `\n\nUse your tool-calling capability (a real function/tool call) -- not text in your message. Example of correctly-shaped arguments:\n\n${responseRequirements.toolCallExample}`
      : '';
    const nudge = lastAssistantText.trim()
      ? `You did not call any of: ${toolNamesStr}. Your last message was:\n"""\n${truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH)}\n"""\nYou must now call one of ${toolNamesStr} with your findings. Do not respond conversationally, do not ask clarifying questions, and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`
      : `You ended your turn without calling any of: ${toolNamesStr}. You must now call one of ${toolNamesStr} with your findings. Do not respond conversationally and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`;

    restrictToTargetTools(currentWrapper, turnAvailableTools, targetTools);

    const promptOpts = { prompt: nudge, tool_choice: undefined as any };
    if (opts.provider === 'openrouter') {
      promptOpts.tool_choice = { type: 'function', function: { name: targetTools[0] } };
    }

    await sendWithStallRetry(promptOpts);

    lastAssistantText = tracker?.getText() || lastAssistantText;
  }

  unsubOnSession?.();

  if (!toolCalled) {
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    const truncated = truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH);
    throw new Error(
      `Session ended without calling ${toolNamesStr} after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'}. ` +
      `Model's last message: ${truncated || '(no assistant text captured)'}`
    );
  }

  let finalResult = opts.getResult();
  if (toolCalled && (finalResult === null || finalResult === undefined)) {
    finalResult = (true as unknown) as T;
  }

  return { result: finalResult as T, session: currentWrapper.session as CopilotSession, lastAssistantText, toolCalled };
}

/**
 * Default hard timeout for `runForcedToolTurn`'s "no watchdog" successor,
 * `runForcedToolTurnUntilTimeout`. 60 minutes is generous headroom for a
 * legitimately long, healthy, reasoning-heavy turn.
 */
export const FORCED_TOOL_TURN_HARD_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Same options shape as `ForcedToolTurnOptions`, minus the stall-specific
 * knobs (`maxStallRetries`, `createFreshWrapper`) that don't apply here --
 * there is no stall detection or stall recovery in this function.
 */
export type ForcedToolTurnUntilTimeoutOptions<T> = Omit<
  ForcedToolTurnOptions<T>,
  'maxStallRetries' | 'createFreshWrapper'
>;

/**
 * Successor to `runForcedToolTurn` for callers that don't need stall
 * recovery (issue #207). Keeps the tool-not-called nudge/retry loop
 * unchanged, but replaces the idle-silence watchdog and mid-turn
 * stall-recovery ladder with a single hard timeout racing
 * `wrapper.sendAndWait` directly.
 *
 * Takes a `SessionWrapper` instead of a raw `CopilotSession` +
 * `executionConfig` (issue #346): the wrapper owns the session's entire
 * lifecycle (create vs. resume), so this function's internal nudge-retry
 * calls `wrapper.sendAndWait(...)` and mutates the wrapper's enabled-tool
 * subset (`enableTools`/`disableTools`) instead of building a fresh
 * `SessionPolicy` per resume via `hardenedSession.ts` -- this module no
 * longer imports anything from there. The caller is responsible for
 * constructing and configuring the wrapper (tools, system prompt, model)
 * before passing it in.
 *
 * `runForcedToolTurn`, `sendAndWaitWithAbort`, `STALL_TIMEOUT_MS`,
 * `isStallError`, and their existing tests are left in place, dormant, not
 * deleted -- see AGENTS.md.
 */
export async function runForcedToolTurnUntilTimeout<T>(
  wrapper: SessionWrapper,
  toolName: string | string[],
  initialPrompt: string,
  opts: ForcedToolTurnUntilTimeoutOptions<T>
): Promise<{ result: T; session: CopilotSession; lastAssistantText: string; toolCalled: boolean }> {
  const timeoutMs = opts.timeoutMs ?? FORCED_TOOL_TURN_HARD_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? 2;
  const responseRequirements = opts.responseRequirements ?? {};

  let toolCalled = false;
  const targetTools = Array.isArray(toolName) ? toolName : [toolName];
  const turnAvailableTools = opts.availableTools ?? targetTools;
  let usageTelemetryLogCount = 0;

  let tracker: { readonly getText: () => string; readonly unsubscribe: () => void } | undefined;
  let unsubTool: (() => void) | undefined;
  let unsubOnSession: (() => void) | undefined;

  const setupToolListener = (s: CopilotSession) => {
    return s.on((event: unknown) => {
      const ev = event as Record<string, unknown>;

      if (ev.type === 'tool.execution_start') {
        const data = ev.data as Record<string, unknown> | undefined;
        const toolName = data?.toolName;
        if (typeof toolName === 'string' && toolName.length > 0) {
          console.log(`[runForcedToolTurnUntilTimeout] tool used: ${toolName}`);
        } else {
          console.error(
            `[runForcedToolTurnUntilTimeout] UNEXPECTED EVENT SHAPE: 'tool.execution_start' event is missing a valid ` +
            `string 'toolName' in its data (got: ${JSON.stringify(data)}). This violates an assumption about ` +
            `the SDK's event contract -- investigate before trusting this event's downstream handling.`,
          );
        }
      }

      if (
        (ev.type === 'assistant.usage' || ev.type === 'session.usage_info') &&
        usageTelemetryLogCount < USAGE_TELEMETRY_LOG_LIMIT
      ) {
        usageTelemetryLogCount++;
        if (ev.data && typeof ev.data === 'object') {
          console.log(`[UsageTelemetry] auditor session ${JSON.stringify(ev.data)}`);
        } else {
          console.error(
            `[runForcedToolTurnUntilTimeout] UNEXPECTED EVENT SHAPE: '${ev.type}' event has no usable 'data' object ` +
            `(got: ${JSON.stringify(ev.data)}). This violates an assumption about the SDK's event contract -- ` +
            `investigate before trusting this event's downstream handling.`,
          );
        }
      }

      if (eventMatchesTargetTool(ev, targetTools)) {
        toolCalled = true;
      }
    });
  };

  const handleSessionReady = (session: CopilotSession): void => {
    unsubOnSession?.();
    tracker?.unsubscribe();
    unsubTool?.();
    tracker = trackLastAssistantMessage(session);
    toolCalled = false;
    unsubTool = setupToolListener(session);
    unsubOnSession = opts.onSession?.(session) ?? undefined;
    opts.onSessionId?.(session.sessionId);
  };

  const sendUntilTimeout = async (promptOpts: MessageOptions): Promise<void> => {
    const racers: Promise<void>[] = [
      wrapper.sendAndWait(promptOpts, timeoutMs, handleSessionReady).then(() => undefined),
    ];
    if (opts.abortSignal) {
      racers.push(
        new Promise<never>((_, reject) => {
          const onAbort = () => reject(new Error('Auditor session aborted by client or timeout'));
          if (opts.abortSignal!.aborted) onAbort();
          else opts.abortSignal!.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }
    await Promise.race(racers);
  };

  await sendUntilTimeout({ prompt: initialPrompt } as MessageOptions);

  let lastAssistantText = tracker?.getText() ?? '';

  let attempt = 0;

  while (!toolCalled && attempt < maxRetries) {
    attempt++;
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    console.warn(
      `[runForcedToolTurnUntilTimeout] turn ended without ${toolNamesStr} being called ` +
      `(attempt ${attempt}/${maxRetries}); resuming session with restricted toolset...`
    );

    const exampleBlock = responseRequirements.toolCallExample
      ? `\n\nUse your tool-calling capability (a real function/tool call) -- not text in your message. Example of correctly-shaped arguments:\n\n${responseRequirements.toolCallExample}`
      : '';
    const nudge = lastAssistantText.trim()
      ? `You did not call any of: ${toolNamesStr}. Your last message was:\n"""\n${truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH)}\n"""\nYou must now call one of ${toolNamesStr} with your findings. Do not respond conversationally, do not ask clarifying questions, and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`
      : `You ended your turn without calling any of: ${toolNamesStr}. You must now call one of ${toolNamesStr} with your findings. Do not respond conversationally and do not call any other tool -- call one of ${toolNamesStr} now.${exampleBlock}`;

    restrictToTargetTools(wrapper, turnAvailableTools, targetTools);

    const promptOpts: { prompt: string; tool_choice?: unknown } = { prompt: nudge, tool_choice: undefined as any };
    if (opts.provider === 'openrouter') {
      promptOpts.tool_choice = { type: 'function', function: { name: targetTools[0] } };
    }

    await sendUntilTimeout(promptOpts as MessageOptions);

    lastAssistantText = tracker?.getText() || lastAssistantText;
  }

  unsubOnSession?.();

  if (!toolCalled) {
    const toolNamesStr = targetTools.map(t => `'${t}'`).join(' or ');
    const truncated = truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH);
    throw new Error(
      `Session ended without calling ${toolNamesStr} after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'}. ` +
      `Model's last message: ${truncated || '(no assistant text captured)'}`
    );
  }

  let finalResult = opts.getResult();
  if (toolCalled && (finalResult === null || finalResult === undefined)) {
    finalResult = (true as unknown) as T;
  }

  return { result: finalResult as T, session: wrapper.session as CopilotSession, lastAssistantText, toolCalled };
}
