import { execFile } from "node:child_process";

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly code: number | string | null,
    public readonly stderr: string,
  ) {
    super(
      `git ${args.join(" ")} failed (${code ?? "?"}): ${stderr.trim().split("\n").slice(-3).join(" | ")}`,
    );
    this.name = "GitError";
  }
}

export interface GitOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Runs git without a shell; resolves trimmed stdout. */
export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...(opts.env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException & { code?: number | string }).code ?? null;
          reject(new GitError(args, code, String(stderr || err.message)));
          return;
        }
        resolve(String(stdout).replace(/\s+$/, ""));
      },
    );
  });
}

/**
 * Serializes git operations per repository (spec FR-028): concurrent `worktree add` or
 * commits in the same repository otherwise race on index.lock / worktrees locks.
 */
export class GitLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
