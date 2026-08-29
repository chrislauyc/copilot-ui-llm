export const SIMULATOR_SSE_EVENTS = [
    { type: 'gate.start', data: { gateName: 'runTests', stateSnapshot: { activeGate: 'runTests', isRunning: true } } },
    { type: 'gate.result', data: { gateName: 'runTests', pass: true, feedback: '10 tests passed', durationMs: 420, stateSnapshot: { activeGate: null, hasFailureState: false, isRunning: true, lastResult: { success: true, output: '10 tests passed' } } } },
    { type: 'loop.retry', data: { retryCount: 1, nextModel: 'gemini-3.5-flash', durationMs: 120, stateSnapshot: { retryCount: 1, currentTier: 'gemini-3.5-flash', currentModel: 'gemini-3.5-flash', isRunning: true } } },
    { type: 'loop.complete', data: { success: true, feedback: 'Validation pipeline successful.', stateSnapshot: { isRunning: false, activeGate: null, status: 'complete' } } },
    { type: 'session.idle', data: { stateSnapshot: { isRunning: false, status: 'idle' } } }
];

export const FAILED_SIMULATOR_SSE_EVENTS = [
    { type: 'gate.start', data: { gateName: 'runTests', stateSnapshot: { activeGate: 'runTests', isRunning: true } } },
    { type: 'gate.result', data: { gateName: 'runTests', pass: false, feedback: 'FAIL: 1 test suite failed, 4 syntax assertions broken', durationMs: 300, stateSnapshot: { activeGate: null, hasFailureState: true, isRunning: true, lastResult: { success: false, output: 'FAIL: 1 test suite failed, 4 syntax assertions broken' } } } },
    { type: 'session.idle', data: { stateSnapshot: { isRunning: false, hasFailureState: true, status: 'idle' } } }
];

export const FAILED_TIMELINE_SSE_EVENTS = [
    { type: 'gate.start', data: { gateName: 'runTests', stateSnapshot: { activeGate: 'runTests', isRunning: true } } },
    { type: 'gate.result', data: { gateName: 'runTests', pass: false, output: 'FAIL: Syntax error', stateSnapshot: { activeGate: null, hasFailureState: true, isRunning: true, lastResult: { success: false, output: 'FAIL: Syntax error' } } } },
    { type: 'session.idle', data: { stateSnapshot: { isRunning: false, hasFailureState: true, status: 'idle' } } }
];

export const TIMELINE_SSE_EVENTS = [
    { type: 'gate.start', data: { gateName: 'runTests', stateSnapshot: { activeGate: 'runTests', isRunning: true } } },
    { type: 'gate.result', data: { gateName: 'runTests', pass: true, durationMs: 420, stateSnapshot: { activeGate: null, hasFailureState: false, isRunning: true, lastResult: { success: true, output: '' } } } },
    { type: 'loop.retry', data: { retryCount: 1, nextModel: 'gemini-3.5-flash', stateSnapshot: { retryCount: 1, currentTier: 'gemini-3.5-flash', currentModel: 'gemini-3.5-flash', isRunning: true } } },
    { type: 'session.idle', data: { stateSnapshot: { isRunning: false, status: 'idle' } } }
];

export const ERROR_SIMULATOR_SSE_EVENTS = [
    { type: 'gate.start', data: { gateName: 'runTests', stateSnapshot: { activeGate: 'runTests', isRunning: true } } },
    { type: 'loop.error', data: { message: 'Fatal pipeline escalation error', stateSnapshot: { isRunning: false, hasErrorState: true, status: 'error' } } }
];

export const ERROR_TIMELINE_SSE_EVENTS = [
    { type: 'gate.start', data: { gateName: 'runTests', stateSnapshot: { activeGate: 'runTests', isRunning: true } } },
    { type: 'loop.error', data: { message: 'Generic stream crash', stateSnapshot: { isRunning: false, hasErrorState: true, status: 'error' } } }
];

export const WARNING_TIMELINE_SSE_EVENTS = [
    { type: 'gate.start', data: { gateName: 'runTests', stateSnapshot: { activeGate: 'runTests', isRunning: true } } },
    { type: 'gate.result', data: { gateName: 'runTests', pass: true, feedback: '✓ 12 tests passed. (node:3022) Warning: MaxListenersExposed detected in background streams', stateSnapshot: { activeGate: null, hasWarningState: true, isRunning: true } } },
    { type: 'session.idle', data: { stateSnapshot: { isRunning: false } } }
];
