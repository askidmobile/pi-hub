export const TASK_STATUSES = [
  "queued",
  "planning",
  "running",
  "needs_input",
  "checking",
  "done",
  "failed",
  "cancelled",
  "interrupted",
  "orphaned",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "failed", "cancelled"]);

/** Allowed transitions; the session manager rejects anything else. */
export const TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  queued: ["planning", "running", "cancelled"],
  planning: ["needs_input", "running", "failed", "cancelled", "interrupted", "orphaned"],
  running: ["needs_input", "checking", "failed", "cancelled", "interrupted", "orphaned"],
  needs_input: ["planning", "running", "cancelled", "orphaned"],
  checking: ["done", "failed", "running", "interrupted"],
  done: [],
  failed: ["queued", "running"], // queued: escalation creates a new run; running: `send` continues the same Pi session (spec D-007)
  cancelled: [],
  interrupted: ["running", "cancelled"],
  orphaned: ["running", "planning", "cancelled"],
};

export type QualityStatus = "PASS" | "FAIL" | "SKIPPED";
export type Role = string; // roles are configured (design, analysis, code, review, docs, ...)
export type RoutedBy = "architect" | "rules" | "system_one" | "escalation";
export type DelegationMode = "on" | "off";
export type ClientKind = "claude-code" | "codex" | "mcp";
