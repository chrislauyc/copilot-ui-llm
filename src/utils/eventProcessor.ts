export interface SubtaskTrace {
  id: string;
  label: string;
  status: 'running' | 'success' | 'failed';
  errors?: string[];
  durationMs?: number;
}

export interface AgentTurn {
  turnIndex: number;
  goalLabel: string;
  status: 'idle' | 'processing' | 'success' | 'failed';
  subtasks: Record<string, SubtaskTrace>; // Kept flat here for efficient O(1) mutations
}

// Frontend stream reduction handler
export function processIncomingSSEEvent(
  currentTurns: AgentTurn[],
  newEvent: any
): AgentTurn[] {
  // Deep-clone to prevent upstream mutation check trippings
  const turns: AgentTurn[] = typeof structuredClone === 'function' 
    ? structuredClone(currentTurns) 
    : JSON.parse(JSON.stringify(currentTurns));

  switch (newEvent.type) {
    case 'turn.start':
      turns.push({
        turnIndex: newEvent.turnIndex,
        goalLabel: newEvent.label || newEvent.data?.label || '',
        status: 'processing',
        subtasks: {}
      });
      break;

    case 'subtask.start': {
      const activeTurn = turns.find(t => t.turnIndex === newEvent.turnIndex);
      if (activeTurn) {
        activeTurn.subtasks[newEvent.subtaskId] = {
          id: newEvent.subtaskId,
          label: newEvent.label || newEvent.data?.label || '',
          status: 'running'
        };
      }
      break;
    }

    case 'subtask.complete': {
      const targetTurn = turns.find(t => t.turnIndex === newEvent.turnIndex);
      if (targetTurn) {
        const subtask = targetTurn.subtasks[newEvent.subtaskId];
        if (subtask) {
          subtask.status = newEvent.success ? 'success' : 'failed';
          if (newEvent.errors) {
            subtask.errors = newEvent.errors;
          }
        }
      }
      break;
    }

    case 'turn.complete': {
      const compTurn = turns.find(t => t.turnIndex === newEvent.turnIndex);
      if (compTurn) {
        compTurn.status = newEvent.success ? 'success' : 'failed';
      }
      break;
    }
  }

  return turns;
}
