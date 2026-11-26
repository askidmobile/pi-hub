import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  loadHub,
  loadHubConfig,
  loadProjectConfig,
  loadSecrets,
} from "../src/config/load.js";
import { expandHome, resolveHubPaths, SocketPathTooLongError } from "../src/config/paths.js";
import { CLIENT_DEFAULTS, PINNED_PI_VERSION } from "../src/config/schema.js";
import { tempDir } from "./helpers.js";

describe("paths", () => {
  it("defaults to ~/.pi-hub and honours PI_HUB_HOME", () => {
    expect(resolveHubPaths({}).home).toBe(join(homedir(), ".pi-hub"));
    const p = resolveHubPaths({ PI_HUB_HOME: "/tmp/ph" });
    expect(p.socket).toBe("/tmp/ph/hub.sock");
    expect(p.piAgentDir).toBe("/tmp/ph/pi-agent");
    expect(expandHome("~/x")).toBe(join(homedir(), "x"));
  });

  it("rejects socket paths over the macOS limit", () => {
    expect(() => resolveHubPaths({ PI_HUB_HOME: `/tmp/${"a".repeat(120)}` })).toThrow(
      SocketPathTooLongError,
    );
  });
});

describe("hub config", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.cleanup());

  it("treats a missing file as all defaults", () => {
    const c = loadHubConfig(join(dir.path, "nope.yaml"));
    expect(c.delegation_default).toBe("off");
    expect(c.limits.max_workers_hub).toBe(2);
    // Per-task ceilings are off unless the user sets them (stage 2 D-105).
    expect(c.limits.max_task_usd).toBeUndefined();
    expect(c.limits.max_task_minutes).toBeUndefined();
    expect(c.pi.version).toBe(PINNED_PI_VERSION);
    expect(CLIENT_DEFAULTS["claude-code"].max_wait_sec).toBe(1500);
  });

  it("parses roles, expands ~ in allowed_repos and applies nested defaults", () => {
    const f = join(dir.path, "config.yaml");
    writeFileSync(
      f,
      [
        "allowed_repos: [~/work/a]",
        "limits: { max_workers_hub: 3 }",
        "roles:",
        "  code: { model: deepseek/deepseek-flash, escalate: [deepseek/deepseek-v4-pro] }",
        "default_role: code",
      ].join("\n"),
    );
    const c = loadHubConfig(f);
    expect(c.allowed_repos).toEqual([join(homedir(), "work/a")]);
    expect(c.limits.max_workers_hub).toBe(3);
    expect(c.limits.max_task_minutes).toBeUndefined();
    expect(c.roles.code?.model).toBe("deepseek/deepseek-flash");
  });

  it("reports readable validation errors", () => {
    const f = join(dir.path, "bad.yaml");
    writeFileSync(f, "roles:\n  code: { model: no-provider }\ndefault_role: docs\n");
    expect(() => loadHubConfig(f)).toThrow(ConfigError);
    expect(() => loadHubConfig(f)).toThrow(/roles\.code\.model: expected <provider>\/<model id>/);
    writeFileSync(f, "roles:\n  code: { model: a/b }\ndefault_role: docs\n");
    expect(() => loadHubConfig(f)).toThrow(/default_role/);
    writeFileSync(f, "limits: [1, 2\n");
    expect(() => loadHubConfig(f)).toThrow(/invalid YAML/);
  });

  it("uses transport.unix_socket from config for paths", () => {
    const home = join(dir.path, "h");
    mkdirSync(home);
    writeFileSync(
      join(home, "config.yaml"),
      `transport: { unix_socket: ${join(dir.path, "s.sock")} }\n`,
    );
    const { paths } = loadHub({ PI_HUB_HOME: home });
    expect(paths.socket).toBe(join(dir.path, "s.sock"));
  });
});

describe("project config", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.cleanup());

  it("reads .pi-hub.toml and tolerates its absence", () => {
    expect(loadProjectConfig(dir.path)).toEqual({});
    writeFileSync(
      join(dir.path, ".pi-hub.toml"),
      'delegation = "on"\nsetup = "pnpm install --frozen-lockfile"\n',
    );
    expect(loadProjectConfig(dir.path)).toEqual({
      delegation: "on",
      setup: "pnpm install --frozen-lockfile",
    });
    writeFileSync(join(dir.path, ".pi-hub.toml"), 'delegation = "maybe"\n');
    expect(() => loadProjectConfig(dir.path)).toThrow(/delegation/);
  });

  it("quality commands: timeout defaults to 15 minutes, empty commands are rejected", () => {
    writeFileSync(join(dir.path, ".pi-hub.toml"), '[quality]\ntest = "pnpm test"\n');
    expect(loadProjectConfig(dir.path).quality).toEqual({ test: "pnpm test", timeout_minutes: 15 });
    writeFileSync(join(dir.path, ".pi-hub.toml"), '[quality]\nlint = ""\n');
    expect(() => loadProjectConfig(dir.path)).toThrow(/lint/);
  });
});

describe("secrets", () => {
  let dir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => dir.cleanup());

  it("parses dotenv without touching process.env and warns about loose permissions", () => {
    const f = join(dir.path, ".env");
    writeFileSync(
      f,
      [
        "# comment",
        "DEEPSEEK_API_KEY=sk-test-123456",
        "export ZAI_API_KEY='zai test key'",
        'MOONSHOT_API_KEY="m-1" # trailing',
        "EMPTY=",
        "garbage line",
      ].join("\n"),
    );
    chmodSync(f, 0o644);
    const s = loadSecrets(f);
    expect(s.values).toEqual({
      DEEPSEEK_API_KEY: "sk-test-123456",
      ZAI_API_KEY: "zai test key",
      MOONSHOT_API_KEY: "m-1",
    });
    expect(process.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(s.warnings.some((w) => w.includes("644"))).toBe(true);
    expect(s.warnings.some((w) => w.includes("malformed"))).toBe(true);
    chmodSync(f, 0o600);
    expect(loadSecrets(f).warnings.some((w) => w.includes("permissions"))).toBe(false);
  });
});
