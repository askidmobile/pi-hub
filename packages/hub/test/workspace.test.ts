import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowlistedEnv } from "../src/pi-rpc/launcher.js";
import { ATTRIBUTION_PATTERN, findAttribution } from "../src/workspaces/attribution.js";
import { GitLock } from "../src/workspaces/git.js";
import {
  BaseBranchNotFoundError,
  errorExcerpt,
  WorkspaceManager,
} from "../src/workspaces/workspace-manager.js";
import { initRepo, tempDir } from "./helpers.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("WorkspaceManager", () => {
  let dir: ReturnType<typeof tempDir>;
  let repo: string;
  let wm: WorkspaceManager;
  beforeEach(() => {
    dir = tempDir();
    repo = join(dir.path, "repo");
    mkdirSync(repo);
    initRepo(repo);
    wm = new WorkspaceManager(join(dir.path, "wt"), new GitLock());
  });
  afterEach(() => dir.cleanup());

  it("creates a worktree on pi/<task_id> from the base and reuses it on resume", async () => {
    const ws = await wm.create({
      taskId: "t_0001",
      projectId: "p_x",
      repoRoot: repo,
      baseBranch: "main",
    });
    expect(ws.branch).toBe("pi/t_0001");
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("pi/t_0001");
    expect(ws.baseCommit).toBe(git(repo, "rev-parse", "main"));
    const again = await wm.create({
      taskId: "t_0001",
      projectId: "p_x",
      repoRoot: repo,
      baseBranch: "main",
    });
    expect(again.path).toBe(ws.path);
  });

  it("serializes concurrent worktree creation in one repository (FR-028)", async () => {
    const all = await Promise.all(
      ["t_0001", "t_0002", "t_0003"].map((taskId) =>
        wm.create({ taskId, projectId: "p_x", repoRoot: repo, baseBranch: "main" }),
      ),
    );
    expect(new Set(all.map((w) => w.branch)).size).toBe(3);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(4);
  });

  it("rejects an unknown base branch", async () => {
    await expect(
      wm.create({ taskId: "t_0009", projectId: "p_x", repoRoot: repo, baseBranch: "nope" }),
    ).rejects.toBeInstanceOf(BaseBranchNotFoundError);
  });

  it("runs setup and reports the first error lines on failure (FR-024)", async () => {
    const ws = await wm.create({
      taskId: "t_0001",
      projectId: "p_x",
      repoRoot: repo,
      baseBranch: "main",
    });
    expect((await wm.runSetup(ws.path, "echo ready > setup.out", allowlistedEnv())).ok).toBe(true);
    expect(readFileSync(join(ws.path, "setup.out"), "utf8")).toBe("ready\n");
    const bad = await wm.runSetup(
      ws.path,
      "echo installing; echo 'ERR! missing dependency foo' >&2; exit 3",
      allowlistedEnv(),
    );
    expect(bad).toMatchObject({ ok: false, exitCode: 3, timedOut: false });
    expect(bad.excerpt).toContain("ERR! missing dependency foo");
    const slow = await wm.runSetup(ws.path, "sleep 5", allowlistedEnv(), 200);
    expect(slow).toMatchObject({ ok: false, timedOut: true });
    const leak = await wm.runSetup(
      ws.path,
      'test -z "$ANTHROPIC_API_KEY" && test -n "$PATH"',
      allowlistedEnv({ PATH: process.env.PATH, ANTHROPIC_API_KEY: "sk-leak" }),
    );
    expect(leak.ok).toBe(true);
  });

  it("auto-commits leftovers, lists changed files and finds AI attribution (FR-016)", async () => {
    const ws = await wm.create({
      taskId: "t_0001",
      projectId: "p_x",
      repoRoot: repo,
      baseBranch: "main",
    });
    writeFileSync(join(ws.path, "a.txt"), "a\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-q", "-m", "Add a\n\nCo-authored-by: Claude <noreply@anthropic.com>");
    writeFileSync(join(ws.path, "b.txt"), "b\n");
    expect(await wm.isDirty(ws.path)).toBe(true);
    const sha = await wm.autoCommit(repo, ws.path, "Add b");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await wm.isDirty(ws.path)).toBe(false);
    expect(await wm.autoCommit(repo, ws.path, "noop")).toBeNull();
    expect((await wm.changedFiles(ws.path, ws.baseCommit)).sort()).toEqual(["a.txt", "b.txt"]);
    const v = await wm.attributionViolations(ws.path, ws.baseCommit);
    expect(v).toHaveLength(1);
    expect(v[0]?.lines[0]).toContain("Co-authored-by: Claude");
    expect(git(ws.path, "log", "-1", "--format=%an")).toBe("Test User");
  });

  it("reports a stale base: dirty main tree or HEAD away from base (FR-029)", async () => {
    expect(await wm.staleBaseReasons(repo, "main")).toEqual([]);
    writeFileSync(join(repo, "wip.txt"), "x");
    git(repo, "checkout", "-q", "-b", "feature");
    git(repo, "commit", "-q", "--allow-empty", "-m", "feature work");
    const reasons = await wm.staleBaseReasons(repo, "main");
    expect(reasons).toHaveLength(2);
  });
});

describe("attribution pattern", () => {
  it("is identical to the CI script pattern", () => {
    const script = readFileSync(
      new URL("../../../scripts/check-attribution.sh", import.meta.url),
      "utf8",
    );
    const m = /^PATTERN='(.*)'$/m.exec(script);
    expect(m?.[1]).toBe(ATTRIBUTION_PATTERN);
  });

  it("flags AI co-authors and generation notes, not human co-authors", () => {
    expect(findAttribution("fix\n\nCo-authored-by: Jane <jane@example.com>")).toEqual([]);
    expect(findAttribution("x\nCo-Authored-By: Claude Opus <noreply@anthropic.com>")).toHaveLength(
      1,
    );
    expect(
      findAttribution("🤖 Generated with [Claude Code](https://claude.com/claude-code)"),
    ).toHaveLength(1);
  });
});

describe("errorExcerpt", () => {
  it("starts at the first error-looking line, else returns the tail", () => {
    expect(errorExcerpt("a\nb\nnpm ERR! boom\nc", 2)).toBe("npm ERR! boom\nc");
    expect(errorExcerpt("1\n2\n3", 2)).toBe("2\n3");
    expect(existsSync).toBeDefined();
  });
});
