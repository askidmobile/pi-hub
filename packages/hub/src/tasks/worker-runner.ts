import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { TaskStatus } from "@pi-hub/protocol";
import type { Logger } from "pino";
import type { Accounting } from "../accounting/accounting.js";
import { loadProjectConfig } from "../config/load.js";
import type { HubPaths } from "../config/paths.js";
import type { HubConfig } from "../config/schema.js";
import { createMasker, maskDeep } from "../log.js";
import { allowlistedEnv, buildWorkerLaunch } from "../pi-rpc/launcher.js";
import { PiExitedError, PiRpcClient } from "../pi-rpc/pi-rpc-client.js";
import { parseModelRef } from "../router/model-resolver.js";
import { parseJsonList, type Repos, type TaskPatch, type TaskRow } from "../storage/repos.js";
import type { WorkspaceManager } from "../workspaces/workspace-manager.js";
import { ensureSummary, finalizeWorkspace } from "./finalize.js";
import { writeWorkerPrompt } from "./prompt.js";

export const REPORT_ASSUMPTION_TOOL = "report_assumption";

export interface RunnerDeps {
  repos: Repos;
  config: HubConfig;
  paths: HubPaths;
  secrets: Readonly<Record<string, string>>;
  wm: WorkspaceManager;
  accounting: Accounting;
  logger: Logger;
  pi: { bin: string; binArgs?: string[]; extensionPath: string; extraExtensions?: string[] };
  /** Test hooks; production uses config limits. */
  timing?: { timeLimitMs?: number; summaryTimeoutMs?: number; stopGraceMs?: number };
  transition: (taskId: string, to: TaskStatus, patch?: TaskPatch) => boolean;
}

export type RunMode = { kind: "fresh" } | { kind: "continue"; message: string };

/**
 * One run of one task (spec FR-010..FR-027): worktree -> setup -> Pi -> events (log,
 * steps, limits, assumptions) -> agent_settled -> finalize -> done. A run never throws;
 * every failure ends in `failed` with a reason unless the task was cancelled or interrupted.
 */
export class WorkerRun {
  private client: PiRpcClient | undefined;
  private logStream: WriteStream | undefined;
  private stopReason: string | undefined;
  private cancelled = false;
  private interrupted = false;
  private timer: NodeJS.Timeout | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private readonly assumptions: string[];
  readonly done: Promise<void>;
  private readonly log: Logger;

  constructor(
    private readonly deps: RunnerDeps,
    private readonly task: TaskRow,
    private readonly mode: RunMode,
  ) {
    this.log = deps.logger.child({ task_id: task.id, senior_session_id: task.owner_session_id });
    this.assumptions = parseJsonList(task.assumptions_json);
    this.done = this.run();
  }

  get grace(): number {
    return this.deps.timing?.stopGraceMs ?? 10_000;
  }

  /** Stop for `cancel` (status already set by the service). Resolves when the process is gone. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    await this.stopProcess();
    await this.done;
  }

  /** Stop for hub shutdown: the task becomes `interrupted` and can continue later. */
  async interrupt(): Promise<void> {
    this.interrupted = true;
    await this.stopProcess();
    await this.done;
  }

  private async stopProcess(): Promise<void> {
    const c = this.client;
    if (!c || c.hasExited) return;
    await c.abort().catch(() => undefined);
    await c.stop(this.grace).catch(() => undefined);
  }

  private stopFor(reason: string): void {
    if (this.stopReason || this.cancelled || this.interrupted) return;
    this.stopReason = reason;
    this.log.warn({ reason }, "stopping worker");
    const c = this.client;
    if (!c) return;
    void c.abort().catch(() => undefined);
    this.killTimer = setTimeout(() => void c.stop(this.grace).catch(() => undefined), this.grace);
  }

  private patch(p: TaskPatch): void {
    this.deps.repos.updateTask(this.task.id, p);
  }

  private fail(reason: string): void {
    if (this.cancelled || this.interrupted) return;
    this.log.error({ reason }, "task failed");
    this.deps.transition(this.task.id, "failed", {
      failure_reason: reason,
      finished_at: new Date().toISOString(),
    });
  }

  private writeLog(record: unknown, mask: (s: string) => string): void {
    this.logStream?.write(`${JSON.stringify(maskDeep(record, mask))}\n`);
  }

