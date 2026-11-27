import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findInPath, runDoctor } from "../src/cli/doctor.js";
import { applyInit, connectPlugin, findAppClaude, renderConfig } from "../src/cli/init.js";
import { formatTasks, listTasks } from "../src/cli/status.js";
import { migrate, openDatabase } from "../src/storage/db.js";
import { Repos } from "../src/storage/repos.js";
import { FAKE_WORKER, tempDir } from "./helpers.js";

/** Plan phase 5: `init`, `doctor`, `status`. The CLI itself runs from dist (`pnpm test` builds). */
const HUB_CLI = fileURLToPath(new URL("../dist/cli/main.js", import.meta.url));
const SHIM = fileURLToPath(new URL("../../shim/dist/index.js", import.meta.url));

let tmp: ReturnType<typeof tempDir>;
let home: string;
let bin: string;
let env: NodeJS.ProcessEnv;

/** A `pi` stand-in: prints `version` for --version, otherwise runs the fake worker. */
function fakePi(version = "1.6.1"): string {
  const file = join(bin, "pi");
  writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexec "${process.execPath}" "${FAKE_WORKER}" "$@"\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.path, "h");
  bin = join(tmp.path, "bin");
  mkdirSync(bin);
  symlinkSync(SHIM, join(bin, "pi-hub-shim"));
  // CODEX_HOME in the temp dir: init must never touch the real ~/.codex
  env = {
    PI_HUB_HOME: home,
    CODEX_HOME: join(tmp.path, ".codex"),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
});
afterEach(() => tmp.cleanup());

describe("pi-hub init", () => {
  it("creates config, .env 0600 and the Pi config dir; a second run changes nothing", () => {
    const answers = {
      model: "deepseek/deepseek-flash",
      apiKey: "sk-test-123",
      allowedRepos: [tmp.path],
    };
    const first = applyInit(answers, env);
    expect(first.actions.filter((a) => a.action === "created").map((a) => a.file)).toEqual(
      expect.arrayContaining([first.paths.config, first.paths.env, first.paths.piAgentDir]),
    );
    expect(statSync(first.paths.env).mode & 0o777).toBe(0o600);
    expect(statSync(first.paths.piAgentDir).isDirectory()).toBe(true);
    expect(readFileSync(first.paths.env, "utf8")).toContain("DEEPSEEK_API_KEY=sk-test-123");
    expect(readFileSync(first.paths.config, "utf8")).toContain("model: deepseek/deepseek-flash");

    const snapshot = [first.paths.config, first.paths.env].map((f) => ({
      body: readFileSync(f, "utf8"),
      mtime: statSync(f).mtimeMs,
    }));
    const second = applyInit(answers, env);
    expect(second.actions.every((a) => a.action === "kept")).toBe(true);
    expect(
      [first.paths.config, first.paths.env].map((f) => ({
        body: readFileSync(f, "utf8"),
        mtime: statSync(f).mtimeMs,
      })),
    ).toEqual(snapshot);
  });

  it("adds a missing key to an existing .env without touching other lines", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".env"), "OTHER=1\n", { mode: 0o600 });
    const r = applyInit({ model: "zai/glm-5.2", apiKey: "k with space", allowedRepos: [] }, env);
    expect(r.actions.find((a) => a.file === r.paths.env)?.action).toBe("updated");
    expect(readFileSync(r.paths.env, "utf8")).toBe('OTHER=1\nZAI_API_KEY="k with space"\n');
  });

  it("CLI: non-interactive init ends with doctor checks, none failing", () => {
    const pi = fakePi();
    const args = [
      HUB_CLI,
      "init",
      "--yes",
      "--model",
      "fake/success",
      "--repo",
      tmp.path,
      "--pi-bin",
      pi,
      "--no-plugin",
    ];
    const out = execFileSync(process.execPath, args, { env, encoding: "utf8" });
    expect(out).toContain("✓ Pi видит модель: fake/success");
    expect(out).not.toContain("✗");
    // with codex installed the profile lands in the temp CODEX_HOME (stage 3 FR-208)
    const profile = join(tmp.path, ".codex", "pi-hub.config.toml");
    expect(existsSync(profile)).toBe(!!findInPath("codex", env.PATH));
    expect(existsSync(join(tmp.path, ".codex", "skills", "pi-hub-architect", "SKILL.md"))).toBe(
      !!findInPath("codex", env.PATH),
    );
    // Repeat run: config kept, questions skipped.
    const again = execFileSync(process.execPath, args, { env, encoding: "utf8" });
    expect(again).toContain("вопросы пропущены");
    expect(again).toContain("оставлен как есть");
  });
});

