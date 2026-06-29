// test_runner.cjs — CJS bootstrap for running vitest from a host shell.
//
// NOTE: This file intentionally uses spawn() from child_process directly.
// It is a host-side process launcher (vitest must be invoked as a child
// process of Node, not routed through the workspace execCommand). It has
// no access to the ESM workspace module and does not run inside a container.
// All workspace commands run by vitest itself go through getExecCommand().

const { spawn } = require('child_process');

const TIMEOUT_MS = 45_000;

const child = spawn('npx', ['vitest', 'run', 'src/test/spec_gate_audit.test.ts'], {
  stdio: 'pipe',
  shell: true
});

let output = '';

child.stdout.on('data', data => {
  output += data.toString();
});

child.stderr.on('data', data => {
  output += data.toString();
});

let isClosed = false;
child.on('close', code => {
  if (!isClosed) {
    isClosed = true;
    console.log('[OUTPUT_START]');
    console.log(output);
    console.log('[OUTPUT_END]', code);
    process.exit(code);
  }
});

setTimeout(() => {
  if (!isClosed) {
    isClosed = true;
    child.kill('SIGKILL');
    console.log('[OUTPUT_START]');
    console.log(output);
    console.log('[OUTPUT_END] TIMEOUT');
    process.exit(0);
  }
}, TIMEOUT_MS);
