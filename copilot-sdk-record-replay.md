
**HOW TO USE THE ReplayingCapiProxy FOR GATE-LOOP TESTS**

---

**Architecture**

The proxy is a real HTTP server that sits between `CopilotClient` and the CAPI endpoint. It intercepts `/chat/completions` requests, matches them against YAML snapshots, and streams back stored responses. Tool calls are part of the YAML — the proxy replays the LLM's tool call request; your actual tool handler executes; the result goes back through the proxy for the next match.

Two modes:
- **Record** (no snapshot on disk): passes through to real CAPI, writes YAML on stop
- **Replay** (snapshot exists): serves from YAML, no network calls

---

**Setup — what to copy from the SDK**

Copy these files verbatim into your repo (e.g. `test/harness/`):

```
test/harness/replayingCapiProxy.ts   ← core proxy class
test/harness/capturingHttpProxy.ts   ← base class
test/harness/connectProxy.ts         ← HTTPS CONNECT tunnel + TLS intercept
test/harness/certUtils.ts            ← CA cert generation for TLS
test/harness/mockHandlers.ts         ← request routing
test/harness/server.ts               ← process entrypoint (spawn this)
test/harness/util.ts                 ← sleep, retry helpers
```

Dependencies needed in your `package.json`:
```json
"openai": "^6.17.0",
"node-forge": "^1.4.0",
"yaml": "^2.8.2",
"tsx": "^4.21.0"
```

---

**Starting the proxy in tests**

The proxy runs as a **child process** (not in-process). The SDK's `CapiProxy` wrapper handles this — copy `nodejs/test/e2e/harness/CapiProxy.ts` too. It spawns `server.ts` via `npx tsx server.ts`, reads the startup URL from stdout, then controls the proxy over HTTP.

```typescript
const proxy = new CapiProxy();
const proxyUrl = await proxy.start();

// Register fake auth token → user profile mapping
await proxy.setCopilotUserByToken("fake-token", {
  login: "test-user",
  copilot_plan: "individual_pro",
  endpoints: {
    api: proxyUrl,
    telemetry: "https://localhost:1/telemetry",
  },
  analytics_tracking_id: "test-tracking-id",
});
```

---

**Wiring CopilotClient to the proxy**

Point the client at the proxy URL via env vars. The proxy also spins up a CONNECT tunnel for HTTPS interception — use `getProxyEnv()` to get all required vars:

```typescript
const client = new CopilotClient({
  workingDirectory: workDir,
  gitHubToken: "fake-token",
  env: {
    ...process.env,
    ...proxy.getProxyEnv(),   // sets HTTP_PROXY, HTTPS_PROXY, NODE_EXTRA_CA_CERTS, etc.
    COPILOT_API_URL: proxyUrl,
  },
  logLevel: "error",
  connection: RuntimeConnection.forStdio({ path: process.env.COPILOT_CLI_PATH }),
});
```

---

**Pointing each test at its snapshot**

Before each test, POST `/config` to tell the proxy which YAML file to use:

```typescript
await proxy.updateConfig({
  filePath: "test/snapshots/gate_loop/single_retry.yaml",
  workDir,  // used for ${workdir} placeholder substitution
});
```

The proxy flushes any pending writes from the previous test and loads the new snapshot. In the SDK this is done in `beforeEach` via `sdkTestContext.ts`.

---

**YAML snapshot format**

The proxy matches on conversation prefix — each incoming `/chat/completions` request is checked against stored conversations; the first one where the request messages are a prefix of the stored messages returns the next assistant turn.

**Simple text response:**
```yaml
models:
  - claude-sonnet-4.5
conversations:
  - messages:
      - role: system
        content: ${system}        # placeholder — matches any system prompt
      - role: user
        content: Run the gate check.
      - role: assistant
        content: The gate check passed. All tests green.
```

**Tool call conversation (multi-turn):**
```yaml
models:
  - claude-sonnet-4.5
conversations:
  - messages:
      - role: system
        content: ${system}
      - role: user
        content: Run the gate check.
      - role: assistant
        tool_calls:
          - id: toolcall_0
            type: function
            function:
              name: run_gate
              arguments: '{"target":"tests","flags":[]}'
  - messages:
      - role: system
        content: ${system}
      - role: user
        content: Run the gate check.
      - role: assistant
        tool_calls:
          - id: toolcall_0
            type: function
            function:
              name: run_gate
              arguments: '{"target":"tests","flags":[]}'
      - role: tool
        tool_call_id: toolcall_0
        content: |-
          FAIL: 2 tests failed
          gate: failed
      - role: assistant
        content: The gate failed. 2 tests need fixing.
```

Key points about the format:
- Each `conversations` entry is one full conversation thread
- Multiple entries in the list = multiple round-trips within one test
- The proxy matches by prefix: first request matches entry[0] up to first assistant turn, second request matches entry[1] up to next assistant turn, etc.
- `${system}` and `${workdir}` are placeholders — normalized during both record and replay so path/prompt differences don't break matches
- Tool results in `role: tool` messages are also normalized via `toolResultNormalizers` (strip absolute paths, exit markers, etc.) — you can add custom normalizers via `proxy.addToolResultNormalizer(toolName, fn)`

---

**Generating snapshots (record mode)**

Delete the YAML file (or don't create it). Run the test with a real `GITHUB_TOKEN` and `COPILOT_CLI_PATH`. The proxy passes through to real CAPI, captures all exchanges, and writes the YAML on `proxy.stop()`. Commit the YAML. Subsequent runs replay without network.

In CI, set `GITHUB_ACTIONS=true` — the proxy will never write, only read. This prevents partial test runs from corrupting snapshot files.

---

**Teardown**

```typescript
afterAll(async () => {
  await client.stop();
  await proxy.stop();   // flushes writes if not in CI
});
```

---

**What this tests end-to-end**

With this setup your actual gate loop code runs unmodified. The proxy replays the LLM decisions (tool call or text response), your registered tool handlers execute against real inputs, results feed back through the normal SDK path. You're testing:
- Tool handler registration and dispatch
- `sendAndWait` round-trip behavior
- Retry/escalation logic triggered by real gate evaluation of tool outputs
- SSE event ordering and `sequenceId` correctness
- Session lifecycle (create → send → tool calls → disconnect)