describe("pi-hub init: providers from extensions and the app's claude", () => {
  it("writes pi.extensions for a provider that comes from a Pi extension", () => {
    const yaml = renderConfig({
      model: "9router/Deepseek-v4.1-flash",
      allowedRepos: [],
      extensions: ["/x/9router.ts"],
    });
    expect(yaml).toMatch(
      /pi:\n {2}version: .*\n {2}bin: pi\n {2}extensions:\n {4}- \/x\/9router\.ts/,
    );
    expect(renderConfig({ model: "zai/glm-5.2", allowedRepos: [] })).not.toContain("extensions");
  });

  it("CLI --extension lands in the config", () => {
    const ext = join(tmp.path, "router.ts");
    writeFileSync(ext, "export default () => {};\n");
    execFileSync(
      process.execPath,
      [
        HUB_CLI,
        "init",
        "--yes",
        "--model",
        "fake/success",
        "--extension",
        ext,
        "--no-plugin",
        "--no-check",
      ],
      { env, encoding: "utf8" },
    );
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toContain(`- ${ext}`);
  });

  it("finds the newest Claude Code CLI bundled with the desktop app", () => {
    const root = join(tmp.path, "claude-code");
    expect(findAppClaude(root)).toBeUndefined();
    const make = (version: string, build: string) => {
      const dir = join(root, version, build, "claude.app", "Contents", "MacOS");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "claude"), "");
      return join(dir, "claude");
    };
    make("2.1.9", "aaa");
    const newest = make("2.1.331", "5cdc5c10ac5c");
    mkdirSync(join(root, "2.2.0", "empty"), { recursive: true });
    expect(findAppClaude(root)).toBe(newest);
  });

  it("connectPlugin runs the found claude, or prints the commands without one", async () => {
    const log = join(tmp.path, "claude.log");
    const claude = join(bin, "my claude");
    writeFileSync(claude, `#!/bin/sh\necho "$@" >> "${log}"\n`);
    chmodSync(claude, 0o755);
    expect(await connectPlugin("/repo", claude)).toMatchObject({ done: true });
    expect(readFileSync(log, "utf8")).toBe(
      "plugin marketplace add /repo\nplugin install pi-hub@pi-hub-local --scope user\n",
    );
    // never undefined here: that would pick the real claude of this machine
    const none = await connectPlugin("/repo", null);
    expect(none).toMatchObject({ done: false });
    expect(none.commands[0]).toBe("claude plugin marketplace add /repo");
  });
});

describe("pi-hub doctor", () => {
  function setup(model: string, version = "1.6.1") {
    applyInit({ model, allowedRepos: [], piBin: fakePi(version) }, env);
  }
  const byName = (checks: Awaited<ReturnType<typeof runDoctor>>, name: string) =>
    checks.find((c) => c.name === name);

  it("all checks pass with a fake pi; only the stopped daemon is a warning", async () => {
    setup("fake/success");
    const checks = await runDoctor(env);
    expect(checks.filter((c) => c.level === "fail")).toEqual([]);
    // Codex checks depend on whether codex is installed here (codex-profile.test.ts covers them)
    const warns = checks.filter((c) => c.level === "warn" && !/Codex/.test(c.name));
    expect(warns.map((c) => c.name)).toEqual(["демон"]);
  });

  it("fails on a Pi version other than the pinned one", async () => {
    setup("fake/success", "1.5.0");
    const pi = byName(await runDoctor(env), "Pi");
    expect(pi?.level).toBe("fail");
    expect(pi?.detail).toContain("1.5.0");
  });

  it("fails when Pi does not see the default model", async () => {
    setup("fake/no-such-model");
    const check = byName(await runDoctor(env), "Pi видит модель");
    expect(check?.level).toBe("fail");
  });

  it("fails when the provider key is missing and skips the model probe", async () => {
    setup("deepseek/deepseek-flash");
    const checks = await runDoctor(env);
    expect(byName(checks, "ключ провайдера")?.level).toBe("fail");
    expect(byName(checks, "Pi видит модель")).toBeUndefined();
  });

  it("CLI: doctor exits right after the checks (no pending Pi stop timer)", () => {
    setup("fake/success");
    const t0 = Date.now();
    execFileSync(process.execPath, [HUB_CLI, "doctor"], { env, encoding: "utf8" });
    // The probe's stop grace is 4 s; a leaked timer kept the process alive for 2 s of it.
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it("without init: config missing", async () => {
    const checks = await runDoctor(env);
    expect(byName(checks, "конфиг")?.level).toBe("fail");
  });
});

describe("pi-hub status", () => {
  it("lists tasks of every session from the database, read-only", () => {
    expect(formatTasks(listTasks(env))).toBe("Задач нет.");
    mkdirSync(home, { recursive: true });
    const db = openDatabase(join(home, "hub.db"));
    migrate(db);
    const repos = new Repos(db);
    const project = repos.upsertProject(tmp.path, null);
    for (const client of ["claude-code", "codex"] as const) {
      const s = repos.createSession({
        client,
        parent_pid: 1,
        project_id: project.id,
        mode: "on",
      });
      repos.insertTask({
        owner_session_id: s.id,
        project_id: project.id,
        task_text: `task from ${client}`,
        role: "code",
        model: "fake/success",
        base_branch: "main",
        routed_by: "rules",
        route_reason: "default role",
      });
    }
    db.close();
    const tasks = listTasks(env);
    expect(tasks).toHaveLength(2);
    const table = formatTasks(tasks);
    expect(table).toContain("task from claude-code");
    expect(table).toContain("task from codex");
  });
});
