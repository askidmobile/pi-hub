import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { TaskStatus } from "@pi-hub/protocol";
import type { Logger } from "pino";
import type { Accounting } from "../accounting/accounting.js";
import { loadProjectConfig } from "../config/load.js";
import type { HubPaths } from "../config/paths.js";
import type { HubConfig } from "../config/schema.js";
import { createMasker, maskDeep } from "../log.js";
import type { ExtensionUiRequest } from "../pi-rpc/events.js";
import { allowlistedEnv, buildWorkerLaunch } from "../pi-rpc/launcher.js";
import { PiExitedError, PiRpcClient } from "../pi-rpc/pi-rpc-client.js";
import {
  newFailures,
  type QualityGate,
  type QualityRun,
  qualityCommands,
} from "../quality/quality-gate.js";
import { escalationWarning, nextModel } from "../router/escalation.js";
import { parseModelRef } from "../router/model-resolver.js";
import {
  parseJsonList,
  type QuestionRow,
  type Repos,
  type TaskPatch,
  type TaskRow,
} from "../storage/repos.js";
import type { WorkspaceManager } from "../workspaces/workspace-manager.js";
import {
  detectTestTampering,
  ensureSummary,
  type FinalizeResult,
  finalizeWorkspace,
  qualityFixMessage,
  tamperingWarning,
} from "./finalize.js";
import { escalationMessage, planPhaseMessage, writeWorkerPrompt } from "./prompt.js";
import {
  answerAsMessage,
  DIALOG_METHODS,
  detectTextQuestion,
  parseAskDialog,
} from "./questions.js";

export const REPORT_ASSUMPTION_TOOL = "report_assumption";
export const SECOND_TRY_WARNING = "проверка прошла со второй попытки";

export interface RunnerDeps {
  repos: Repos;
  config: HubConfig;
  paths: HubPaths;
  secrets: Readonly<Record<string, string>>;
  wm: WorkspaceManager;
  accounting: Accounting;
  quality: QualityGate;
  logger: Logger;
  pi: { bin: string; binArgs?: string[]; extensionPath: string; extraExtensions?: string[] };
  /** Test hooks; production uses config limits. */
  timing?: {
    timeLimitMs?: number;
    summaryTimeoutMs?: number;
    stopGraceMs?: number;
    qualityTimeoutMs?: number;
  };
  transition: (taskId: string, to: TaskStatus, patch?: TaskPatch) => boolean;
}

/**
 * `continue` may escalate only when the task was interrupted mid-run; a `send` on a
 * finished or failed task reworks on the model it ended on (stage 3 FR-203).
 */
export type RunMode =
  | { kind: "fresh"; clarify?: boolean }
  | { kind: "continue"; message: string; escalate?: boolean };

/**
 * One run of one task (spec FR-010..FR-027): worktree -> setup -> Pi -> events (log,
 * steps, limits, assumptions) -> agent_settled -> finalize -> done. A run never throws;
 * every failure ends in `failed` with a reason unless the task was cancelled or interrupted.
 *
 * Stage 2 (plan PD-103): the Pi process lives while the task waits for an answer. A question
 * from `ask` keeps its dialog open and is answered with `extension_ui_response`; a plan
 * without `ask` and a question in the final text (FR-120) are answered with a new `prompt`
 * in the same process. The time limit, if set, does not count time in `needs_input`.
 */
export class WorkerRun {
  private client: PiRpcClient | undefined;
  private logStream: WriteStream | undefined;
  private stopReason: string | undefined;
  private cancelled = false;
  private interrupted = false;
  private timer: NodeJS.Timeout | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private timeLimitMs: number | undefined;
  private timeUsedMs = 0;
  private timeSegmentStart: number | undefined;
  private worktree: { path: string; baseCommit: string } | undefined;
  /** Pi dialog id of the open `ask`, answered with `extension_ui_response`. */
  private dialogId: string | undefined;
  /** Waiting for an answer that goes to the worker as a new prompt. */
  private pendingAnswer: ((message: string | null) => void) | undefined;
  private exitWhileWaiting: PiExitedError | undefined;
  private isWaiting = false;
  /** The model run of the live Pi process (stage 3 FR-205). */
  private runSeq: number | undefined;
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

