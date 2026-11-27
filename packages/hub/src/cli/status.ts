import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { formatUsd } from "../accounting/accounting.js";
import { resolveHubPaths } from "../config/paths.js";
import type { TaskRow } from "../storage/repos.js";
import { summaryRow } from "../tasks/envelope.js";

/**
 * `pi-hub status` (spec FR-040): tasks of every session, for a human in a terminal.
 * Opens the database read-only: only the daemon writes it (AGENTS.md principle 5).
 */
/** A task with its open question, if any (stage 2 FR-130). */
export type StatusRow = TaskRow & {
  question_text?: string | null;
  question_asked_at?: string | null;
  /** Model of the latest run and the number of runs (stage 3 FR-230). */
  last_model?: string | null;
  model_runs?: number;
};

export function listTasks(env: NodeJS.ProcessEnv = process.env, limit = 50): StatusRow[] {
  const { db: file } = resolveHubPaths(env);
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return db
      .prepare(
        `SELECT t.*, q.text AS question_text, q.asked_at AS question_asked_at,
           (SELECT r.model FROM task_model_runs r WHERE r.task_id = t.id
            ORDER BY r.seq DESC LIMIT 1) AS last_model,
           (SELECT COUNT(*) FROM task_model_runs r WHERE r.task_id = t.id) AS model_runs
         FROM tasks t
         LEFT JOIN questions q ON q.task_id = t.id AND q.answered_at IS NULL
         ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      )
      .all(limit) as unknown as StatusRow[];
  } finally {
    db.close();
  }
}

const COLUMNS = ["задача", "статус", "модель", "стоимость", "мин", "сессия", "текст"] as const;

/** «? <question> · ждёт 12 мин» for a task in needs_input, at most 80 chars of question. */
export function questionCell(t: StatusRow, now = Date.now()): string | null {
  if (t.status !== "needs_input" || !t.question_text) return null;
  const q = t.question_text.replace(/\s+/g, " ").trim();
  const text = q.length > 80 ? `${q.slice(0, 79)}…` : q;
  const minutes = t.question_asked_at
    ? Math.max(0, Math.round((now - Date.parse(t.question_asked_at)) / 60_000))
    : 0;
  return `? ${text} · ждёт ${minutes < 1 ? "<1" : minutes} мин`;
}

/** Model of the latest run, one «↑» per escalation: «9router/glm-5.3-flash ↑» (FR-230). */
export function modelCell(t: StatusRow): string {
  const model = t.last_model ?? t.model;
  if (!model) return "—";
  const escalations = Math.max(0, (t.model_runs ?? 0) - 1);
  return escalations ? `${model} ${"↑".repeat(escalations)}` : model;
}

export function formatTasks(tasks: StatusRow[]): string {
  if (!tasks.length) return "Задач нет.";
  const rows = tasks.map((t) => {
    const s = summaryRow(t);
    const text = t.task_text.replace(/\s+/g, " ");
    return [
      s.task_id,
      s.status,
      modelCell(t),
      formatUsd(s.cost_usd),
      String(s.minutes),
      t.owner_session_id.slice(0, 8),
      questionCell(t) ?? (text.length > 48 ? `${text.slice(0, 47)}…` : text),
    ];
  });
  const widths = COLUMNS.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(COLUMNS), ...rows.map(line)].join("\n");
}
