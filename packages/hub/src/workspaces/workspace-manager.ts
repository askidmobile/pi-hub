import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { findAttribution } from "./attribution.js";
import { GitError, GitLock, git } from "./git.js";

/**
 * git worktree + branch `pi/<task_id>` per task (spec FR-010), setup command (FR-024),
 * auto-commit and attribution check (FR-016), stale-base detection (FR-029).
 * Every operation that writes to the shared repository goes through GitLock (FR-028).
 */

export interface Workspace {
  path: string;
  branch: string;
  baseCommit: string;
}

export interface SetupResult {
  ok: boolean;
  exitCode: number | null;
  /** First error-looking lines (or the tail) of the output, for the envelope/failure reason. */
  excerpt: string;
  timedOut: boolean;
}

export interface CommandResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  /** Combined stdout and stderr, last bytes only. */
  output: string;
  durationMs: number;
  spawnError?: string;
}

export interface DiffEntry {
  status: string;
  file: string;
}

export interface CommitInfo {
  sha: string;
  message: string;
}

export class BaseBranchNotFoundError extends Error {
  constructor(
    public readonly repoRoot: string,
    public readonly baseBranch: string,
  ) {
    super(`base branch "${baseBranch}" not found in ${repoRoot}`);
    this.name = "BaseBranchNotFoundError";
  }
}

const SETUP_EXCERPT_LINES = 40;

export function branchFor(taskId: string): string {
  return `pi/${taskId}`;
}

export class WorkspaceManager {
  constructor(
    private readonly worktreesDir: string,
    private readonly lock: GitLock = new GitLock(),
  ) {}

  worktreePath(projectId: string, taskId: string): string {
    return join(this.worktreesDir, projectId, taskId);
  }

  async resolveCommit(repoRoot: string, ref: string): Promise<string | null> {
    try {
      return await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    } catch {
      return null;
    }
  }

  /** Creates (or reuses, on resume) the worktree for a task. */
  async create(input: {
    taskId: string;
    projectId: string;
    repoRoot: string;
    baseBranch: string;
  }): Promise<Workspace> {
    const branch = branchFor(input.taskId);
    const path = this.worktreePath(input.projectId, input.taskId);
    const baseCommit = await this.resolveCommit(input.repoRoot, input.baseBranch);
    if (!baseCommit) throw new BaseBranchNotFoundError(input.repoRoot, input.baseBranch);
    if (existsSync(join(path, ".git"))) return { path, branch, baseCommit };
    mkdirSync(dirname(path), { recursive: true });
    await this.lock.run(input.repoRoot, () =>
      git(input.repoRoot, ["worktree", "add", "-q", "-b", branch, path, baseCommit]),
    );
    return { path, branch, baseCommit };
  }

  /** Runs the project `setup` command in the worktree before the worker starts. */
  /**
   * `env` must be the allowlisted environment (launcher.allowlistedEnv): setup runs project
   * code (install scripts of dependencies) and must not see keys inherited by the hub.
   */
  runSetup(
    path: string,
    command: string,
    env: NodeJS.ProcessEnv,
    timeoutMs = 15 * 60_000,
  ): Promise<SetupResult> {
    return this.runCommand(path, command, env, timeoutMs).then((r) => ({
      ok: r.ok,
      exitCode: r.exitCode,
      excerpt: r.ok ? "" : (r.spawnError ?? errorExcerpt(r.output)),
      timedOut: r.timedOut,
    }));
  }

