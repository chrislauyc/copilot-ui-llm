/**
 * Centralized gate mapping and normalization.
 * Standardizes user-friendly aliases (e.g., 'tests') to internal gate identifiers (e.g., 'runTests').
 */

export interface TaskTemplate {
  name: string;
  description: string;
  defaultGates: {
    tests: boolean;
    lint: boolean;
    audit: boolean;
  };
}

export const GATE_MAPPING: Record<string, string> = {
  'tests': 'runTests',
  'test': 'runTests',
  'lint': 'runLint',
  'linter': 'runLint',
  'audit': 'runAudit',
  'sec': 'runAudit',
};

/**
 * Mapping of task categories to specific ordered gate sequences, retry ceilings, and escalation paths.
 * Prepares the workspace for dynamic Composer LLMs selection.
 */
export const TASK_TYPE_GATE_MAP: Record<string, { name: string, description?: string, gates: string[], maxRetries: number, modelEscalation: boolean }> = {
  'refactor': { name: 'Refactor Codebase', gates: ['runLint', 'runTests'], maxRetries: 3, modelEscalation: true },
  'feature': { name: 'New Feature Logic', gates: ['runLint', 'runTests', 'runAudit'], maxRetries: 3, modelEscalation: true },
  'test-only': { name: 'Unit/Regress Test Only', gates: ['runTests'], maxRetries: 2, modelEscalation: false },
  'style-only': { name: 'Lint / Formatting Only', gates: ['runLint'], maxRetries: 1, modelEscalation: false },
  'audit-only': { name: 'Security / Audit Only', gates: ['runAudit'], maxRetries: 2, modelEscalation: true },
  'backend': { 
    name: 'Backend API / Service', 
    description: 'Node.js/Express service requiring test coverage, linting, and security audits.',
    gates: ['runTests', 'runLint', 'runAudit'], 
    maxRetries: 3, 
    modelEscalation: true 
  },
  'frontend': { 
    name: 'Frontend UI Component', 
    description: 'React/TypeScript components requiring visual linting and structural audits.',
    gates: ['runLint', 'runAudit'], 
    maxRetries: 3, 
    modelEscalation: true 
  },
  'documentation': { 
    name: 'Technical Documentation', 
    description: 'Markdown/README updates requiring primarily a structural audit gate.',
    gates: ['runAudit'], 
    maxRetries: 2, 
    modelEscalation: false 
  },
  'experimental': { 
    name: 'Experimental Spike', 
    description: 'Rapid iterations with no mandatory validation gates enforced.',
    gates: [], 
    maxRetries: 2, 
    modelEscalation: false 
  }
};

/**
 * Resolves a task type to its required gate identifiers.
 */
export function resolvePipeline(taskType: string): string[] {
  return TASK_TYPE_GATE_MAP[taskType]?.gates || [];
}

/**
 * Normalizes a gate name to its canonical internal identifier.
 * If no mapping exists, returns the original name.
 */
export function normalizeGateName(name: string): string {
  if (!name) return '';
  const normalized = name.toLowerCase().trim();
  return GATE_MAPPING[normalized] || name;
}

/**
 * Normalizes an array of gate names. Also supports expanding task categories if present.
 */
export function normalizeGates(gates: string[]): string[] {
  const finalGates: string[] = [];
  
  for (const g of gates) {
    if (TASK_TYPE_GATE_MAP[g]) {
      finalGates.push(...TASK_TYPE_GATE_MAP[g].gates);
    } else {
      finalGates.push(normalizeGateName(g));
    }
  }

  return Array.from(new Set(finalGates)).filter(g => !!g);
}
