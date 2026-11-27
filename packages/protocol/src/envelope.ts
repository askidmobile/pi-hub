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
  /** Models that worked on the task, in order; more than one after escalation (stage 3 FR-204). */
  models: string[];
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

/** Price of a report line: a sum, or `"unknown"` when every step of it has an unknown price. */
export type ReportCost = number | "unknown";

/** One line of a `usage_report` breakdown (stage 3 FR-206, D-209). */
export interface UsageReportRow {
  /** `provider/model` or the role name. */
  name: string;
  tasks: number;
  cost_usd: ReportCost;
  /** Steps with an unknown price, not counted in `cost_usd`; only when > 0. */
  unknown_price_steps?: number;
  /** Share of checked tasks that passed on the first model's first check; null: none checked (D-215). */
  first_try_pass_share: number | null;
  /** Average cost of a task with the final PASS; null: no such task. */
  avg_cost_pass: number | null;
}

/** `usage_report`: totals and breakdowns by model and by role, at most 2 KB (stage 3 FR-206). */
export interface UsageReport {
  scope: "session" | "project" | "all";
  period: "day" | "week" | "month" | "all";
  /** ISO start of the period; null for `all`. */
  since: string | null;
  total: {
    cost_usd: number;
    /** Steps with an unknown price, not counted in `cost_usd`; only when > 0. */
    unknown_price_steps?: number;
    input: number;
    output: number;
    cached_share: number;
    tasks: number;
    /** Tasks without check commands (SKIPPED): outside the PASS shares (D-215). */
    unchecked_tasks: number;
  };
  by_model: UsageReportRow[];
  by_role: UsageReportRow[];
  /** Lines cut to fit 2 KB, the most expensive kept. */
  more?: { models?: number; roles?: number };
}