  /**
   * Runs a shell command in its own process group (setup, quality gate). On timeout the whole
   * tree is killed, not only `sh`: dash on Linux forks the command, and an orphaned grandchild
   * would keep the pipes open. The output keeps the last `maxOutput` bytes.
   */
  runCommand(
    path: string,
    command: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    maxOutput = 2 * 1024 * 1024,
  ): Promise<CommandResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn("sh", ["-c", command], { cwd: path, env, detached: true });
      let output = "";
      const collect = (b: Buffer) => {
        output = (output + b.toString("utf8")).slice(-maxOutput);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, timeoutMs);
      const done = (exitCode: number | null, spawnError?: string) => {
        clearTimeout(timer);
        resolve({
          ok: exitCode === 0 && !timedOut,
          exitCode,
          timedOut,
          output,
          durationMs: Date.now() - started,
          ...(spawnError ? { spawnError } : {}),
        });
      };
      child.on("close", (code) => done(code));
      child.on("error", (err) => done(null, err.message));
    });
  }

  /** A detached worktree on `commit` for the base quality check (plan PD-106). */
  async createBaselineWorktree(
    repoRoot: string,
    projectId: string,
    commit: string,
  ): Promise<string> {
    const path = join(
      this.worktreesDir,
      projectId,
      `_base-${commit.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
    );
    mkdirSync(dirname(path), { recursive: true });
    await this.lock.run(repoRoot, () =>
      git(repoRoot, ["worktree", "add", "-q", "--detach", path, commit]),
    );
    return path;
  }

  async removeWorktree(repoRoot: string, path: string): Promise<void> {
    await this.lock.run(repoRoot, async () => {
      await git(repoRoot, ["worktree", "remove", "--force", path]).catch(() => undefined);
      rmSync(path, { recursive: true, force: true });
      await git(repoRoot, ["worktree", "prune"]).catch(() => undefined);
    });
  }

  /** `git diff --name-status base...HEAD`: status letter (A, M, D, R…) and the path. */
  async diffNameStatus(path: string, baseCommit: string): Promise<DiffEntry[]> {
    const out = await git(path, ["diff", "--name-status", "--no-renames", `${baseCommit}...HEAD`]);
    return out
      ? out.split("\n").map((l) => {
          const [status = "", ...rest] = l.split("\t");
          return { status: status.charAt(0), file: rest.join("\t") };
        })
      : [];
  }

  /** Lines added on the task branch, per file (test-tampering check, FR-121). */
  async addedLines(path: string, baseCommit: string): Promise<Map<string, string[]>> {
    const out = await git(path, ["diff", "-U0", "--no-color", `${baseCommit}...HEAD`]);
    const map = new Map<string, string[]>();
    let file: string | undefined;
    for (const line of out.split("\n")) {
      if (line.startsWith("+++ ")) {
        file = line.startsWith("+++ b/") ? line.slice(6) : undefined;
      } else if (file && line.startsWith("+")) {
        const list = map.get(file) ?? [];
        list.push(line.slice(1));
        map.set(file, list);
      }
    }
    return map;
  }

  async isDirty(path: string): Promise<boolean> {
    return (await git(path, ["status", "--porcelain"])).length > 0;
  }

  /** Commits leftovers as the configured git user. Returns the new sha, or null if clean. */
  async autoCommit(repoRoot: string, path: string, message: string): Promise<string | null> {
    return this.lock.run(repoRoot, async () => {
      if (!(await this.isDirty(path))) return null;
      await git(path, ["add", "-A"]);
      await git(path, ["commit", "-q", "--no-verify", "-m", message]);
      return git(path, ["rev-parse", "HEAD"]);
    });
  }

  /** Files changed on the task branch relative to the base commit (merge-base semantics). */
  async changedFiles(path: string, baseCommit: string): Promise<string[]> {
    const out = await git(path, ["diff", "--name-only", `${baseCommit}...HEAD`]);
    return out ? out.split("\n") : [];
  }

  /** Committed and uncommitted changes relative to the base (plan-phase check, FR-125). */
  async touchedFiles(path: string, baseCommit: string): Promise<string[]> {
    const committed = await this.changedFiles(path, baseCommit);
    // `git()` trims stdout, so porcelain status (leading space) is not used here.
    const modified = await git(path, ["diff", "--name-only", "HEAD"]);
    const untracked = await git(path, ["ls-files", "--others", "--exclude-standard"]);
    const lines = (s: string) => (s ? s.split("\n") : []);
    return [...new Set([...committed, ...lines(modified), ...lines(untracked)])].filter(Boolean);
  }

  /**
   * True when the task branch has commits of its own and they are all in `baseBranch`
   * already (FR-123: rework of a merged branch needs a new merge).
   */
  async isMergedInto(
    repoRoot: string,
    branch: string,
    baseBranch: string,
    baseCommit: string,
  ): Promise<boolean> {
    const tip = await this.resolveCommit(repoRoot, branch);
    if (!tip || tip === baseCommit) return false;
    try {
      await git(repoRoot, ["merge-base", "--is-ancestor", tip, baseBranch]);
      return true;
    } catch {
      return false;
    }
  }

  async commitsSince(path: string, baseCommit: string): Promise<CommitInfo[]> {
    const out = await git(path, ["log", "--format=%H%x00%B%x1e", `${baseCommit}..HEAD`]);
    return out
      .split("\x1e")
      .map((r) => r.replace(/^\s+/, ""))
      .filter(Boolean)
      .map((r) => {
        const [sha = "", message = ""] = r.split("\0");
        return { sha, message: message.trim() };
      });
  }

  /** Commits on the branch whose message credits an AI tool (spec FR-016). */
  async attributionViolations(
    path: string,
    baseCommit: string,
  ): Promise<{ sha: string; lines: string[] }[]> {
    const commits = await this.commitsSince(path, baseCommit);
    return commits
      .map((c) => ({ sha: c.sha, lines: findAttribution(c.message) }))
      .filter((c) => c.lines.length > 0);
  }

  /**
   * Reasons the base may be stale for the senior (spec FR-029): uncommitted changes in the
   * main working tree, or HEAD not at the base branch tip. Never throws.
   */
  async staleBaseReasons(repoRoot: string, baseBranch: string): Promise<string[]> {
    const reasons: string[] = [];
    try {
      if (await this.isDirty(repoRoot))
        reasons.push("в основном репозитории есть незакоммиченные правки — воркер их не увидит");
      const head = await this.resolveCommit(repoRoot, "HEAD");
      const base = await this.resolveCommit(repoRoot, baseBranch);
      if (head && base && head !== base)
        reasons.push(`HEAD не совпадает с ${baseBranch} — воркер работает от ${baseBranch}`);
    } catch (e) {
      if (!(e instanceof GitError)) throw e;
    }
    return reasons;
  }
}

/** First lines that look like errors, else the tail of the output. */
export function errorExcerpt(output: string, max = SETUP_EXCERPT_LINES): string {
  const lines = output.split(/\r?\n/).filter((l) => l.trim());
  const errIdx = lines.findIndex((l) => /\b(error|err!|failed|fatal|exception)\b/i.test(l));
  const slice = errIdx >= 0 ? lines.slice(errIdx, errIdx + max) : lines.slice(-max);
  return slice.join("\n");
}
