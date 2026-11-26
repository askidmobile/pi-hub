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
export function listTasks(env: NodeJS.ProcessEnv = process.env, limit = 50): TaskRow[] {
  const { db: file } = resolveHubPaths(env);
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return db
      .prepare("SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as unknown as TaskRow[];
  } finally {
    db.close();
  }
}

const COLUMNS = ["задача", "статус", "модель", "стоимость", "мин", "сессия", "текст"] as const;

export function formatTasks(tasks: TaskRow[]): string {
  if (!tasks.length) return "Задач нет.";
  const rows = tasks.map((t) => {
    const s = summaryRow(t);
    const text = t.task_text.replace(/\s+/g, " ");
    return [
      s.task_id,
      s.status,
      s.model ?? "—",
      formatUsd(s.cost_usd),
      String(s.minutes),
      t.owner_session_id.slice(0, 8),
      text.length > 48 ? `${text.slice(0, 47)}…` : text,
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
