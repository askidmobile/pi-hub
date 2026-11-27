import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { QualityStatus } from "@pi-hub/protocol";
import type { Logger } from "pino";
import type { ProjectConfig } from "../config/schema.js";
import { allowlistedEnv } from "../pi-rpc/launcher.js";
import type { Repos } from "../storage/repos.js";
import { GitLock } from "../workspaces/git.js";
import { errorExcerpt, type WorkspaceManager } from "../workspaces/workspace-manager.js";

/**
 * Quality gate (stage 2 spec FR-111, FR-112, FR-114, FR-119; ADR-0012).
 * The project's commands run whole, one after another, in the task worktree with the
 * allowlisted environment. Checks of one project are serialized; the base commit is checked
 * once per project and commit in a temporary worktree, so errors that existed before the
 * task do not trigger the automatic fix round.
 */

export const QUALITY_COMMANDS = ["test", "lint", "typecheck"] as const;
export type QualityCommand = (typeof QUALITY_COMMANDS)[number];

export const MAX_ISSUES = 10;
export const MAX_ISSUE_CHARS = 200;
export const NO_COMMANDS_ISSUE = "команды проверки не заданы в .pi-hub.toml";

export interface CommandOutcome {
  name: QualityCommand;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** The command fails on the base commit too (FR-119). */
  failedOnBase: boolean;
  ok: boolean;
}

export interface QualityRun {
  status: QualityStatus;
  commands: CommandOutcome[];
  issues: string[];
  logPath: string | null;
}

export interface QualityCheckInput {
  taskId: string;
  projectId: string;
  repoRoot: string;
  worktree: string;
  baseCommit: string;
  project: ProjectConfig;
  /** Shown in the log: 1 = first check, 2 = after the fix round, ... */
  attempt: number;
}

export interface QualityGateDeps {
  wm: WorkspaceManager;
  repos: Repos;
  logsDir: string;
  logger: Logger;
  /** Test hook: overrides `quality.timeout_minutes`. */
  timeoutMs?: number | undefined;
}

export function qualityCommands(project: ProjectConfig): [QualityCommand, string][] {
  const q = project.quality;
  if (!q) return [];
  return QUALITY_COMMANDS.flatMap((name) => {
    const cmd = q[name];
    return cmd ? [[name, cmd] as [QualityCommand, string]] : [];
  });
}

/** Commands that failed in the task but passed (or were unknown) on the base: fixable now. */
export function newFailures(run: QualityRun): CommandOutcome[] {
  return run.commands.filter((c) => !c.ok && !c.failedOnBase);
}

export class QualityGate {
  private readonly projectLock = new GitLock();
  private readonly baselines = new Map<string, Promise<Map<string, boolean>>>();

  constructor(private readonly deps: QualityGateDeps) {}

  private timeoutMs(project: ProjectConfig): number {
    return this.deps.timeoutMs ?? (project.quality?.timeout_minutes ?? 15) * 60_000;
  }

  /**
   * Which commands fail on the base commit. Cached in `quality_baselines` and deduplicated in
   * memory; may be started early, while the worker works (plan PD-106).
   */
  baseline(
    input: Omit<QualityCheckInput, "taskId" | "worktree" | "attempt">,
  ): Promise<Map<string, boolean>> {
    const commands = qualityCommands(input.project);
    const key = `${input.projectId}\0${input.baseCommit}\0${commands.map((c) => c[1]).join("\0")}`;
    let p = this.baselines.get(key);
    if (!p) {
      p = this.computeBaseline(input, commands).catch((e: Error) => {
        this.deps.logger.warn(
          { project_id: input.projectId, err: e.message },
          "base quality check failed to run; treating base as passing",
        );
        this.baselines.delete(key);
        return new Map<string, boolean>();
      });
      this.baselines.set(key, p);
    }
    return p;
  }

