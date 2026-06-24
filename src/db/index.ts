import Database from 'better-sqlite3';

export const isTestMode = process.env.NODE_ENV === 'test' || process.env.DIAGNOSTIC_MODE === 'true';
export const db = new Database(isTestMode ? 'app-test.db' : 'app.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sessionId TEXT PRIMARY KEY,
    currentModel TEXT,
    cwd TEXT,
    lastUsedAt INTEGER,
    currentTierIndex INTEGER,
    planVersions TEXT,
    totalInputTokens INTEGER,
    totalOutputTokens INTEGER,
    eventSequenceCounter INTEGER,
    stateSnapshot TEXT,
    conversationHistory TEXT,
    turns TEXT,
    diagnosticTrail TEXT
  );

  CREATE TABLE IF NOT EXISTS escalations (
    id TEXT PRIMARY KEY,
    sessionId TEXT,
    escalatedAt INTEGER,
    summary TEXT,
    failedGate TEXT,
    failedGateFeedback TEXT,
    retryHistory TEXT,
    status TEXT,
    stateSnapshot TEXT,
    conversationHistory TEXT,
    turns TEXT,
    cwd TEXT,
    currentModel TEXT
  );
`);
