const { spawn } = require('child_process');
const fs = require('fs');

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
}, 45000);
