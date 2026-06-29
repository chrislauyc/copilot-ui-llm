import { getExecCommand } from '../workspace';

interface TestResult {
  file: string;
  success: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

const TEST_FILES = [
  'src/parser.test.ts',
  'src/filters.test.tsx',
  'src/gates.test.ts',
  'src/prompt.test.ts',
  'src/hooks.test.ts',
  'src/server_fix.test.ts',
  'src/timeline.test.tsx',
  'src/simulator.test.tsx',
  'src/inspector.test.tsx',
  'src/findings.test.ts',
  'src/test/integration.test.ts',
  'src/test/server.integration.test.ts'
];

async function runTestFile(file: string): Promise<TestResult> {
  const execCommand = getExecCommand();
  const start = Date.now();

  const result = await execCommand(`npx tsx ${file}`, AbortSignal.timeout(60_000));

  return {
    file,
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    durationMs: Date.now() - start,
    output: result.stdout + result.stderr,
  };
}

async function main() {
  console.log('\n======================================================');
  console.log('🧪 CONSOLIDATED TEST RUNNER HARNESS');
  console.log('Starting verification of all custom testing suites...');
  console.log('======================================================\n');

  const results: TestResult[] = [];

  for (const file of TEST_FILES) {
    console.log(`⏳ Running ${file}...`);
    const res = await runTestFile(file);
    results.push(res);

    if (res.success) {
      console.log(`\x1b[32m✔ PASSED\x1b[0m ${file} (${res.durationMs}ms)`);
    } else {
      console.log(`\x1b[31m✘ FAILED\x1b[0m ${file} (${res.durationMs}ms) with exit code ${res.exitCode}`);
      console.log('\n--- Test Failure Log Output Start ---');
      console.log(res.output);
      console.log('--- Test Failure Log Output End ---\n');
    }
  }

  console.log('\n======================================================');
  console.log('📊 CONSOLIDATED TEST SUMMARY');
  console.log('======================================================');

  let passedAll = true;
  for (const res of results) {
    const status = res.success ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`[ ${status} ] ${res.file.padEnd(28)} (${res.durationMs}ms)`);
    if (!res.success) {
      passedAll = false;
    }
  }

  console.log('======================================================');
  const passCount = results.filter(r => r.success).length;
  console.log(`Passed: ${passCount} / ${results.length}`);

  if (passedAll) {
    console.log('\n\x1b[32m✔ All component testing suites executed and passed successfully!\x1b[0m\n');
    process.exit(0);
  } else {
    console.log('\n\x1b[31m✘ Some verification tests encountered errors or failures.\x1b[0m\n');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unhandled fatal error in test runner:', err);
  process.exit(1);
});
