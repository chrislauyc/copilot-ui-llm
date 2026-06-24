import { spawn } from 'child_process';

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
  const start = Date.now();
  return new Promise((resolve) => {
    // Spawns tsx as a separate subprocess to execute the test file
    const child = spawn('npx', ['tsx', file], {
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    let output = '';
    child.stdout?.on('data', (data) => {
      output += data.toString();
    });
    child.stderr?.on('data', (data) => {
      output += data.toString();
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - start;
      resolve({
        file,
        success: code === 0,
        exitCode: code,
        durationMs,
        output
      });
    });
  });
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
      // Log the output of failed tests to help diagnose issues
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
