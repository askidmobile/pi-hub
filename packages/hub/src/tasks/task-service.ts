import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ResultEnvelope,
  type TaskStatus,
  type TaskSummaryRow,
  TRANSITIONS,
} from "@pi-hub/protocol";
import { HubError } from "../errors.js";
import { providerKeyEnv } from "../pi-rpc/provider-env.js";
import { ModelSelectionError, resolveModel } from "../router/model-resolver.js";
import type { TaskPatch, TaskRow } from "../storage/repos.js";
import { gitTopLevel } from "../workspaces/repo.js";
import { buildEnvelope, costLine, summaryRow } from "./envelope.js";
import { type RunMode, type RunnerDeps, WorkerRun } from "./worker-runner.js";

/** Statuses in which a task is still moving on its own. */
export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "queued",
  "planning",
  "running",
  "checking",
]);

export interface StartInput {
  task: string;
  role?: string | undefined;
  model?: string | undefined;
  repo: string;
  base_branch: string;
}

export interface StartResult {
  task_id: string;
  status: TaskStatus;
  model: string;
  route_reason: string;
  warnings: string[];
}

export interface WaitResult {
  task_id: string;
  status: TaskStatus;
  summary?: string;
  cost_line?: string;
  failure_reason?: string;
}

export type TaskServiceDeps = Omit<RunnerDeps, "transition">;

export interface TaskServiceEvents {
  changed: [taskId: string, status: TaskStatus];
}

/**
 * The hub's task API (scenarios 1, 3, 4 of the stage 1 spec). The MCP facade calls only this.
 * All status changes go through `transition()`, validated against TRANSITIONS (FR-014).
 */
export class TaskService extends EventEmitter<TaskServiceEvents> {
  private readonly runs = new Map<string, WorkerRun>();
  private readonly pending = new Map<string, RunMode>();
  private closed = false;

  constructor(private readonly deps: TaskServiceDeps) {
    super();
    this.setMaxListeners(0);
  }

  // --- status machine ---

  transition(taskId: string, to: TaskStatus, patch: TaskPatch = {}): boolean {
    const task = this.deps.repos.getTask(taskId);
    if (!task) return false;
    if (!TRANSITIONS[task.status].includes(to)) {
      this.deps.logger.error(
        { task_id: taskId, from: task.status, to },
        "invalid status transition ignored",
      );
      return false;
    }
    this.deps.repos.updateTask(taskId, { ...patch, status: to });
    this.emit("changed", taskId, to);
    return true;
  }

  // --- API ---

  async start(sessionId: string, input: StartInput): Promise<StartResult> {
    const session = this.deps.repos.getSession(sessionId);
    if (!session) throw new HubError("not_found", `session ${sessionId} not found`);
    if (session.mode !== "on") {
      throw new HubError(
        "delegation_off",
        "режим архитектора выключен: включите его командой /architect on",
      );
    }
    const repoRoot = await gitTopLevel(resolve(input.repo));
    if (!repoRoot) throw new HubError("not_a_repo", `${input.repo} не git-репозиторий`);
    if (!this.deps.config.allowed_repos.includes(repoRoot)) {
      throw new HubError(
        "repo_not_allowed",
        `репозиторий ${repoRoot} не в allowed_repos (~/.pi-hub/config.yaml, pi-hub init)`,
      );
    }
    if (!(await this.deps.wm.resolveCommit(repoRoot, input.base_branch))) {
      throw new HubError("base_not_found", `ветка ${input.base_branch} не найдена в ${repoRoot}`);
    }
    let choice: ReturnType<typeof resolveModel>;
    try {
      choice = resolveModel({ model: input.model, role: input.role }, this.deps.config);
    } catch (e) {
      if (e instanceof ModelSelectionError) throw new HubError("model", e.message);
      throw e;
    }
    const keyVar = providerKeyEnv(choice.provider);
    if (keyVar && !this.deps.secrets[keyVar]) {
      throw new HubError(
        "missing_key",
        `нет ключа провайдера ${choice.provider}: задайте ${keyVar} в ~/.pi-hub/.env`,
      );
    }
    const project = this.deps.repos.upsertProject(repoRoot, null);
    const warnings = await this.deps.wm.staleBaseReasons(repoRoot, input.base_branch);
    const task = this.deps.repos.insertTask({
      owner_session_id: sessionId,
      project_id: project.id,
      task_text: input.task,
      base_branch: input.base_branch,
      role: choice.role,
      model: choice.ref,
      routed_by: choice.routedBy,
      route_reason: choice.reason,
    });
    if (warnings.length)
      this.deps.repos.updateTask(task.id, { warnings_json: JSON.stringify(warnings) });
    this.deps.logger.info(
      { task_id: task.id, senior_session_id: sessionId, model: choice.ref },
      "task created",
    );
    this.pending.set(task.id, { kind: "fresh" });
    this.pump();
    const status = this.deps.repos.getTask(task.id)?.status ?? "queued";
    return { task_id: task.id, status, model: choice.ref, route_reason: choice.reason, warnings };
  }

  status(sessionId: string): TaskSummaryRow[] {
    return this.deps.repos.listTasksByOwner(sessionId).map(summaryRow);
  }

  async result(sessionId: string, taskId: string): Promise<ResultEnvelope> {
    const task = this.owned(sessionId, taskId);
    let changed: string[] = [];
    if (task.worktree_path && task.base_commit && existsSync(task.worktree_path)) {
      changed = await this.deps.wm
        .changedFiles(task.worktree_path, task.base_commit)
        .catch(() => []);
    }
    return buildEnvelope({
      task,
      usage: this.deps.accounting.usage(task.id),
      sessionTotalUsd: this.deps.accounting.sessionTotal(sessionId),
      changedFiles: changed,
      questions: this.deps.repos.countQuestions(task.id),
    });
  }

