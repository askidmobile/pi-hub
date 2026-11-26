import { describe, expect, it } from "vitest";
import {
  buildWorkerLaunch,
  MissingProviderKeyError,
  type WorkerLaunchInput,
} from "../src/pi-rpc/launcher.js";

const base: WorkerLaunchInput = {
  bin: "pi",
  provider: "deepseek",
  modelId: "deepseek-flash",
  cwd: "/wt/t_0001",
  sessionDir: "/h/sessions",
  taskId: "t_0001",
  extensionPath: "/ext/index.ts",
  promptFile: "/h/prompts/t_0001.md",
  piAgentDir: "/h/pi-agent",
  secrets: { DEEPSEEK_API_KEY: "sk-deepseek", OPENAI_API_KEY: "sk-openai-from-env-file" },
  baseEnv: {
    PATH: "/usr/bin",
    HOME: "/home/u",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    OPENAI_API_KEY: "sk-shell-openai",
    ANTHROPIC_API_KEY: "sk-shell-anthropic",
    CLAUDE_CODE_SESSION: "x",
    PI_CODING_AGENT_DIR: "/home/u/.pi/agent",
    NODE_OPTIONS: "--inspect",
  },
};

describe("worker launch (ADR-0011, FR-011)", () => {
  it("builds the environment from the allowlist plus only the selected provider key", () => {
    const { env } = buildWorkerLaunch(base);
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      PI_CODING_AGENT_DIR: "/h/pi-agent",
      PI_OFFLINE: "1",
      DEEPSEEK_API_KEY: "sk-deepseek",
    });
  });

  it("passes isolation flags, model, session and prompt", () => {
    const { command, args, cwd } = buildWorkerLaunch({ ...base, thinking: "low" });
    expect(command).toBe("pi");
    expect(cwd).toBe("/wt/t_0001");
    expect(args).toEqual([
      "--mode",
      "rpc",
      "--model",
      "deepseek/deepseek-flash:low",
      "--session-dir",
      "/h/sessions",
      "--name",
      "t_0001",
      "-ne",
      "-e",
      "/ext/index.ts",
      "-ns",
      "-np",
      "--no-mcp",
      "-na",
      "--append-system-prompt",
      "/h/prompts/t_0001.md",
    ]);
  });

  it("fails clearly when the provider key is missing, and needs no key for unknown providers", () => {
    expect(() => buildWorkerLaunch({ ...base, secrets: {} })).toThrow(MissingProviderKeyError);
    expect(() => buildWorkerLaunch({ ...base, secrets: {} })).toThrow(/DEEPSEEK_API_KEY/);
    const fake = buildWorkerLaunch({
      ...base,
      provider: "fake",
      modelId: "success",
      secrets: {},
      bin: "node",
      binArgs: ["/fw.ts"],
    });
    expect(fake.args.slice(0, 1)).toEqual(["/fw.ts"]);
    expect(Object.keys(fake.env).some((k) => k.endsWith("_API_KEY"))).toBe(false);
  });
});

describe("provider extensions (plan PD-013)", () => {
  it("adds each config pi.extensions path as -e after the pi-hub extension, keeping -ne", () => {
    const { args } = buildWorkerLaunch({ ...base, extraExtensions: ["/u/9router.ts", "/u/b.ts"] });
    const i = args.indexOf("/ext/index.ts");
    expect(args.slice(i + 1, i + 5)).toEqual(["-e", "/u/9router.ts", "-e", "/u/b.ts"]);
    expect(args).toContain("-ne");
  });
});