  private async computeBaseline(
    input: Omit<QualityCheckInput, "taskId" | "worktree" | "attempt">,
    commands: [QualityCommand, string][],
  ): Promise<Map<string, boolean>> {
    const { repos, wm } = this.deps;
    const known = new Map(
      repos.getBaseline(input.projectId, input.baseCommit).map((r) => [r.command, r] as const),
    );
    const missing = commands.filter(([name]) => !known.has(name));
    if (missing.length) {
      await this.projectLock.run(input.projectId, async () => {
        const path = await wm.createBaselineWorktree(
          input.repoRoot,
          input.projectId,
          input.baseCommit,
        );
        try {
          const env = allowlistedEnv();
          const timeout = this.timeoutMs(input.project);
          if (input.project.setup) {
            const setup = await wm.runSetup(path, input.project.setup, env, timeout);
            // Without dependencies the base result says nothing: leave it unknown.
            if (!setup.ok) return;
          }
          for (const [name, cmd] of missing) {
            const r = await wm.runCommand(path, cmd, env, timeout);
            const row = {
              project_id: input.projectId,
              base_commit: input.baseCommit,
              command: name,
              exit_code: r.exitCode,
              timed_out: r.timedOut ? 1 : 0,
            };
            repos.putBaseline(row);
            known.set(name, { ...row, checked_at: "" });
          }
        } finally {
          await wm.removeWorktree(input.repoRoot, path);
        }
      });
    }
    const failed = new Map<string, boolean>();
    for (const [name] of commands) {
      const row = known.get(name);
      if (row) failed.set(name, row.timed_out === 1 || row.exit_code !== 0);
    }
    return failed;
  }

  /** Runs the commands in the task worktree; returns the verdict (FR-112). */
  async check(input: QualityCheckInput): Promise<QualityRun> {
    const commands = qualityCommands(input.project);
    if (!commands.length) {
      return { status: "SKIPPED", commands: [], issues: [NO_COMMANDS_ISSUE], logPath: null };
    }
    const base = await this.baseline(input);
    return this.projectLock.run(input.projectId, async () => {
      mkdirSync(this.deps.logsDir, { recursive: true });
      const logPath = join(this.deps.logsDir, `${input.taskId}.quality.log`);
      const env = allowlistedEnv();
      const timeout = this.timeoutMs(input.project);
      const outcomes: CommandOutcome[] = [];
      const excerpts = new Map<QualityCommand, string>();
      for (const [name, cmd] of commands) {
        const r = await this.deps.wm.runCommand(input.worktree, cmd, env, timeout);
        const outcome: CommandOutcome = {
          name,
          command: cmd,
          exitCode: r.exitCode,
          timedOut: r.timedOut,
          durationMs: r.durationMs,
          failedOnBase: !r.ok && base.get(name) === true,
          ok: r.ok,
        };
        outcomes.push(outcome);
        if (!r.ok) excerpts.set(name, r.spawnError ?? errorExcerpt(r.output, MAX_ISSUES));
        appendFileSync(
          logPath,
          `=== attempt ${input.attempt} · ${name}: ${cmd} · ${
            r.timedOut ? "timed out" : `exit ${r.exitCode ?? "?"}`
          } · ${(r.durationMs / 1000).toFixed(1)} s ===\n${r.output}${
            r.output.endsWith("\n") || !r.output ? "" : "\n"
          }`,
        );
      }
      const status: QualityStatus = outcomes.every((o) => o.ok) ? "PASS" : "FAIL";
      this.deps.logger.info(
        { task_id: input.taskId, attempt: input.attempt, status },
        "quality check finished",
      );
      return {
        status,
        commands: outcomes,
        issues: buildIssues(outcomes, excerpts, timeout),
        logPath,
      };
    });
  }
}

/** At most 10 lines of at most 200 chars, each prefixed with the command (FR-112). */
export function buildIssues(
  outcomes: CommandOutcome[],
  excerpts: Map<QualityCommand, string>,
  timeoutMs: number,
): string[] {
  const failed = outcomes.filter((o) => !o.ok);
  const heads: string[][] = failed.map((o) => {
    const lines: string[] = [];
    if (o.failedOnBase) lines.push(`${o.name}: падало до задачи: ${o.command}`);
    if (o.timedOut)
      lines.push(`${o.name}: превышено время (${Math.max(1, Math.round(timeoutMs / 60_000))} мин)`);
    else if (!o.failedOnBase) lines.push(`${o.name}: код ${o.exitCode ?? "?"}`);
    const detail = (excerpts.get(o.name) ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => `${o.name}: ${l}`);
    return [...lines, ...detail];
  });
  // Round-robin so that every failed command is visible within the limit.
  const out: string[] = [];
  for (let i = 0; out.length < MAX_ISSUES && heads.some((h) => i < h.length); i++) {
    for (const h of heads) {
      const line = h[i];
      if (line !== undefined && out.length < MAX_ISSUES) out.push(cap(line));
    }
  }
  return out;
}

function cap(line: string): string {
  return line.length > MAX_ISSUE_CHARS ? `${line.slice(0, MAX_ISSUE_CHARS - 1)}…` : line;
}
