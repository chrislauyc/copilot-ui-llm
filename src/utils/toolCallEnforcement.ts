import { CopilotClient, CopilotSession, SdkProviderConfig, SessionConfig, ExtendedMessageOptions } from '@github/copilot-sdk';

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

export async function sendAndWaitWithAbort(
  session: CopilotSession,
  prompt: ExtendedMessageOptions,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (!abortSignal) {
    await session.sendAndWait(prompt, timeoutMs);
    return;
  }
  await Promise.race([
    session.sendAndWait(prompt, timeoutMs),
    new Promise<never>((_, reject) => {
      const onAbort = () => reject(new Error('Auditor session aborted by client or timeout'));
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    })
  ]);
}

export interface ForcedToolTurnOptions<T> {
  client: CopilotClient;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  getResult: () => T | null;
  tools?: any[]; // CopilotSDK Tool array
  responseRequirements?: { toolCallExample?: string };
}

export async function runForcedToolTurn<T>(
  session: CopilotSession,
  executionConfig: { provider?: string },
  toolName: string,
  initialPrompt: string,
  opts: ForcedToolTurnOptions<T>
): Promise<{ result: T; sessionId: string; lastAssistantText: string }> {
  let currentSession = session;
  let currentSessionId = session.sessionId;
  const timeoutMs = opts.timeoutMs ?? 300000;
  const maxRetries = opts.maxRetries ?? 2;
  const responseRequirements = opts.responseRequirements ?? {};
  
  let toolCalled = false;
  let tracker = trackLastAssistantMessage(currentSession);
  
  const setupToolListener = (s: CopilotSession) => {
    const unsub = s.on((event: unknown) => {
      const ev = event as Record<string, unknown>;
      if (ev.type === 'tool.user_requested' && (ev.data as any)?.toolName === toolName) {
        toolCalled = true;
      }
    });
    return unsub;
  };
  
  let unsubTool = setupToolListener(currentSession);
  
  await sendAndWaitWithAbort(currentSession, { prompt: initialPrompt }, timeoutMs, opts.abortSignal);
  
  let lastAssistantText = tracker.getText();
  tracker.unsubscribe();
  unsubTool();
  
  let result = opts.getResult();
  if (toolCalled && result === null) {
    result = true as unknown as T; // Fallback if getResult doesn't work across sessions
  }
  
  let attempt = 0;
  
  while (result === null && attempt < maxRetries) {
    attempt++;
    console.warn(
      `[runForcedToolTurn] turn ended without '${toolName}' being called ` +
      `(attempt ${attempt}/${maxRetries}); resuming session with restricted toolset...`
    );
    
    const exampleBlock = responseRequirements.toolCallExample
      ? `\n\nUse your tool-calling capability (a real function/tool call) -- not text in your message. Example of correctly-shaped arguments:\n\n${responseRequirements.toolCallExample}`
      : '';
    const nudge = lastAssistantText.trim()
      ? `You did not call '${toolName}'. Your last message was:\n"""\n${truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH)}\n"""\nYou must now call '${toolName}' with your findings. Do not respond conversationally, do not ask clarifying questions, and do not call any other tool -- call '${toolName}' now.${exampleBlock}`
      : `You ended your turn without calling '${toolName}'. You must now call '${toolName}' with your findings. Do not respond conversationally and do not call any other tool -- call '${toolName}' now.${exampleBlock}`;
      
    const resumeConfig = {
      availableTools: [toolName],
      tools: opts.tools,
      ...(executionConfig.provider ? { provider: executionConfig.provider as SdkProviderConfig } : {}),
    };
    
    currentSession = await opts.client.resumeSession(currentSessionId, resumeConfig);
    currentSessionId = currentSession.sessionId;
    
    tracker = trackLastAssistantMessage(currentSession);
    toolCalled = false;
    unsubTool = setupToolListener(currentSession);
    
    const promptOpts = { prompt: nudge, tool_choice: undefined as any };
    if (executionConfig.provider === 'openrouter') {
      promptOpts.tool_choice = { type: 'function', function: { name: toolName } };
    }
    
    await sendAndWaitWithAbort(currentSession, promptOpts, timeoutMs, opts.abortSignal);
    
    lastAssistantText = tracker.getText() || lastAssistantText;
    tracker.unsubscribe();
    unsubTool();
    result = opts.getResult();
    if (toolCalled && result === null) {
      result = true as unknown as T;
    }
  }
  
  if (result === null) {
    const truncated = truncate(lastAssistantText.trim(), LAST_MESSAGE_TRUNCATE_LENGTH);
    throw new Error(
      `Session ended without calling '${toolName}' after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'}. ` +
      `Model's last message: ${truncated || '(no assistant text captured)'}`
    );
  }
  
  return { result, sessionId: currentSessionId, lastAssistantText };
}
