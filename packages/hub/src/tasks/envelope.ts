import type { ResultEnvelope, TaskSummaryRow } from "@pi-hub/protocol";
import { cachedShare, formatCostLine, totalInput } from "../accounting/accounting.js";
import { parseJsonList, type TaskRow, type UsageTotals } from "../storage/repos.js";

/** The senior reads only this (spec FR-017): keep it under ~2 KB. */
export const MAX_CHANGED_FILES = 50;
export const MAX_ENVELOPE_BYTES = 2048;

export function taskMinutes(
  task: Pick<TaskRow, "started_at" | "finished_at">,
  now = Date.now(),
): number {
  if (!task.started_at) return 0;
  const end = task.finished_at ? Date.parse(task.finished_at) : now;
  return Math.max(0, (end - Date.parse(task.started_at)) / 60_000);
}

export function capFiles(files: string[], max = MAX_CHANGED_FILES): string[] {
  return files.length <= max ? files : [...files.slice(0, max), `… и ещё ${files.length - max}`];
}

export function buildEnvelope(input: {
  task: TaskRow;
  usage: UsageTotals;
  sessionTotalUsd: number;
  sessionUnknownSteps?: number;
  changedFiles: string[];
  questions?: { asked: number; answered: number };
  /** Models of the task's runs in order (stage 3 FR-204); default: the task's model. */
  models?: string[];
}): ResultEnvelope {
  return fitEnvelope(rawEnvelope(input));
}

/**
 * Keeps the envelope within 2 KB (FR-127): quality issues are shortened first (the full
 * output is in `quality.log_path`), then dropped from the end, then the file list is cut.
 */
export function fitEnvelope(env: ResultEnvelope, max = MAX_ENVELOPE_BYTES): ResultEnvelope {
  const size = (e: ResultEnvelope) => Buffer.byteLength(JSON.stringify(e));
  if (size(env) <= max) return env;
  const out: ResultEnvelope = {
    ...env,
    quality: { ...env.quality, issues: [...env.quality.issues] },
  };
  for (const len of [120, 80]) {
    out.quality.issues = out.quality.issues.map((i) =>
      i.length > len ? `${i.slice(0, len - 1)}…` : i,
    );
    if (size(out) <= max) return out;
  }
  while (out.quality.issues.length > 1 && size(out) > max) out.quality.issues.pop();
  for (let n = Math.min(out.changed_files.length, 20); n >= 5 && size(out) > max; n -= 5) {
    out.changed_files = capFiles(env.changed_files, n);
  }
  return out;
}

function rawEnvelope(input: {
  task: TaskRow;
  usage: UsageTotals;
  sessionTotalUsd: number;
  sessionUnknownSteps?: number;
  changedFiles: string[];
  questions?: { asked: number; answered: number };
  /** Models of the task's runs in order (stage 3 FR-204); default: the task's model. */
  models?: string[];
}): ResultEnvelope {
  const { task, usage } = input;
  const warnings = parseJsonList(task.warnings_json);
  if (task.failure_reason) warnings.unshift(`причина: ${task.failure_reason}`);
  return {
    task_id: task.id,
    status: task.status,
    summary: task.summary ?? "",
    assumptions: parseJsonList(task.assumptions_json),
    branch: task.branch ?? "",
    changed_files: capFiles(input.changedFiles),
    quality: {
      status: task.quality_status ?? "SKIPPED",
      issues: parseJsonList(task.quality_issues_json),
      ...(task.quality_log_path ? { log_path: task.quality_log_path } : {}),
    },
    usage: {
      cost_usd: round(usage.cost, 4),
      input: totalInput(usage),
      cached_share: round(cachedShare(usage), 2),
      output: usage.output,
      minutes: round(taskMinutes(task), 1),
      ...(usage.unknown_steps ? { unknown_price_steps: usage.unknown_steps } : {}),
    },
    session_total_usd: round(input.sessionTotalUsd, 4),
    ...(input.sessionUnknownSteps
      ? { session_unknown_price_steps: input.sessionUnknownSteps }
      : {}),
    log_path: task.log_path ?? "",
    warnings,
    attempt: task.attempt,
    questions: input.questions ?? { asked: 0, answered: 0 },
    models: input.models?.length ? input.models : task.model ? [task.model] : [],
  };
}

export function costLine(
  task: TaskRow,
  usage: UsageTotals,
  sessionTotalUsd: number,
  sessionUnknownSteps = 0,
): string {
  return formatCostLine({
    usage,
    minutes: taskMinutes(task),
    quality: task.quality_status ?? "SKIPPED",
    sessionTotalUsd,
    sessionUnknownSteps,
  });
}

export function summaryRow(task: TaskRow): TaskSummaryRow {
  return {
    task_id: task.id,
    status: task.status,
    role: task.role,
    model: task.model,
    branch: task.branch,
    cost_usd: round(task.cost_usd, 4),
    minutes: round(taskMinutes(task), 1),
    created_at: task.created_at,
  };
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