  private async run(): Promise<void> {
    const { deps, task } = this;
    const project = deps.repos.getProject(task.project_id);
    if (!project) return this.fail(`project ${task.project_id} not found`);
    const mask = createMasker(Object.values(deps.secrets));
    try {
      const ws = await deps.wm.create({
        taskId: task.id,
        projectId: project.id,
        repoRoot: project.repo_root,
        baseBranch: task.base_branch ?? "HEAD",
      });
      const baseCommit = task.base_commit ?? ws.baseCommit;
      mkdirSync(deps.paths.logsDir, { recursive: true });
      const logPath = join(deps.paths.logsDir, `${task.id}.jsonl`);
      this.patch({
        worktree_path: ws.path,
        branch: ws.branch,
        base_commit: baseCommit,
        log_path: logPath,
      });
      this.logStream = createWriteStream(logPath, { flags: "a" });

      const resuming = this.mode.kind === "continue" && !!task.pi_session_path;
      const projectCfg = loadProjectConfig(project.repo_root);
      if (projectCfg.setup && !resuming) {
        const setup = await deps.wm.runSetup(ws.path, projectCfg.setup, allowlistedEnv());
        this.writeLog(
          { type: "hub_setup", ok: setup.ok, exitCode: setup.exitCode, excerpt: setup.excerpt },
          mask,
        );
        if (!setup.ok) {
          return this.fail(
            setup.timedOut
              ? "setup: превышено время"
              : `setup завершился с кодом ${setup.exitCode}: ${setup.excerpt}`,
          );
        }
      }
      if (this.cancelled || this.interrupted) return;

      const promptFile = writeWorkerPrompt(deps.paths.promptsDir, task.id, {
        branch: ws.branch,
        base_branch: task.base_branch ?? "HEAD",
      });
      const { provider, modelId } = parseModelRef(task.model ?? "");
      const client = new PiRpcClient(
        buildWorkerLaunch({
          bin: deps.pi.bin,
          ...(deps.pi.binArgs ? { binArgs: deps.pi.binArgs } : {}),
          provider,
          modelId,
          cwd: ws.path,
          sessionDir: deps.paths.sessionsDir,
          taskId: task.id,
          extensionPath: deps.pi.extensionPath,
          ...(deps.pi.extraExtensions ? { extraExtensions: deps.pi.extraExtensions } : {}),
          promptFile,
          piAgentDir: deps.paths.piAgentDir,
          secrets: deps.secrets,
        }),
      );
      this.client = client;
      client.on("record", (r) => this.writeLog(r, mask));
      client.on("parse_error", (line, error) =>
        this.writeLog({ type: "hub_parse_error", line, error }, mask),
      );
      client.on("event", (e) => {
        if (e.kind === "assistant_message") {
          const total = deps.accounting.record(task.id, e.message);
          const maxUsd = deps.config.limits.max_task_usd;
          if (maxUsd !== undefined && total !== null && total > maxUsd) {
            this.stopFor(`лимит стоимости ${maxUsd} $ превышен (${total.toFixed(3)} $)`);
          }
        } else if (e.kind === "tool_start" && e.record.toolName === REPORT_ASSUMPTION_TOOL) {
          const text = (e.record.args as { text?: unknown } | undefined)?.text;
          if (typeof text === "string" && text.trim()) {
            this.assumptions.push(text.trim());
            this.patch({ assumptions_json: JSON.stringify(this.assumptions) });
          }
        }
      });
      client.start();
      if (client.pid) this.patch({ pid: client.pid });
      const state = await client.getState();
      if (resuming && task.pi_session_path) await client.switchSession(task.pi_session_path);
      else if (state.sessionFile) this.patch({ pi_session_path: state.sessionFile });

      const message =
        this.mode.kind === "fresh"
          ? task.task_text
          : resuming
            ? this.mode.message
            : `${task.task_text}\n\n${this.mode.message}`;
      const settled = client.waitSettled();
      await client.prompt(message);
      const maxMinutes = deps.config.limits.max_task_minutes;
      const timeLimit = deps.timing?.timeLimitMs ?? (maxMinutes ? maxMinutes * 60_000 : undefined);
      if (timeLimit !== undefined) {
        this.timer = setTimeout(
          () => this.stopFor(`превышено время задачи (${Math.round(timeLimit / 60_000)} мин)`),
          timeLimit,
        );
      }
      const res = await settled;
      clearTimeout(this.timer);
      if (this.cancelled || this.interrupted) return;
      if (this.stopReason) return this.fail(this.stopReason);
      if (res.aborted) return this.fail("воркер прервал работу");

      deps.transition(task.id, "checking");
      const finalText = await ensureSummary(client, deps.timing?.summaryTimeoutMs ?? 120_000);
      const fin = await finalizeWorkspace({
        wm: deps.wm,
        taskId: task.id,
        repoRoot: project.repo_root,
        worktree: ws.path,
        baseCommit,
        finalText,
      });
      const current = deps.repos.getTask(task.id);
      const warnings = [...new Set([...parseJsonList(current?.warnings_json), ...fin.warnings])];
      deps.transition(task.id, "done", {
        summary: fin.summary,
        quality_status: "SKIPPED",
        warnings_json: JSON.stringify(warnings),
        failure_reason: null,
        finished_at: new Date().toISOString(),
      });
    } catch (e) {
      if (this.cancelled || this.interrupted) return;
      if (this.stopReason) return this.fail(this.stopReason);
      const err = e as Error;
      this.fail(err instanceof PiExitedError ? `воркер завершился: ${err.message}` : err.message);
    } finally {
      clearTimeout(this.timer);
      clearTimeout(this.killTimer);
      if (this.client && !this.client.hasExited)
        await this.client.stop(this.grace).catch(() => undefined);
      this.patch({ pid: null });
      await new Promise<void>((r) => (this.logStream ? this.logStream.end(r) : r()));
    }
  }
}
