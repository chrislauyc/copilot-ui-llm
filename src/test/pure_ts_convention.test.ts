import { describe, it, expect } from 'vitest';

// Issue #320: buildAuditorSessionSettingsPure and isAIStudio are the two
// reference cases for the *.pure.ts convention -- config/args in, plain
// value out, no closures, no I/O imports. These tests guard that the pure
// half stays pure in behavior (deterministic given its inputs) and that
// the declarative shape it returns has no handler functions on it.

import { buildAuditorSessionSettingsPure } from '../utils/auditorHelper.pure';
import { RUN_TERMINAL_DOCKER_TOOL } from '../config/tools';

describe('buildAuditorSessionSettingsPure (issue #320 reference case 1)', () => {
  const executionConfig = { model: 'mock-model', provider: undefined } as never;
  const tool = {
    function: {
      name: 'submit_task_result',
      description: 'Submit result',
      parameters: { type: 'object', properties: {} },
    },
  };

  it('returns a declarative shape with no handler functions', () => {
    const settings = buildAuditorSessionSettingsPure(executionConfig, 'system prompt', tool);
    expect(settings.submissionTool).not.toHaveProperty('handler');
    expect(settings.execTool).not.toHaveProperty('handler');
    expect(typeof settings.submissionTool.name).toBe('string');
  });

  it('includes both tool names in allowedToolNames', () => {
    const settings = buildAuditorSessionSettingsPure(executionConfig, 'system prompt', tool);
    expect(settings.allowedToolNames).toEqual(['submit_task_result', RUN_TERMINAL_DOCKER_TOOL.function.name]);
  });

  it('is deterministic: identical inputs produce identical output', () => {
    const a = buildAuditorSessionSettingsPure(executionConfig, 'same prompt', tool);
    const b = buildAuditorSessionSettingsPure(executionConfig, 'same prompt', tool);
    expect(a).toEqual(b);
  });

  it('embeds the system prompt into the assembled system message content', () => {
    const settings = buildAuditorSessionSettingsPure(executionConfig, 'UNIQUE_MARKER_XYZ', tool);
    expect(settings.systemMessage.mode).toBe('replace');
    expect(settings.systemMessage.content).toContain('UNIQUE_MARKER_XYZ');
  });
});

describe('isAIStudio (issue #320 reference case 2)', async () => {
  // Imported dynamically per-test so each test can freely mutate
  // process.env without module-load-time caching surprises.
  it('is a pure function of process.env with no I/O side effects', async () => {
    const { isAIStudio } = await import('../workspace/workspace.pure');
    const original = { ...process.env };
    try {
      process.env.AI_STUDIO = 'true';
      delete process.env.NODE_ENV;
      delete process.env.VITEST;
      expect(isAIStudio()).toBe(true);

      process.env.AI_STUDIO = 'false';
      process.env.NODE_ENV = 'production';
      delete process.env.VITEST;
      expect(isAIStudio()).toBe(false);
    } finally {
      process.env = original;
    }
  });
});
