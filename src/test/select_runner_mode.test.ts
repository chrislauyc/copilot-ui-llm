import { describe, it, expect } from "vitest";
import { selectRunnerMode } from "../workspace/workspace";

describe("selectRunnerMode (pure, issue #301)", () => {
  it("selects native when AI_STUDIO is 'true'", () => {
    expect(selectRunnerMode({ AI_STUDIO: "true" })).toBe("native");
  });

  it("selects native when NODE_ENV is 'test'", () => {
    expect(selectRunnerMode({ NODE_ENV: "test" })).toBe("native");
  });

  it("selects native when VITEST is 'true'", () => {
    expect(selectRunnerMode({ VITEST: "true" })).toBe("native");
  });

  it("selects docker when none of the env flags are set", () => {
    expect(selectRunnerMode({})).toBe("docker");
  });

  it("selects docker when flags are set to other values", () => {
    expect(
      selectRunnerMode({ AI_STUDIO: "false", NODE_ENV: "production", VITEST: "false" })
    ).toBe("docker");
  });
});
