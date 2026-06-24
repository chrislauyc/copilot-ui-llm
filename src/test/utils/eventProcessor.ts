export interface ProcessState {
  isRunning: boolean;
  activeGate: string | null;
  retryCount: number;
  currentModel: string;
  lastResult?: any;
  hasFailureState?: boolean;
  hasErrorState?: boolean;
  hasWarningState?: boolean;
  status?: string;
  lastSequenceId?: number;
}

export function processEvents(initialState: ProcessState, events: any[]): ProcessState {
  let state = { ...initialState };

  events.forEach((ev) => {
    const data = ev.data || {};
    
    if (data.sequenceId !== undefined) {
      if (state.lastSequenceId !== undefined && data.sequenceId <= state.lastSequenceId) {
        return; // Discard out of order or older events
      }
      state.lastSequenceId = data.sequenceId;
    }
    
    if (data.stateSnapshot) {
      state = { ...state, ...data.stateSnapshot };
    }
  });

  return state;
}
