import os from 'os';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import { validateCwd } from './security/pathGuard';
import { CopilotClient, CopilotSession, PermissionRequestResult, SessionConfig, SdkProviderConfig, Tool, SessionEvent } from './copilotSdk/boundary';
import { handleGateLoop, handleGateRunPermission, handleGateStream, globalAutoApproveAll, setGlobalAutoApproveAll } from './orchestrator/gateLoop';

import {
  activeSessions,
  sseResToSessionId,
  sessionWritePromises,
  activeLocks,
  DEFAULT_WORKSPACE_DIR,
  DIAGNOSTIC_SCENARIOS,
  sensitiveValuesCache,
  setSensitiveValuesCache,
  resetSessionForNewRun,
  updateStateSnapshot,
  getOrCreateSession,
  getGlobalClient,
  resetGlobalClient,
  writeLog,
  LogLevel,
  initLogFile,
  getCodeState,
  runLlmAudit,
  lastRunLog,
} from './orchestrator/sessionState';

import type { CopilotCreateSessionOptions } from './orchestrator/sessionState';

/**
 * Orchestrator Server Runtime Exports
 * 
 * These exports define the public surface area for the Express application.
 * Re-exports from internal modules are centralized here to maintain clear layer boundaries
 * between the API handlers and the core orchestrator logic.
 */
export {
  activeSessions,
  sseResToSessionId,
  sessionWritePromises,
  activeLocks,
  DEFAULT_WORKSPACE_DIR,
  DIAGNOSTIC_SCENARIOS,
  sensitiveValuesCache,
  resetSessionForNewRun,
  updateStateSnapshot,
  getOrCreateSession,
  getGlobalClient,
  resetGlobalClient,
  writeLog,
  LogLevel,
  initLogFile,
  getCodeState,
  runLlmAudit,
  lastRunLog,
  handleGateRunPermission,
  globalAutoApproveAll,
  setGlobalAutoApproveAll,
};

export type { CopilotCreateSessionOptions };
import { DEFAULT_ROLES_CONFIG } from './config/models';
import { runGate, runTests, runLint, runWithTimeout } from './gates';
import { MODEL_TIERS, getNextTier, KNOWN_MODELS_CONFIG } from './config/models';
import { SessionRecord, StateSnapshot, CopilotEventData, Turn, getSequenceId } from './types/session';
import { ExecutionConfig, ProviderConfig } from './utils/providerRegistry';
import { formatContextNarrowingPrompt, formatEscalationPrompt, formatHumanEscalationPrompt, formatClarityCheckPrompt } from './utils/prompt';
import { makeDockerToolHandler } from './utils/toolHandlers';
import { RUN_TERMINAL_DOCKER_TOOL, submitAuditFindingsTool, COMPOSER_ROUTER_TOOL, AMBIGUITY_CHECK_TOOL } from './config/tools';
import { normalizeGates, TASK_TYPE_GATE_MAP, resolvePipeline } from './config/gates';
import { runSpecAudit } from './gates/specAuditor';
import { sanitizeSensitives } from './utils/sanitizers';
import { truncateOutput } from './utils/formatters';
import { initializeWorkspace, getGitSandbox, getExecCommand, getWorkspaceHostLocation, getWorkspaceRoot } from './workspace';
import { enforceWorkingMemoryTruncation, SlidingWindowCircularBuffer, clearCleanCache } from './utils/contextManager';
import { fetchStubbedTraceResponse } from './utils/traceRegistry';
import { appendEscalation, updateEscalationStatus, getEscalations, getPendingEscalation } from './utils/escalationStore';
import { createSseWriter } from './utils/sseWriter';
import { startSessionGarbageCollector } from './services/sessionGarbageCollector';

if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

let stopSessionGarbageCollector: (() => void) | null = null;


if (process.env.NODE_ENV !== 'test') {
  ['SIGINT', 'SIGTERM', 'uncaughtException'].forEach((signal) => {
    process.on(signal as NodeJS.Signals | 'uncaughtException', (err) => {
      if (signal === 'uncaughtException') {
        console.error('[SYSTEM] Uncaught Exception:', err);
      } else {
        console.log(`[SYSTEM] ${signal} received. Cleaning up...`);
      }
      stopSessionGarbageCollector?.();
      stopSessionGarbageCollector = null;
      process.exit(signal === 'uncaughtException' ? 1 : 0);
    });
  });
}

