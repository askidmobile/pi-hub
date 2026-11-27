import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../src/config/schema.js";
import { createLogger } from "../src/log.js";
import {
  buildIssues,
  type CommandOutcome,
  NO_COMMANDS_ISSUE,
  newFailures,
  QualityGate,
} from "../src/quality/quality-gate.js";
import { migrate, openDatabase } from "../src/storage/db.js";
import { Repos } from "../src/storage/repos.js";
import { detectTestTampering, tamperingWarning } from "../src/tasks/finalize.js";
import { GitLock } from "../src/workspaces/git.js";
import { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { initRepo, tempDir } from "./helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("QualityGate", () => {
  let dir: ReturnType<typeof tempDir>;
  let repo: string;
  let repos: Repos;
  let wm: WorkspaceManager;
  let base: string;
  let projectId: string;
  const gate = (timeoutMs?: number) =>
    new QualityGate({
      wm,
      repos,
      logsDir: join(dir.path, "logs"),
      logger: createLogger({ file: join(dir.path, "hub.log"), level: "debug" }),
      timeoutMs,
    });
  const input = (project: ProjectConfig, taskId = "t_0001") => ({
    taskId,
    projectId,
    repoRoot: repo,
    worktree: repo,
    baseCommit: base,
    project,
    attempt: 1,
    round: 1,
  });

  beforeEach(() => {
    dir = tempDir();
    repo = join(dir.path, "repo");
    mkdirSync(repo);
    initRepo(repo);
    base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const db = openDatabase(join(dir.path, "hub.db"));
    migrate(db);
    repos = new Repos(db);
    projectId = repos.upsertProject(repo, null).id;
    wm = new WorkspaceManager(join(dir.path, "wt"), new GitLock());
  });
  afterEach(() => dir.cleanup());

  it("SKIPPED with a note when no commands are configured", async () => {
    expect(await gate().check(input({}))).toEqual({
      status: "SKIPPED",
      commands: [],
      issues: [NO_COMMANDS_ISSUE],
      logPath: null,
    });
  });

  it("PASS and FAIL with issues capped at 10 x 200 and the full output in the log", async () => {
    const pass = await gate().check(
      input({ quality: { test: "echo all good", timeout_minutes: 15 } }),
    );
    expect(pass).toMatchObject({ status: "PASS", issues: [] });
    const long = "x".repeat(300);
    // fails only in the task: `marker` is not in the base commit
    writeFileSync(join(repo, "marker"), "");
    const cmd = `test ! -f marker || { for i in $(seq 1 30); do echo "error: line $i ${long}"; done; exit 2; }`;
    const fail = await gate().check(
      input({ quality: { lint: cmd, typecheck: "true", timeout_minutes: 15 } }),
    );
    expect(fail.status).toBe("FAIL");
    expect(fail.issues.length).toBe(10);
    expect(fail.issues[0]).toBe("lint: код 2");
    expect(fail.issues.every((i) => i.length <= 200 && i.startsWith("lint: "))).toBe(true);
    const log = readFileSync(fail.logPath as string, "utf8");
    expect(log).toContain("=== attempt 1.1 · lint:");
    expect(log).toContain("error: line 30");
    expect(log).toContain("typecheck: true · exit 0");
  });

  it("a timed-out command is killed with its children and fails", async () => {
    writeFileSync(join(repo, "marker"), "");
    const pidFile = join(dir.path, "child.pid");
    const r = await gate(300).check(
      input({
        quality: {
          test: `test ! -f marker || { sleep 30 & echo $! > ${pidFile}; wait; }`,
          timeout_minutes: 15,
        },
      }),
    );
    expect(r.status).toBe("FAIL");
    expect(r.issues[0]).toMatch(/^test: превышено время/);
    await sleep(100);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("errors that fail on the base too are marked and are not new; the base is checked once", async () => {
    const counter = join(dir.path, "runs");
    const project: ProjectConfig = {
      quality: { test: `echo run >> ${counter}; test -f required.txt`, timeout_minutes: 15 },
    };
    const g = gate();
    const r1 = await g.check(input(project, "t_0001"));
    expect(r1.status).toBe("FAIL");
    expect(r1.issues[0]).toBe(`test: падало до задачи: ${project.quality?.test}`);
    expect(newFailures(r1)).toEqual([]);
    expect(repos.getBaseline(projectId, base)).toMatchObject([{ command: "test", exit_code: 1 }]);
    // a second gate (new hub process) reuses the stored baseline
    await gate().check(input(project, "t_0002"));
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(3);
    // the temporary base worktree is removed
    expect(
      execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" }),
    ).not.toContain("_base-");
  });

  it("checks of one project run one after another (FR-114)", async () => {
    const order = join(dir.path, "order");
    const project: ProjectConfig = {
      quality: {
        test: `echo start >> ${order}; sleep 0.3; echo end >> ${order}`,
        timeout_minutes: 15,
      },
    };
    const g = gate();
    await Promise.all([g.check(input(project, "t_0001")), g.check(input(project, "t_0002"))]);
    const lines = readFileSync(order, "utf8").trim().split("\n");
    for (let i = 0; i < lines.length; i += 2)
      expect(lines.slice(i, i + 2)).toEqual(["start", "end"]);
    expect(lines).toHaveLength(6); // base + two tasks
  });
});

describe("quality helpers", () => {
  const o = (name: CommandOutcome["name"], over: Partial<CommandOutcome> = {}): CommandOutcome => ({
    name,
    command: name,
    exitCode: 1,
    timedOut: false,
    durationMs: 1,
    failedOnBase: false,
    ok: false,
    ...over,
  });

  it("issues show every failed command within the limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => `error ${i}`).join("\n");
    const issues = buildIssues(
      [o("test"), o("lint", { timedOut: true })],
      new Map([["test", many]]),
      15 * 60_000,
    );
    expect(issues).toHaveLength(10);
    expect(issues.slice(0, 2)).toEqual(["test: код 1", "lint: превышено время (15 мин)"]);
  });

  it("test tampering: deleted test files and added skip markers (FR-121)", () => {
    const files = detectTestTampering(
      [
        { status: "D", file: "src/a.test.ts" },
        { status: "D", file: "src/a.ts" },
        { status: "M", file: "pkg/x_test.go" },
      ],
      new Map([
        ["pkg/x_test.go", ['\tt.Skip("flaky")']],
        ["tests/test_y.py", ["@pytest.mark.skip(reason='x')"]],
        ["src/b.spec.js", ["  it.only('focus', () => {})"]],
        ["src/c.ts", ["const skip = true;"]],
      ]),
    );
    expect(files).toEqual(["pkg/x_test.go", "src/a.test.ts", "src/b.spec.js", "tests/test_y.py"]);
    expect(tamperingWarning(files)).toBe(
      "изменены или отключены тесты: pkg/x_test.go, src/a.test.ts, src/b.spec.js, tests/test_y.py",
    );
    expect(tamperingWarning([])).toBe(null);
  });
});
