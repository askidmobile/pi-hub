import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Accounting, type PriceLookup } from "../src/accounting/accounting.js";
import { defaultExtensionPath } from "../src/assets.js";
import { resolveHubPaths } from "../src/config/paths.js";
import { HubConfig } from "../src/config/schema.js";
import { createLogger } from "../src/log.js";
import { SessionRegistry } from "../src/sessions/session-registry.js";
import { migrate, openDatabase } from "../src/storage/db.js";
import { Repos } from "../src/storage/repos.js";
import { TaskService } from "../src/tasks/task-service.js";
import { GitLock } from "../src/workspaces/git.js";
import { WorkspaceManager } from "../src/workspaces/workspace-manager.js";
import { FAKE_WORKER, initRepo } from "./helpers.js";

/** TaskService on the fake worker, shared by the task-service and question tests. */

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

export interface Harness {
  service: TaskService;
  repos: Repos;
  sessions: SessionRegistry;
  sessionId: string;
  repo: string;
  home: string;
}

export function makeHarness(
  root: string,
  opts: {
    maxWorkers?: number;
    maxUsd?: number;
    timeLimitMs?: number;
    repo?: string;
    dbFile?: string;
    /** No cost or time limit at all (stage 2 default, FR-118). */
    noLimits?: boolean;
    /** Manual prices for accounting (`prices.yaml`). */
    prices?: PriceLookup;
  } = {},
): Harness {
  const home = join(root, "h");
  const repo = opts.repo ?? join(root, "repo");
  if (!existsSync(repo)) {
    mkdirSync(repo, { recursive: true });
    initRepo(repo);
  }
  const paths = resolveHubPaths({ PI_HUB_HOME: home });
  const config = HubConfig.parse({
    allowed_repos: [git(repo, "rev-parse", "--show-toplevel")],
    roles: { code: { model: "fake/success" } },
    default_role: "code",
    limits: opts.noLimits
      ? { max_workers_hub: opts.maxWorkers ?? 2 }
      : { max_workers_hub: opts.maxWorkers ?? 2, max_task_usd: opts.maxUsd ?? 2 },
  });
  const db = openDatabase(opts.dbFile ?? join(home, "hub.db"));
  migrate(db);
  const repos = new Repos(db);
  const logger = createLogger({ file: paths.hubLog, level: "debug" });
  const service = new TaskService({
    repos,
    config,
    paths,
    secrets: {},
    wm: new WorkspaceManager(paths.worktreesDir, new GitLock()),
    accounting: new Accounting(repos, opts.prices),
    logger,
    pi: { bin: process.execPath, binArgs: [FAKE_WORKER], extensionPath: defaultExtensionPath() },
    timing: {
      ...(opts.noLimits ? {} : { timeLimitMs: opts.timeLimitMs ?? 20_000 }),
      summaryTimeoutMs: 5_000,
      stopGraceMs: 1_000,
    },
  });
  const sessions = new SessionRegistry(repos, config);
  return { service, repos, sessions, sessionId: "", repo, home };
}

export async function connect(h: Harness, mode: "on" | "off" = "on"): Promise<string> {
  const { session } = await h.sessions.connect({
    client: "claude-code",
    parent_pid: process.pid,
    cwd: h.repo,
  });
  h.sessions.setMode(session.id, mode);
  h.sessionId = session.id;
  return session.id;
}

export const start = (
  h: Harness,
  model = "fake/success",
  extra: Record<string, string | boolean> = {},
) =>
  h.service.start(h.sessionId, {
    task: "Create hello.txt",
    model,
    repo: h.repo,
    base_branch: "main",
    ...extra,
  });
