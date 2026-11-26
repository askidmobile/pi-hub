import type { QualityStatus, TaskStatus } from "./status.js";

export interface UsageSummary {
  cost_usd: number;
  input: number;
  cached_share: number;
  output: number;
  minutes: number;
}

/** The only thing the senior agent reads about a finished task. */
export interface ResultEnvelope {
  task_id: string;
  status: TaskStatus;
  summary: string;
  assumptions: string[];
  branch: string;
  changed_files: string[];
  quality: { status: QualityStatus; issues: string[] };
  usage: UsageSummary;
  session_total_usd: number;
  log_path: string;
}

/** Appended to every tool response for the owning session. */
export interface ResponseFooter {
  pending_questions?: { task_id: string; count: number }[];
  budget_warning?: { scope: "project" | "session"; used_share: number };
}
