/**
 * Simulates tool outputs for mocking command executions under UI override or bypassDocker modes.
 */
export async function simulateToolOutput(command: string): Promise<string> {
  const cmd = command.toLowerCase();
  
  // Short artificial latency to mirror realistic execution times
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Failure Trigger Edge-Cases
  if (cmd.includes('mock-warning') || cmd.includes('--trigger-warn')) {
    return "✓ 12 tests passed. (node:3022) Warning: MaxListenersExposed detected in background streams";
  }

  if (cmd.includes('--trigger-fail') || cmd.includes('mock-defect')) {
    if (cmd.includes('npm test') || cmd.includes('vitest') || cmd.includes('jest') || cmd.includes('runtests')) {
      return "FAIL: 1 test suite failed, 4 syntax assertions broken\nExpected true to be false\nAt src/simulator.test.tsx:23";
    }
    if (cmd.includes('npm run lint') || cmd.includes('eslint') || cmd.includes('runlint')) {
      return "FAIL: eslint detected unused variables in server.ts\n  Error: 'session' is declared but its value is never read";
    }
    return "FAIL: 1 test suite failed, 4 syntax assertions broken";
  }

  if (cmd.includes('npm test') || cmd.includes('vitest') || cmd.includes('jest') || cmd.includes('runtests')) {
    return `[Simulated Output]:\n> ${command}\n\n  PASS  src/test.spec.ts\n  PASS  src/utils.spec.ts\n\nTest Suites: 2 passed, 2 total\nTests:       14 passed, 14 total\nSnapshots:   0 total\nTime:        0.185 s\n✓ 0 vulnerabilities\n(node:1204) Pass: 14 tests completed successfully. Duration: 185ms`;
  }
  if (cmd.includes('npm run lint') || cmd.includes('eslint') || cmd.includes('runlint')) {
    return "[Simulated Output]:\n> " + command + "\n\n✓ No structural linting or style violations found.";
  }
  return `[Simulated Output Mode]: Command '${command}' executed cleanly under UI override boundaries.`;
}