import https from 'https';
import { ProviderRegistry } from './utils/providerRegistry';
import { getAuditorExecutionConfig, executeAuditSession } from './utils/auditorHelper';


// Ensure the Copilot CLI path is explicitly set to work reliably in both dev and bundled production (CJS) modes
if (!process.env.COPILOT_CLI_PATH) {
  process.env.COPILOT_CLI_PATH = path.join(process.cwd(), 'node_modules', '@github', 'copilot', 'npm-loader.js');
}

const LOG_FILE = path.join('/tmp', 'debug_log.txt');


// Maps model identifiers to officially supported models in Google's OpenAI compatibility endpoint to avoid 400 bad request errors
export function mapOpenAIModel(rawModel: string): string {
  if (!rawModel) return MODEL_TIERS[0] || 'gemini-3.1-flash-lite';
  const cleaned = rawModel.replace('models/', '').trim();
  const matched = MODEL_TIERS.find(m => m === cleaned || m.includes(cleaned) || cleaned.includes(m));
  if (matched) return matched;
  if (DEFAULT_ROLES_CONFIG.planner.model === cleaned || DEFAULT_ROLES_CONFIG.planner.model.includes(cleaned)) {
    return DEFAULT_ROLES_CONFIG.planner.model;
  }
  if (DEFAULT_ROLES_CONFIG.auditor.model === cleaned || DEFAULT_ROLES_CONFIG.auditor.model.includes(cleaned)) {
    return DEFAULT_ROLES_CONFIG.auditor.model;
  }
  if (DEFAULT_ROLES_CONFIG.committer && (DEFAULT_ROLES_CONFIG.committer.model === cleaned || DEFAULT_ROLES_CONFIG.committer.model.includes(cleaned))) {
    return DEFAULT_ROLES_CONFIG.committer.model;
  }
  const matchedKnown = KNOWN_MODELS_CONFIG.find(m => m.model === cleaned || m.model.includes(cleaned) || cleaned.includes(m.model));
  if (matchedKnown) return matchedKnown.model;
  return MODEL_TIERS[0] || 'gemini-3.1-flash-lite';
}

import { getSession, saveSession, deleteSession, getAllSessions } from './db/sessionStore';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 Minute TTL

// Shared state helpers and orchestrator utilities are now imported from './orchestrator/sessionState'

async function runCommand(command: string, signal?: AbortSignal) {
  const execCommand = getExecCommand();
  return await execCommand(command, signal);
}

// runLlmAudit and sensitiveValuesCache are now managed inside './orchestrator/sessionState'
let envWatcher: fs.FSWatcher | null = null;
const envPath = path.join(process.cwd(), '.env');

function rebuildSensitiveValuesCache() {
  const newValues = new Set<string>();
  const SECRET_ENV_WHITELIST = ['GEMINI_API_KEY', 'COPILOT_JWT', 'COPILOT_CLIENT_SECRET', 'GITHUB_OAUTH_CLIENT_SECRET'];

  // Process env keys from the whitelist only
  for (const envKey of SECRET_ENV_WHITELIST) {
    const val = process.env[envKey];
    if (val && typeof val === 'string' && val.trim().length > 4 && val !== 'MY_GEMINI_API_KEY') {
      newValues.add(val.trim());
    }
  }

  // Process file but only keys present in our whitelist
  try {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const parts = trimmed.split('=');
          if (parts.length >= 2) {
            const key = parts[0]?.trim();
            if (key && SECRET_ENV_WHITELIST.includes(key)) {
              const val = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
              if (val && val.length > 4 && val !== 'MY_GEMINI_API_KEY') {
                newValues.add(val);
              }
            }
          }
        }
      }
    }
  } catch (e) {}

  setSensitiveValuesCache(newValues);
  writeLog(`[Sanitizer] Cache rebuilt/updated with ${newValues.size} secrets.`, LogLevel.INFO);
}

// Build at startup and setup watcher
rebuildSensitiveValuesCache();