  /** True while the task is in `needs_input`: such a run does not hold a worker slot (PD-101). */
  get waiting(): boolean {
    return this.isWaiting;
  }

  /** Whether `answer()` can deliver to the live worker. */
  get canAnswer(): boolean {
    return this.isWaiting && (this.dialogId !== undefined || this.pendingAnswer !== undefined);
  }

  /**
   * Delivers the architect's answer to the open question (FR-104): as the result of `ask`,
   * or as a new prompt. The question is closed and the task returns to its status.
   */
  answer(question: QuestionRow, text: string): void {
    if (!this.canAnswer) throw new Error(`task ${this.task.id} is not waiting for an answer`);
    this.deps.repos.answerQuestion(question.id, text, "senior");
    this.isWaiting = false;
    this.deps.transition(this.task.id, question.resume_status ?? "running");
    this.log.info({ question_id: question.id }, "question answered");
    if (this.dialogId !== undefined && question.pi_dialog_id === this.dialogId) {
      const id = this.dialogId;
      this.dialogId = undefined;
      this.resumeTimer();
      this.client?.respondUi(id, text);
      return;
    }
    const resolve = this.pendingAnswer;
    this.pendingAnswer = undefined;
    resolve?.(answerAsMessage(question, text));
  }

  /** Stop for `cancel` (status already set by the service). Resolves when the process is gone. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.releaseWait();
    await this.stopProcess();
    await this.done;
  }

  /** Stop for hub shutdown: the task becomes `interrupted` and can continue later. */
  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.releaseWait();
    await this.stopProcess();
    await this.done;
  }

  private releaseWait(): void {
    const resolve = this.pendingAnswer;
    this.pendingAnswer = undefined;
    resolve?.(null);
  }

  // --- time limit (FR-118): counts only time outside needs_input ---

  private resumeTimer(): void {
    if (this.timeLimitMs === undefined || this.timeSegmentStart !== undefined) return;
    const limit = this.timeLimitMs;
    this.timeSegmentStart = Date.now();
    this.timer = setTimeout(
      () => this.stopFor(`превышено время задачи (${Math.round(limit / 60_000)} мин)`),
      Math.max(0, limit - this.timeUsedMs),
    );
  }

  private pauseTimer(): void {
    if (this.timeSegmentStart === undefined) return;
    this.timeUsedMs += Date.now() - this.timeSegmentStart;
    this.timeSegmentStart = undefined;
    clearTimeout(this.timer);
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
    const open = this.deps.repos.openQuestion(this.task.id);
    if (open) this.deps.repos.closeQuestion(open.id);
    this.deps.transition(this.task.id, "failed", {
      failure_reason: reason,
      finished_at: new Date().toISOString(),
    });
  }

  private writeLog(record: unknown, mask: (s: string) => string): void {
    this.logStream?.write(`${JSON.stringify(maskDeep(record, mask))}\n`);
  }

  // --- questions ---

  /** Extension UI request from Pi: the pi-hub `ask` becomes a question, other dialogs are refused. */
  private onUiRequest(req: ExtensionUiRequest): void {
    if (!DIALOG_METHODS.has(req.method)) return; // notify, setStatus, ...: nothing to answer
    const ask = parseAskDialog(req);
    if (!ask) {
      this.log.warn({ method: req.method, title: req.title }, "foreign extension dialog refused");
      this.refuse(req.id);
      return;
    }
    void this.onAsk(req.id, ask.question, ask.options).catch((e: Error) => {
      this.log.error({ err: e.message }, "ask handling failed");
      this.refuse(req.id);
    });
  }

  private refuse(dialogId: string): void {
    try {
      this.client?.respondUi(dialogId, null);
    } catch {
      // the process is gone
    }
  }

  private async onAsk(dialogId: string, text: string, options?: string[]): Promise<void> {
    const { repos } = this.deps;
    const status = repos.getTask(this.task.id)?.status;
    // One question at a time (FR-115); a question outside planning/running has nowhere to go.
    if (
      (status !== "running" && status !== "planning") ||
      this.dialogId !== undefined ||
      this.pendingAnswer !== undefined ||
      repos.openQuestion(this.task.id)
    ) {
      this.log.warn({ status }, "ask refused: not accepting a question now");
      this.refuse(dialogId);
      return;
    }
    this.dialogId = dialogId;
    const kind = status === "planning" ? "plan" : "question";
    const question = kind === "plan" ? await this.withPlanWarning(text) : text;
    if (this.cancelled || this.interrupted || this.stopReason) {
      this.dialogId = undefined;
      this.refuse(dialogId);
      return;
    }
    this.raise(kind, question, options, dialogId);
  }

  /** Records the question and moves the task to `needs_input` (FR-102). */
  private raise(
    kind: "plan" | "question" | "text",
    text: string,
    options: string[] | undefined,
    dialogId: string | null,
  ): void {
    const q = this.deps.repos.insertQuestion({
      task_id: this.task.id,
      kind,
      text,
      options,
      pi_dialog_id: dialogId,
      // The plan's answer starts the implementation (D-108).
      resume_status: "running",
    });
    this.pauseTimer();
    this.isWaiting = true;
    this.log.info({ question_id: q.id, kind }, "worker asked a question");
    if (!this.deps.transition(this.task.id, "needs_input")) {
      this.isWaiting = false;
      this.dialogId = undefined;
      this.deps.repos.closeQuestion(q.id);
      if (dialogId) this.refuse(dialogId);
      this.resumeTimer();
    }
  }

  /** A question answered with a new prompt; resolves to that prompt, or null when stopped. */
  private waitForPromptAnswer(kind: "plan" | "text", text: string): Promise<string | null> {
    return new Promise((resolve) => {
      this.pendingAnswer = resolve;
      this.raise(kind, text, undefined, null);
      if (!this.isWaiting) {
        this.pendingAnswer = undefined;
        resolve(null);
      }
    });
  }

  /** Files changed during the plan phase are reported with the plan (FR-125). */
  private async withPlanWarning(text: string): Promise<string> {
    const wt = this.worktree;
    if (!wt) return text;
    const files = await this.deps.wm.touchedFiles(wt.path, wt.baseCommit).catch(() => []);
    if (!files.length) return text;
    const list = files.slice(0, 10).join(", ") + (files.length > 10 ? ", …" : "");
    return `${text}\n\n⚠ в фазе плана изменены файлы: ${list}`;
  }

  /**
   * Prompts the worker and handles its questions until it finishes without one (plan without
   * `ask`, text question FR-120). False when the run is over (failed, cancelled, interrupted).
   */
  private async converse(client: PiRpcClient, first: string): Promise<boolean> {
    const { deps, task } = this;
    let message = first;
    for (;;) {
      const settled = client.waitSettled();
      await client.prompt(message);
      this.resumeTimer();
      const res = await settled;
      this.pauseTimer();
      if (this.cancelled || this.interrupted) return false;
      if (this.stopReason) {
        this.fail(this.stopReason);
        return false;
      }
      if (res.aborted) {
        this.fail("воркер прервал работу");
        return false;
      }
      const text = await client.getLastAssistantText();
      const status = deps.repos.getTask(task.id)?.status;
      let question: { kind: "plan" | "text"; text: string } | undefined;
      if (status === "planning") {
        const plan = text?.trim() || "(воркер закончил фазу плана без текста)";
        question = { kind: "plan", text: await this.withPlanWarning(plan) };
      } else {
        const tq = detectTextQuestion(text);
        if (tq) question = { kind: "text", text: tq };
      }
      if (!question) return true;
      const answer = await this.waitForPromptAnswer(question.kind, question.text);
      if (answer === null) {
        if (this.cancelled || this.interrupted) return false;
        throw this.exitWhileWaiting ?? new Error("ожидание ответа прервано");
      }
      message = answer;
    }
  }

  /** `checking`: summary, auto-commit, attribution and diff warnings (FR-016, FR-026). */
  private async finalize(
    client: PiRpcClient,
    repoRoot: string,
    worktree: string,
    baseCommit: string,
  ): Promise<FinalizeResult> {
    this.deps.transition(this.task.id, "checking");
    const finalText = await ensureSummary(client, this.deps.timing?.summaryTimeoutMs ?? 120_000);
    return finalizeWorkspace({
      wm: this.deps.wm,
      taskId: this.task.id,
      repoRoot,
      worktree,
      baseCommit,
      finalText,
    });
  }

  /**
   * Starts Pi on `model` in the worktree and wires its events: log, steps and the cost
   * limit, assumptions, dialogs. Escalation calls it again for the next model (PD-205).
   */
  private async launchPi(
    model: string,
    opts: { cwd: string; promptFile: string; mask: (s: string) => string; resuming: boolean },
  ): Promise<PiRpcClient> {
    const { deps, task } = this;
    const { provider, modelId } = parseModelRef(model);
    const client = new PiRpcClient(
      buildWorkerLaunch({
        bin: deps.pi.bin,
        ...(deps.pi.binArgs ? { binArgs: deps.pi.binArgs } : {}),
        provider,
        modelId,
        cwd: opts.cwd,
        sessionDir: deps.paths.sessionsDir,
        taskId: task.id,
        extensionPath: deps.pi.extensionPath,
        ...(deps.pi.extraExtensions ? { extraExtensions: deps.pi.extraExtensions } : {}),
        promptFile: opts.promptFile,
        piAgentDir: deps.paths.piAgentDir,
        secrets: deps.secrets,
      }),
    );
    this.client = client;
    const mask = opts.mask;
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
      } else if (e.kind === "ui_request") {
        this.onUiRequest(e.record);
      }
    });
    client.on("exit", (err) => {
      if (!this.pendingAnswer || this.client !== client) return;
      this.exitWhileWaiting = err;
      this.releaseWait();
    });
    client.start();
    if (client.pid) this.patch({ pid: client.pid });
    const state = await client.getState();
    if (opts.resuming && task.pi_session_path) await client.switchSession(task.pi_session_path);
    else if (state.sessionFile) this.patch({ pi_session_path: state.sessionFile });
    return client;
  }

  /** Ends the Pi process of a model before the next one starts (escalation). */
  private async stopPi(client: PiRpcClient): Promise<void> {
    if (!client.hasExited) await client.stop(this.grace).catch(() => undefined);
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
      this.worktree = { path: ws.path, baseCommit };

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
      let model = task.model ?? "";
      let client = await this.launchPi(model, { cwd: ws.path, promptFile, mask, resuming });
      if (this.cancelled || this.interrupted) return;
      // The model run of this launch (FR-205): a fresh task opens run 1, a continued task
      // goes on with its last run (the model it ended on).
      let runSeq: number =
        deps.repos.modelRuns(task.id).at(-1)?.seq ??
        deps.repos.startModelRun(task.id, {
          model,
          routed_by: task.routed_by ?? "rules",
          reason: task.route_reason,
        });
      this.runSeq = runSeq;
      // `send` on done/failed reworks on the same model without escalation (FR-203).
      const mayEscalate = this.mode.kind === "fresh" || this.mode.escalate === true;
      const firstTry = this.mode.kind === "fresh" && task.attempt === 1 && runSeq === 1;

      const message: string =
        this.mode.kind === "fresh"
          ? this.mode.clarify
            ? planPhaseMessage(task.task_text)
            : task.task_text
          : resuming
            ? this.mode.message
            : `${task.task_text}\n\n${this.mode.message}`;
      const maxMinutes = deps.config.limits.max_task_minutes;
      this.timeLimitMs = deps.timing?.timeLimitMs ?? (maxMinutes ? maxMinutes * 60_000 : undefined);

      const qInput = {
        taskId: task.id,
        projectId: project.id,
        repoRoot: project.repo_root,
        worktree: ws.path,
        baseCommit,
        project: projectCfg,
      };
      // The base check runs while the worker works (plan PD-106).
      if (qualityCommands(projectCfg).length) void deps.quality.baseline(qInput);

      if (!(await this.converse(client, message))) return;

      const warnings: string[] = [];
      let fin: FinalizeResult;
      let quality: QualityRun;
      let round = 0;
      for (;;) {
        fin = await this.finalize(client, project.repo_root, ws.path, baseCommit);
        warnings.push(...fin.warnings);
        quality = await deps.quality.check({ ...qInput, attempt: task.attempt, round: ++round });
        // PASS on the first check of the first model; SKIPPED stays unknown (D-215).
        if (firstTry && round === 1) {
          deps.repos.setFirstTryPass(
            task.id,
            quality.status === "SKIPPED" ? null : quality.status === "PASS",
          );
        }
        // One automatic fix round for errors that did not exist on the base (FR-113, D-101).
        if (quality.status === "FAIL" && newFailures(quality).length) {
          this.log.info({ issues: quality.issues.length }, "quality failed: automatic fix round");
          deps.transition(task.id, "running");
          if (!(await this.converse(client, qualityFixMessage(quality.issues, quality.logPath))))
            return;
          fin = await this.finalize(client, project.repo_root, ws.path, baseCommit);
          warnings.push(...fin.warnings);
          quality = await deps.quality.check({ ...qInput, attempt: task.attempt, round: ++round });
          if (quality.status === "PASS") warnings.push(SECOND_TRY_WARNING);
        }
        deps.repos.finishModelRun(task.id, runSeq, quality.status);
        // Escalation (FR-202): still FAIL on a new error -> the next model of the role's chain.
        const next =
          mayEscalate && quality.status === "FAIL" && newFailures(quality).length
            ? nextModel(
                deps.repos.getTask(task.id) ?? task,
                deps.repos.modelRuns(task.id),
                deps.config,
              )
            : null;
        if (!next) break;
        this.log.info({ from: model, to: next }, "escalating to the next model");
        warnings.push(escalationWarning(model, next));
        await this.stopPi(client);
        if (this.cancelled || this.interrupted) return;
        const reason = `escalation after FAIL on ${model}`;
        runSeq = deps.repos.startModelRun(task.id, {
          model: next,
          routed_by: "escalation",
          reason,
        });
        this.runSeq = runSeq;
        this.patch({ model: next, routed_by: "escalation", route_reason: reason });
        deps.transition(task.id, "running");
        model = next;
        client = await this.launchPi(model, { cwd: ws.path, promptFile, mask, resuming: false });
        if (this.cancelled || this.interrupted) return;
        if (
          !(await this.converse(
            client,
            escalationMessage(task.task_text, fin.summary, quality.issues, quality.logPath),
          ))
        )
          return;
      }
      const tampered = tamperingWarning(
        detectTestTampering(
          await deps.wm.diffNameStatus(ws.path, baseCommit),
          await deps.wm.addedLines(ws.path, baseCommit),
        ),
      );
      if (tampered) warnings.push(tampered);

      const current = deps.repos.getTask(task.id);
      const all = [...new Set([...parseJsonList(current?.warnings_json), ...warnings])];
      deps.transition(task.id, "done", {
        summary: fin.summary,
        quality_status: quality.status,
        quality_issues_json: JSON.stringify(quality.issues),
        quality_log_path: quality.logPath,
        warnings_json: JSON.stringify(all),
        failure_reason: null,
        finished_at: new Date().toISOString(),
      });
    } catch (e) {
      if (this.cancelled || this.interrupted) return;
      if (this.stopReason) return this.fail(this.stopReason);
      const err = e as Error;
      this.fail(err instanceof PiExitedError ? `воркер завершился: ${err.message}` : err.message);
    } finally {
      this.pauseTimer();
      clearTimeout(this.timer);
      clearTimeout(this.killTimer);
      if (this.client && !this.client.hasExited)
        await this.client.stop(this.grace).catch(() => undefined);
      this.patch({ pid: null });
      // A run cut short (failed, cancelled, interrupted) still gets its end time.
      const open = this.deps.repos.modelRuns(this.task.id).find((r) => r.seq === this.runSeq);
      if (open && !open.finished_at) this.deps.repos.finishModelRun(this.task.id, open.seq, null);
      await new Promise<void>((r) => (this.logStream ? this.logStream.end(r) : r()));
    }
  }
}
