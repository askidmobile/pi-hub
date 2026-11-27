import type { QualityStatus, TaskStatus } from "./status.js";

export interface UsageSummary {
  cost_usd: number;
  input: number;
  cached_share: number;
  output: number;
  minutes: number;
  /** Steps with an unknown price, not counted in `cost_usd` (stage 2 FR-117); only when > 0. */
  unknown_price_steps?: number;
}

/** The only thing the senior agent reads about a finished task. */
export interface ResultEnvelope {
  task_id: string;
  status: TaskStatus;
  summary: string;
  assumptions: string[];
  branch: string;
  changed_files: string[];
  quality: QualityResult;
  usage: UsageSummary;
  session_total_usd: number;
  /** Session steps with an unknown price, not counted in `session_total_usd`; only when > 0. */
  session_unknown_price_steps?: number;
  log_path: string;
  /** Hub-detected problems the senior must see: empty diff, AI attribution in commits, stale base, ... */
  warnings: string[];
  /** Rework round: 1 for the first run, +1 for every `send` on a finished task. */
  attempt: number;
  questions: { asked: number; answered: number };
}

/** One row of `status`: enough to decide what to wait for, nothing more. */
export interface TaskSummaryRow {
  task_id: string;
  status: TaskStatus;
  role: string | null;
  model: string | null;
  branch: string | null;
  cost_usd: number;
  minutes: number;
  created_at: string;
}

export interface QualityResult {
  status: QualityStatus;
  /** At most 10 lines of at most 200 characters, each naming its command. */
  issues: string[];
  /** Full output of the checks; present when they ran. */
  log_path?: string;
}

/** How a question reached the hub: `ask` tool, the plan of a `clarify` task, or a question in the final text. */
export type QuestionKind = "question" | "plan" | "text";

/** An open worker question as the senior sees it (`wait`, `send`). */
export interface OpenQuestion {
  task_id: string;
  round: number;
  kind: QuestionKind;
  question: string;
  options?: string[];
}

/** Appended to every tool response for the owning session (stage 2 spec FR-107). No budgets (BD-021). */
export interface ResponseFooter {
  pending_questions?: { task_id: string; count: number }[];
}
