import type { ResultEnvelope, TaskSummaryRow } from "@pi-hub/protocol";
import { cachedShare, formatCostLine, totalInput } from "../accounting/accounting.js";
import { parseJsonList, type TaskRow, type UsageTotals } from "../storage/repos.js";

/** The senior reads only this (spec FR-017): keep it under ~2 KB. */
export const MAX_CHANGED_FILES = 50;

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
  changedFiles: string[];
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
    quality: { status: task.quality_status ?? "SKIPPED", issues: [] },
    usage: {
      cost_usd: round(usage.cost, 4),
      input: totalInput(usage),
      cached_share: round(cachedShare(usage), 2),
      output: usage.output,
      minutes: round(taskMinutes(task), 1),
    },
    session_total_usd: round(input.sessionTotalUsd, 4),
    log_path: task.log_path ?? "",
    warnings,
  };
}

export function costLine(task: TaskRow, usage: UsageTotals, sessionTotalUsd: number): string {
  return formatCostLine({
    usage,
    minutes: taskMinutes(task),
    quality: task.quality_status ?? "SKIPPED",
    sessionTotalUsd,
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
