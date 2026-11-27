import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BEGIN,
  END,
  inspectProfile,
  installProfile,
  ProfileError,
  profilePath,
  renderBlock,
  upsertBlock,
} from "../src/cli/codex-profile.js";
import { codexChecks } from "../src/cli/doctor.js";
import { tempDir } from "./helpers.js";

interface ProfileDoc {
  model?: string;
  mcp_servers: Record<string, unknown>;
  hooks: { Stop: { hooks: { command: string }[] }[]; SessionStart?: unknown };
  projects: Record<string, { trust_level: string }>;
}

/** Stage 3 scenario 1: the Codex profile (FR-207, FR-208, FR-210, D-216). */
describe("Codex profile", () => {
  let dir: ReturnType<typeof tempDir>;
  let env: NodeJS.ProcessEnv;
  let file: string;
  beforeEach(() => {
    dir = tempDir();
    env = { CODEX_HOME: join(dir.path, ".codex"), PATH: "" };
    mkdirSync(env.CODEX_HOME as string);
    file = profilePath(env);
  });
  afterEach(() => dir.cleanup());

  const trust = (group: number, hook = 0) =>
    `[hooks.state."${file}:stop:${group}:${hook}"]\ntrusted_hash = "sha256:abc"\n`;

  it("creates the profile: MCP server, long timeout, approval, Stop hook, no SessionStart", () => {
    expect(installProfile(env)).toEqual({ path: file, action: "created" });
    const doc = parse(readFileSync(file, "utf8")) as unknown as ProfileDoc;
    expect(doc.mcp_servers["pi-hub"]).toEqual({
      command: "pi-hub-shim",
      args: ["--client", "codex"],
      tool_timeout_sec: 900,
      default_tools_approval_mode: "approve",
    });
    expect(doc.hooks.Stop[0]?.hooks[0]?.command).toBe("pi-hub-shim hook stop --client codex");
    expect(doc.hooks.SessionStart).toBeUndefined();
    expect(inspectProfile(env)).toMatchObject({
      mcpOk: true,
      hook: { group: 0, index: 0 },
      trusted: false,
    });
    expect(installProfile(env).action).toBe("kept");
  });

  it("a second init rewrites only the block: trust, folders, comments and other keys stay; .bak", () => {
    const oldBlock = renderBlock().replace("tool_timeout_sec = 900", "tool_timeout_sec = 600");
    const before = [
      "# my own comment",
      'model = "gpt-5.5"',
      "",
      '[projects."/Users/u/work"]',
      'trust_level = "trusted"',
      "",
      oldBlock,
      "",
      trust(0),
    ].join("\n");
    writeFileSync(file, before);
    expect(inspectProfile(env)).toMatchObject({ mcpOk: false, trusted: true });
    const r = installProfile(env);
    expect(r).toEqual({ path: file, action: "updated", backup: `${file}.bak` });
    expect(readFileSync(`${file}.bak`, "utf8")).toBe(before);
    const after = readFileSync(file, "utf8");
    expect(after).toBe(before.replace(oldBlock, renderBlock()));
    const doc = parse(after) as unknown as ProfileDoc;
    expect(doc.model).toBe("gpt-5.5");
    expect(doc.projects["/Users/u/work"]?.trust_level).toBe("trusted");
    expect(inspectProfile(env)).toMatchObject({ mcpOk: true, trusted: true });
  });

  it("appends to a profile without markers; the hook index follows the user's own Stop hooks", () => {
    writeFileSync(
      file,
      'model = "x"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "say done"\n',
    );
    installProfile(env);
    const text = readFileSync(file, "utf8");
    expect(text.startsWith('model = "x"')).toBe(true);
    expect(inspectProfile(env).hook).toMatchObject({ group: 1, index: 0 });
    writeFileSync(file, `${text}\n${trust(0)}`);
    expect(inspectProfile(env).trusted).toBe(false);
    writeFileSync(file, `${text}\n${trust(1)}`);
    expect(inspectProfile(env).trusted).toBe(true);
  });

  it("refuses pi-hub without markers, broken markers and a result that does not parse", () => {
    expect(() => upsertBlock('[mcp_servers.pi-hub]\ncommand = "x"\n')).toThrow(ProfileError);
    expect(() => upsertBlock(`${END}\n${BEGIN}\n`)).toThrow(/повреждены/);
    expect(() => upsertBlock(`${BEGIN}\nx\n${BEGIN}\n${END}\n`)).toThrow(/повреждены/);
    expect(() => upsertBlock("[broken\n")).toThrow(/не разбирается как TOML/);
    writeFileSync(file, "[broken\n");
    expect(() => installProfile(env)).toThrow(ProfileError);
    expect(readFileSync(file, "utf8")).toBe("[broken\n");
  });

  it("the plugin's template carries the same block", () => {
    const template = readFileSync(
      join(import.meta.dirname, "../../../plugins/codex/pi-hub.config.toml"),
      "utf8",
    );
    expect(template).toContain(renderBlock());
  });

  it("doctor: no Codex, no profile, untrusted hook names /hooks, trusted", () => {
    expect(codexChecks(env, undefined)).toEqual([
      { name: "Codex", level: "ok", detail: "не установлен" },
    ]);
    expect(codexChecks(env, "/usr/local/bin/codex")[0]).toMatchObject({ level: "warn" });
    installProfile(env);
    const untrusted = codexChecks(env, "/usr/local/bin/codex");
    expect(untrusted.map((c) => c.level)).toEqual(["ok", "warn"]);
    expect(untrusted[1]?.detail).toContain("/hooks");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n${trust(0)}`);
    expect(codexChecks(env, undefined)[1]).toEqual({
      name: "хук Codex",
      level: "ok",
      detail: "доверен",
    });
  });
});