function setupEnvWatcherWithBackoff(delay: number = 1000) {
  try {
    if (fs.existsSync(envPath)) {
      if (envWatcher) {
        try { envWatcher.close(); } catch (_) {}
      }
      envWatcher = fs.watch(envPath, (eventType) => {
        if (eventType === 'change') {
          rebuildSensitiveValuesCache();
        }
      });
      envWatcher.on('error', (err: Error) => {
        writeLog(`[Watcher] Env watcher encountered error: ${err?.message || String(err)}. Reconnecting with backoff...`, LogLevel.WARN);
        try { if (envWatcher) { envWatcher.close(); } } catch (_) {}
        envWatcher = null;
        const nextDelay = Math.min(delay * 2, 30000);
        setTimeout(() => setupEnvWatcherWithBackoff(nextDelay), delay);
      });
    } else {
      // Delay re-establishing watcher if file is missing (ENOENT) during deep cleaning
      const nextDelay = Math.min(delay * 2, 30000);
      setTimeout(() => setupEnvWatcherWithBackoff(nextDelay), delay);
    }
  } catch (err: unknown) {
    writeLog(`[Watcher] Exception establishing env watcher: ${err instanceof Error ? err.message : String(err)}. Retry in ${delay}ms`);
    const nextDelay = Math.min(delay * 2, 30000);
    setTimeout(() => setupEnvWatcherWithBackoff(nextDelay), delay);
  }
}

setupEnvWatcherWithBackoff();

/**
 * Prunes conversation history to prevent context window saturation while 
 * preserving original directive and the two most recent iterations using
 * exponential-decay working memory truncation on cumulative memory.
 */
function pruneConversationHistory(history: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>) {
  return enforceWorkingMemoryTruncation(history);
}

const { secureWrite, flushSseAndEnd } = createSseWriter({
  activeSessions,
  sseResToSessionId,
  writeLog,
});

stopSessionGarbageCollector = startSessionGarbageCollector({
  activeSessions,
  sessionWritePromises,
  sseResToSessionId,
  activeLocks,
  ttlMs: SESSION_TTL_MS,
  writeLog,
});


// Intercept stderr to capture subprocess crashes
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = function (
  chunk: string | Uint8Array,
  encoding?: BufferEncoding | ((err: Error | null | undefined) => void),
  callback?: (err: Error | null | undefined) => void
): boolean {
  const str = chunk.toString();
  if (str.trim()) {
    writeLog(`[STDERR] ${str.trim()}`);
  }
  
  if (typeof encoding === 'function') {
    return originalStderrWrite(chunk, encoding);
  }
  
  return originalStderrWrite(chunk, encoding, callback);
};

// Intercept console.log
const originalLog = console.log;
console.log = function(...args: unknown[]) {
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  
  const sanitizedMessage = sanitizeSensitives(message, sensitiveValuesCache || new Set());
  
  // Avoid logging our own level-prefixed logs back to writeLog to prevent recursion or redundancy
  if (!message.startsWith('[INFO]') && !message.startsWith('[WARN]') && !message.startsWith('[ERROR]') && !message.startsWith('[DEBUG]')) {
    writeLog(`[LOG] ${sanitizedMessage}`, LogLevel.DEBUG);
  }

  return originalLog.apply(console, [sanitizedMessage]);
};

function isStreamError(err: unknown): err is Error & { code?: string } {
  return err instanceof Error && typeof (err as unknown as Record<string, unknown>).code === 'string';
}

// Gracefully handle stream destruction crashes from underlying SDKs or third-party dependency libraries
process.on('uncaughtException', (err: Error) => {
  if (err && (
    (isStreamError(err) && err.code === 'ERR_STREAM_DESTROYED') || 
    err.message?.includes('stream was destroyed') || 
    err.message?.includes('write after end') ||
    err.message?.includes('Cannot call write')
  )) {
    writeLog(`[Gracefully swallowed background stream write error]: ${err.message}`);
    return;
  }
  writeLog(`[Unhandled Exception]: ${err?.stack || err}`);
});

process.on('unhandledRejection', (reason: unknown) => {
  const err = reason instanceof Error ? reason : null;
  const message = (err?.message || (typeof reason === 'string' ? reason : '')) as string;

  if (
    (isStreamError(reason) && reason.code === 'ERR_STREAM_DESTROYED') || 
    message.includes('stream was destroyed') || 
    message.includes('write after end') ||
    message.includes('Cannot call write')
  ) {
    writeLog(`[Gracefully swallowed background stream rejection error]: ${message}`);
    return;
  }
  writeLog(`[Unhandled Rejection]: ${reason instanceof Error ? reason.stack : reason}`);
});

export const app = express();

export { db } from './db/index';
export { appendEscalation, getPendingEscalation, getEscalations } from './utils/escalationStore';
const PORT = parseInt(process.env.PORT || '3000', 10);

// Global middleware to log all HTTP responses and errors
import { setupApiRoutes } from './routes/api';
setupApiRoutes(app);
