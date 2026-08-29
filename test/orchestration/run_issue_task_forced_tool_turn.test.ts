import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('scripts/run-issue-task.ts', () => {
  const source = readFileSync(
    path.resolve(__dirname, '../../scripts/run-issue-task.ts'),
    'utf-8'
  );

  it('drives the agent turn through runForcedToolTurnUntilTimeout, not a bare sendAndWait', () => {
    expect(source).toContain('runForcedToolTurnUntilTimeout');
    expect(source).not.toMatch(/session\.sendAndWait/);
  });

  it('imports runForcedToolTurnUntilTimeout from the shared enforcement util', () => {
    expect(source).toMatch(
      /import\s*\{\s*runForcedToolTurnUntilTimeout\s*\}\s*from\s*['"]\.\.\/src\/agentCore\/toolCallEnforcement['"]/
    );
  });

  it('forces the same RUN_GH_COMMAND_TOOL_NAME tool that was previously only advertised, not enforced', () => {
    // `runForcedToolTurnUntilTimeout` now takes a `SessionWrapper` instead of
    // a raw `session, executionConfig` pair (issue #359 / #346's remaining
    // scope) -- the wrapper owns session creation/resume, so the call site
    // passes `wrapper` in that slot instead.
    expect(source).toMatch(/runForcedToolTurnUntilTimeout\(\s*wrapper,\s*RUN_GH_COMMAND_TOOL_NAME/);
  });
});
