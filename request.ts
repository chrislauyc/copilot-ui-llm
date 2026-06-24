import fs from 'fs';

async function run() {
  const res = await fetch('http://localhost:3000/api/copilot/gate-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: 'test',
      gates: ['tests', 'lint'],
      maxRetries: 2,
      apiKey: 'dummy',
      model: 'gemini-3.1-flash-lite',
      cwd: '/workspace',
      sessionId: 'test-session',
      diagnosticScenario: 'clean_run'
    })
  });
  console.log(`STATUS: ${res.status}`);
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      console.log(decoder.decode(value, { stream: true }));
    }
  } else {
    console.log(await res.text());
  }
}

run();
