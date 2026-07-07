process.cwd = () => "/tmp/copilot-ui-llm";
process.env.CONTAINER_NAME = process.env.CONTAINER_NAME || "mock-container";
import fs from "node:fs";
import path from "node:path";

const possiblePaths = [
  "/tmp/copilot-ui-llm/node_modules/@github/copilot/npm-loader.js",
  path.join(process.cwd(), "node_modules", "@github", "copilot", "npm-loader.js")
];
for (const p of possiblePaths) {
  if (fs.existsSync(p)) {
    process.env.COPILOT_CLI_PATH = p;
    break;
  }
}

import { vi } from 'vitest';

vi.mock('../services/sessionGarbageCollector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/sessionGarbageCollector')>();
  return {
    ...actual,
    startSessionGarbageCollector: vi.fn().mockReturnValue(() => {}),
  };
});
