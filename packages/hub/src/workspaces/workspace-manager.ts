import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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
    return new Promise((resolve) => {
      // Own process group: on timeout the whole tree is killed, not only `sh` (dash on Linux
      // forks the command, and an orphaned grandchild would keep the pipes open).
      const child = spawn("sh", ["-c", command], { cwd: path, env, detached: true });
      let output = "";
      const collect = (b: Buffer) => {
        output = (output + b.toString("utf8")).slice(-256 * 1024);
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
      child.on("close", (code) => {
        clearTimeout(timer);
        const ok = code === 0 && !timedOut;
        resolve({ ok, exitCode: code, excerpt: ok ? "" : errorExcerpt(output), timedOut });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, exitCode: null, excerpt: err.message, timedOut: false });
      });
    });
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
