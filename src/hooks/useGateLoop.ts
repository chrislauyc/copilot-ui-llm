import { useState, useCallback, useRef } from 'react';
import { ModelTier, DEFAULT_ROLES_CONFIG, MODEL_TIERS } from '../config/models';
import { CopilotEvent } from '../mockEvents';
import { deriveEventMeta } from '../parser';

export interface GateLoopConfig {
  readonly prompt: string;
  readonly gates: ReadonlyArray<'tests' | 'lint' | 'audit'>;
  readonly maxRetries: number;
  readonly sessionId: string;
  readonly apiKey: string;
  readonly model: string;
  readonly cwd: string;
  readonly diagnosticScenario?: string;
  readonly replayTraceId?: string;
  readonly simulateBackpressureDelayMs?: number;
  readonly setScenarioTurns?: (scenarioId: string, turns: ReadonlyArray<unknown>, events: ReadonlyArray<CopilotEvent>) => void;
}

export function useGateLoop(
  appendEventToScenario: (scenarioId: string, copilotEvent: CopilotEvent) => void,
  setScenarioEvents?: (scenarioId: string, events: CopilotEvent[]) => void,
  setScenarioTurns?: (scenarioId: string, turns: any[], events: CopilotEvent[]) => void
) {
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'shutdown' | 'error'>('idle');
  const [currentTier, setCurrentTier] = useState<ModelTier>(DEFAULT_ROLES_CONFIG.executorTiers?.[0]?.model || 'gemini-3.1-flash-lite');
  const [retryCount, setRetryCount] = useState(0);
  const [activeGate, setActiveGate] = useState<'tests' | 'lint' | 'audit' | null>(null);
  const [awaitingHuman, setAwaitingHuman] = useState(false);
  const [activeOutput, setActiveOutput] = useState<string>('');
  const [activeReplayTraceId, setActiveReplayTraceId] = useState<string | null>(null);
  
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const completedRef = useRef(false);
  const clientLogRef = useRef<string[]>([]);

  const getClientLog = useCallback(() => clientLogRef.current, []);

  const logClient = useCallback((msg: string) => {
    const timestamp = new Date().toISOString();
    const formatted = `[Client] [${timestamp}] ${msg}`;
    clientLogRef.current.push(formatted);
    if (clientLogRef.current.length > 500) clientLogRef.current.shift();
    // Silent background push to shared server logs
    fetch('/api/diagnostics/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: formatted })
    }).catch(() => {});
  }, []);

  const executeStream = async (endpoint: string, payload: any, sessionId: string, setScenarioTurnsCb?: any) => {
    // Abort any existing in-flight run for this hook instance
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    let hydrationSettled = !((setScenarioEvents || setScenarioTurns) && sessionId);
    let pendingEventsQueue: any[] = [];
    let minValidSeqIdFromSnapshot = 0;

    const processLiveEvent = (data: any) => {
      // Update active stream log line for Ambient Status Strip
      if (data.type === 'assistant.message_delta') {
        if (data.data?.deltaContent) {
          setActiveOutput(data.data.deltaContent);
        }
      } else if (data.type === 'tool.execution_start') {
        setActiveOutput(`Running ${data.data?.toolName || 'tool'}...`);
      } else if (data.type === 'tool.result' || data.type === 'tool.execution_complete') {
        const out = data.data?.stdout || data.data?.stderr || '';
        if (out) {
          const lastLine = out.split('\n').map((l: string) => l.trim()).filter(Boolean).pop();
          if (lastLine) setActiveOutput(lastLine);
        }
      } else if (data.type === 'gate.start') {
        setActiveOutput(`Checking Guard: ${data.data?.gateName || ''}...`);
      } else if (data.type === 'gate.result') {
        setActiveOutput(`Guard ${data.data?.gateName || ''} resolved: ${data.data?.pass ? 'PASSED' : 'FAILED'}`);
      } else if (data.type === 'assistant.streaming_delta') {
        if (data.data?.totalResponseSizeBytes) {
          setActiveOutput(`Streaming response: ${data.data.totalResponseSizeBytes} bytes`);
        }
      }

      // Handle specific events
      if (data.type === 'gate.start') {
        if (data.data?.gateName) {
          const mappedGate = 
            data.data.gateName === 'runTests' ? 'tests' :
            data.data.gateName === 'runLint' ? 'lint' :
            data.data.gateName === 'runAudit' ? 'audit' : null;
          setActiveGate(mappedGate);
        }
      } else if (data.type === 'loop.escalate_human') {
        setAwaitingHuman(true);
        setActiveGate(null);
      } else if (data.type === 'loop.retry') {
        if (data.data?.retryCount !== undefined) {
          setRetryCount(data.data.retryCount);
        }
        if (data.data?.nextModel) {
          setCurrentTier(data.data.nextModel);
        }
        setActiveGate(null);
      } else if (data.type === 'gate.result') {
        if (data.data?.retryCount !== undefined) {
          setRetryCount(data.data.retryCount);
        }
        setAwaitingHuman(false);
        setActiveGate(null);
      } else if (data.type === 'loop.clarity_check_failed') {
        setIsRunning(false);
        setStatus('error');
        setActiveGate(null);
        completedRef.current = true;
      } else if (data.type === 'loop.error') {
        setIsRunning(false);
        setStatus('error');
        setActiveGate(null);
        completedRef.current = true;
      } else if (data.type === 'loop.complete' || data.type === 'session.idle' || data.type === 'session.shutdown') {
        setIsRunning(false);
        setStatus(data.type === 'loop.complete' ? 'complete' : data.type === 'session.idle' ? 'idle' : 'shutdown');
        setActiveGate(null);
        completedRef.current = true;
      }
      
      const { category, title } = deriveEventMeta(data.type || 'system.unknown', data.data);
      const copilotEvent: CopilotEvent = {
        sessionEvent: {
          id: data.id || `evt-${Math.random().toString(36).substring(7)}`,
          timestamp: data.timestamp || new Date().toISOString(),
          type: data.type || 'system.unknown',
          data: data.data || {}
        } as any,
        title,
        category
      };
      
      logClient(`[HOOK] appendEventToScenario called: scenarioId=${sessionId} type=${data.type}`);
      appendEventToScenario(sessionId, copilotEvent);
    };

    // T2: Connection drop hydration catch-up logic
    const hydrationPromise = (async () => {
      if (!hydrationSettled) {
        try {
          logClient(`Checking active execution footprint for session: ${sessionId}`);
          const histRes = await fetch(`/api/copilot/session/${sessionId}/history`, {
            signal: abortControllerRef.current!.signal
          });
          if (histRes.ok) {
            const histPayload = await histRes.json();
            if (histPayload && histPayload.turns && Array.isArray(histPayload.turns) && histPayload.turns.length > 0) {
              logClient(`Active execution footprint detected. Hydrating ${histPayload.turns.length} turns from history.`);
              
              // Map turns and flatten events for backward compatibility
              const allFlattenedEvents: CopilotEvent[] = [];
              const mappedTurns = histPayload.turns.map((turn: any) => {
                const hydratedTurnEvents: CopilotEvent[] = (turn.events || [])
                  .filter((item: any) => item && typeof item === 'object' && item.type)
                  .map((data: any) => {
                    const { category, title } = deriveEventMeta(data.type, data.data);
                    const ce = {
                      sessionEvent: {
                        id: data.id || `evt-${Math.random().toString(36).substring(7)}`,
                        timestamp: data.timestamp || new Date().toISOString(),
                        type: data.type,
                        data: data.data || {}
                      } as any,
                      title,
                      category
                    };
                    allFlattenedEvents.push(ce);
                    return ce;
                  });
                  return { ...turn, events: hydratedTurnEvents };
              });
              
              const turnsSetter = setScenarioTurnsCb || setScenarioTurns;
              turnsSetter?.(sessionId, mappedTurns, allFlattenedEvents);
              logClient(`Hydration complete. React state array atomic-swapped.`);
            }

            if (histPayload && histPayload.stateSnapshot) {
              const snap = histPayload.stateSnapshot;
              if (snap.minValidSequenceId !== undefined) {
                minValidSeqIdFromSnapshot = snap.minValidSequenceId;
              }
              setIsRunning(snap.isRunning);
              setRetryCount(snap.retryCount || 0);
              setCurrentTier(snap.currentTier || 'gemini-3.1-flash-lite');
              setAwaitingHuman(!!snap.awaitingHuman);
              if (snap.activeGate) {
                const mappedGate = snap.activeGate === 'runTests' ? 'tests' :
                                   snap.activeGate === 'runLint' ? 'lint' :
                                   snap.activeGate === 'runAudit' ? 'audit' : null;
                setActiveGate(mappedGate as any);
              } else {
                setActiveGate(null);
              }
              if (snap.hasFailureState) {
                setStatus('error');
              } else if (!snap.isRunning) {
                setStatus('complete');
              } else {
                setStatus('running');
              }
              logClient(`State Hydration complete from stateSnapshot. minValidSequenceId = ${minValidSeqIdFromSnapshot}`);
            }
          }
        } catch (err: any) {
          if (err.name !== 'AbortError') {
            logClient(`Skipping history hydration: ${err.message || err}`);
          }
        }
      }

      hydrationSettled = true;
      if (pendingEventsQueue.length > 0) {
        let eventsToFlush = pendingEventsQueue;
        if (minValidSeqIdFromSnapshot > 0) {
          eventsToFlush = pendingEventsQueue.filter((ev: any) => {
            const seq = ev?.sequenceId ?? ev?.data?.sequenceId;
            return seq === undefined || seq >= minValidSeqIdFromSnapshot;
          });
        }
        logClient(`Flushing ${eventsToFlush.length} queued live events post-hydration.`);
        eventsToFlush.forEach(processLiveEvent);
        pendingEventsQueue = [];
      }
    })();
    
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: abortControllerRef.current.signal
      });

      if (!response.ok) {
        let msg = `HTTP ${response.status}`;
        try {
          const body = await response.json();
          msg += ` - ${body.error || body.message || 'Unknown Error'}`;
        } catch (_) {
           msg += ` - ${response.statusText}`;
        }
        throw new Error(msg);
      }
      
      if (!response.body) throw new Error('No response body');
      
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let loopErrorMessage = '';
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6));
            logClient(`received event: type="${data.type || 'unknown'}" dataKeys=${Object.keys(data.data || {}).join(',') || 'none'}`);
            
            if (data.type === 'loop.error') {
              loopErrorMessage = data.data?.message || 'Gate loop encountered an error.';
            }

            if (!hydrationSettled) {
               pendingEventsQueue.push(data);
               logClient(`Hydration active. Event queued.`);
            } else {
               processLiveEvent(data);
            }
          }
        }
      }
      
      if (loopErrorMessage) {
        throw new Error(loopErrorMessage);
      }
    } catch (err: any) {
      logClient(`Error in streamEndpoint hook: ${err.message || err}`);
      console.error(err);
      if (err.name !== 'AbortError') throw err;
    } finally {
      setIsRunning(false);
      setActiveReplayTraceId(null);
      if (!completedRef.current) {
        setStatus('shutdown');
      }
      setActiveGate(null);
      logClient(`Finished streamEndpoint. Status set to: ${completedRef.current ? 'completed' : 'shutdown'}`);
    }
  };

  const runWithGates = useCallback(async (config: GateLoopConfig) => {
    logClient(`Starting gate loop run. config: ${JSON.stringify({ ...config, apiKey: config.apiKey ? 'REDACTED' : 'none' })}`);
    setIsRunning(true);
    setStatus('running');
    setRetryCount(0);
    setAwaitingHuman(false);
    setActiveGate(null);
    completedRef.current = false;
    setActiveReplayTraceId(config.replayTraceId || null);
    setCurrentTier((config.model as ModelTier) || DEFAULT_ROLES_CONFIG.executorTiers?.[0]?.model || 'gemini-3.1-flash-lite');
    activeSessionIdRef.current = config.sessionId;
    
    await executeStream('/api/copilot/gate-run', config, config.sessionId, config.setScenarioTurns);
  }, [appendEventToScenario, logClient]);

  const resumeAsHuman = useCallback((input: string) => {
    if (!activeSessionIdRef.current) return Promise.reject(new Error('No active session ID'));
    logClient(`Sending human feedback: "${input}"`);
    
    setIsRunning(true);
    setStatus('running');
    setAwaitingHuman(false);
    completedRef.current = false;
    setActiveReplayTraceId(null);
    
    return executeStream('/api/copilot/gate-resume', { sessionId: activeSessionIdRef.current, input }, activeSessionIdRef.current);
  }, [logClient]);

    return {
    runWithGates,
    isRunning,
    status,
    currentTier,
    retryCount,
    activeGate,
    awaitingHuman,
    resumeAsHuman,
    getClientLog,
    activeOutput,
    activeReplayTraceId,
    availableTiers: MODEL_TIERS
  };
}
