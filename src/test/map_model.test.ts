import { describe, it } from 'vitest';
import assert from 'node:assert';
import { mapOpenAIModel } from '../../server';

describe('mapOpenAIModel Helper Unit Tests', () => {
  it('returns default tier when rawModel is empty or null', () => {
    const res = mapOpenAIModel('');
    assert.strictEqual(res, 'gemini-3.1-flash-lite', 'Should fall back to default gemini-3.1-flash-lite');
  });

  it('correctly strips models/ prefix and returns matching official model', () => {
    const res = mapOpenAIModel('models/gemini-3.1-flash-lite');
    assert.strictEqual(res, 'gemini-3.1-flash-lite', 'Should strip models/ prefix and match correctly');
  });

  it('correctly identifies models that match a substring within the MODEL_TIERS list', () => {
    const res = mapOpenAIModel('pro-preview');
    assert.strictEqual(res, 'gemini-3.1-pro-preview', 'Should map pro-preview to gemini-3.1-pro-preview');
  });

  it('falls back to planner model or default if the model is completely unrecognized', () => {
    // Pass completely invalid model name
    const res = mapOpenAIModel('non-existent-hyper-intelligence-model');
    // It should fall back to default 'gemini-3.1-flash-lite'
    assert.strictEqual(res, 'gemini-3.1-flash-lite', 'Should fall back to default gemini-3.1-flash-lite');
  });
});