  /** Long poll: resolves when the task leaves the active statuses or after `timeoutMs`. */
  waitFor(sessionId: string, taskId: string, timeoutMs: number): Promise<WaitResult> {
    this.owned(sessionId, taskId);
    return new Promise((resolveWait) => {
      const finish = () => {
        clearTimeout(timer);
        this.off("changed", onChange);
        resolveWait(this.waitResult(sessionId, taskId));
      };
      const onChange = (id: string, status: TaskStatus) => {
        if (id === taskId && !ACTIVE_STATUSES.has(status)) finish();
      };
      const timer = setTimeout(finish, Math.max(0, timeoutMs));
      this.on("changed", onChange);
      const now = this.deps.repos.getTask(taskId);
      if (now && !ACTIVE_STATUSES.has(now.status)) finish();
    });
  }

  waitResult(sessionId: string, taskId: string): WaitResult {
    const task = this.owned(sessionId, taskId);
    const out: WaitResult = { task_id: task.id, status: task.status };
    if (task.status === "done" || task.status === "failed") {
      out.summary = task.summary ?? "";
      out.cost_line = costLine(
        task,
        this.deps.accounting.usage(task.id),
        this.deps.accounting.sessionTotal(sessionId),
      );
    }
    if (task.failure_reason) out.failure_reason = task.failure_reason;
    return out;
  }

  /** Stops the worker (≤ grace), keeps the worktree and branch (spec scenario 3). */
  async cancel(
    sessionId: string,
    taskId: string,
  ): Promise<{ task_id: string; status: TaskStatus }> {
    const task = this.owned(sessionId, taskId);
    if (!TRANSITIONS[task.status].includes("cancelled")) {
      throw new HubError("bad_state", `задачу в статусе ${task.status} нельзя отменить`);
    }
    this.pending.delete(taskId);
    this.transition(taskId, "cancelled", { finished_at: new Date().toISOString() });
    const run = this.runs.get(taskId);
    if (run) await run.cancel();
    return { task_id: taskId, status: "cancelled" };
  }

  /** Stage 1: continue an `interrupted` or `failed` task in the same Pi session (D-007). */
  send(
    sessionId: string,
    taskId: string,
    message: string,
  ): { task_id: string; status: TaskStatus } {
    const task = this.owned(sessionId, taskId);
    if (task.status !== "interrupted" && task.status !== "failed") {
      throw new HubError(
        "bad_state",
        `send на этапе 1 продолжает только задачи interrupted или failed; статус ${task.status}`,
      );
    }
    if (this.runs.has(taskId)) throw new HubError("bad_state", "задача ещё выполняется");
    this.deps.repos.updateTask(taskId, {
      attempt: task.attempt + 1,
      failure_reason: null,
      finished_at: null,
    });
    this.pending.set(taskId, { kind: "continue", message });
    this.launch(taskId);
    return { task_id: taskId, status: this.deps.repos.getTask(taskId)?.status ?? task.status };
  }

  // --- scheduling ---

  /** Starts queued tasks while slots are free, oldest first (FR-020). */
  pump(): void {
    if (this.closed) return;
    const limit = this.deps.config.limits.max_workers_hub;
    for (const t of this.deps.repos.listTasksByStatus(["queued"])) {
      if (this.runs.size >= limit) return;
      this.launch(t.id);
    }
  }

  private launch(taskId: string): void {
    if (this.runs.has(taskId) || this.closed) return;
    const mode = this.pending.get(taskId) ?? { kind: "fresh" as const };
    this.pending.delete(taskId);
    if (!this.transition(taskId, "running", { started_at: new Date().toISOString() })) return;
    const task = this.deps.repos.getTask(taskId) as TaskRow;
    const run = new WorkerRun(
      { ...this.deps, transition: (id, to, p) => this.transition(id, to, p) },
      task,
      mode,
    );
    this.runs.set(taskId, run);
    void run.done.finally(() => {
      this.runs.delete(taskId);
      this.pump();
    });
  }

  get runningCount(): number {
    return this.runs.size;
  }

  // --- lifecycle ---

  /**
   * On daemon start (FR-022): tasks left running by a dead hub become `interrupted`;
   * queued tasks are scheduled. Stored PIDs are never signalled: Pi exits when the hub's
   * stdin pipe closes, and after a reboot the PID may belong to an unrelated process.
   */
  recover(): { interrupted: string[] } {
    const interrupted: string[] = [];
    for (const t of this.deps.repos.listTasksByStatus(["running", "planning", "checking"])) {
      if (this.runs.has(t.id)) continue;
      if (t.pid && pidAlive(t.pid)) {
        this.deps.logger.warn(
          { task_id: t.id, pid: t.pid },
          "stored worker pid is alive; not signalled",
        );
      }
      if (this.transition(t.id, "interrupted", { pid: null })) interrupted.push(t.id);
    }
    if (interrupted.length)
      this.deps.logger.warn({ interrupted }, "tasks interrupted by hub restart");
    this.pump();
    return { interrupted };
  }

  /** Graceful hub stop: running tasks become `interrupted` and can be continued with `send`. */
  async shutdown(): Promise<void> {
    this.closed = true;
    const runs = [...this.runs.entries()];
    for (const [id] of runs) this.transition(id, "interrupted", { pid: null });
    await Promise.all(runs.map(([, r]) => r.interrupt()));
  }

  private owned(sessionId: string, taskId: string): TaskRow {
    const task = this.deps.repos.getTask(taskId);
    if (!task || task.owner_session_id !== sessionId) {
      throw new HubError("not_found", `задача ${taskId} не найдена среди задач этой сессии`);
    }
    return task;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
