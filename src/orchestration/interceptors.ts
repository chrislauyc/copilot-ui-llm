import { writeLog, LogLevel } from './orchestrator/sessionState';

let isInterceptingConsole = false;

let originalStderrWrite: typeof process.stderr.write | null = null;
let originalLog: typeof console.log | null = null;
let originalWarn: typeof console.warn | null = null;
let originalError: typeof console.error | null = null;

export function serializeArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack || arg.message;
  }
  if (arg === null) {
    return 'null';
  }
  if (arg === undefined) {
    return 'undefined';
  }
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

export function installConsoleInterceptors() {
  if (originalStderrWrite) return; // Already installed

  // Intercept stderr to capture subprocess crashes
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err: Error | null | undefined) => void),
    callback?: (err: Error | null | undefined) => void
  ): boolean {
    const str = chunk.toString();
    if (str.trim() && !isInterceptingConsole) {
      writeLog(`[STDERR] ${str.trim()}`);
    }
    
    if (typeof encoding === 'function') {
      return originalStderrWrite!(chunk, encoding);
    }
    
    return originalStderrWrite!(chunk, encoding, callback);
  };

  // Intercept console.log
  originalLog = console.log;
  console.log = function(...args: unknown[]) {
    const message = args.map(serializeArg).join(' ');
    
    // Avoid logging our own level-prefixed logs back to writeLog to prevent recursion or redundancy
    if (!message.startsWith('[INFO]') && !message.startsWith('[WARN]') && !message.startsWith('[ERROR]') && !message.startsWith('[DEBUG]')) {
      writeLog(message, LogLevel.DEBUG);
    }
    return originalLog!.apply(console, [message]);
  };

  // Intercept console.warn
  originalWarn = console.warn;
  console.warn = function(...args: unknown[]) {
    const message = args.map(serializeArg).join(' ');
    
    if (!message.startsWith('[INFO]') && !message.startsWith('[WARN]') && !message.startsWith('[ERROR]') && !message.startsWith('[DEBUG]')) {
      writeLog(message, LogLevel.WARN);
    }
    
    const wasIntercepting = isInterceptingConsole;
    isInterceptingConsole = true;
    try {
      return originalWarn!.apply(console, [message]);
    } finally {
      isInterceptingConsole = wasIntercepting;
    }
  };

  // Intercept console.error
  originalError = console.error;
  console.error = function(...args: unknown[]) {
    const message = args.map(serializeArg).join(' ');
    
    if (!message.startsWith('[INFO]') && !message.startsWith('[WARN]') && !message.startsWith('[ERROR]') && !message.startsWith('[DEBUG]')) {
      writeLog(message, LogLevel.ERROR);
    }
    
    const wasIntercepting = isInterceptingConsole;
    isInterceptingConsole = true;
    try {
      return originalError!.apply(console, [message]);
    } finally {
      isInterceptingConsole = wasIntercepting;
    }
  };
}

export function restoreConsoleInterceptors() {
  if (originalStderrWrite) {
    process.stderr.write = originalStderrWrite;
    originalStderrWrite = null;
  }
  if (originalLog) {
    console.log = originalLog;
    originalLog = null;
  }
  if (originalWarn) {
    console.warn = originalWarn;
    originalWarn = null;
  }
  if (originalError) {
    console.error = originalError;
    originalError = null;
  }
}
