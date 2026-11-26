import { z } from "zod";

/** MCP tools visible to the senior agent. Descriptions are kept short on purpose: they cost tokens every session. */
export const StartInput = z.object({
  task: z.string().min(1),
  role: z.string().optional(),
  model: z.string().optional(),
  repo: z.string(),
  base_branch: z.string(),
  /** Worker first returns a plan and questions, works after the answer. */
  clarify: z.boolean().optional(),
});
export const WaitInput = z.object({
  task_id: z.string(),
  timeout: z.number().int().positive().max(3600),
});
export const StatusInput = z.object({ scope: z.enum(["mine", "all"]).optional() });
export const SendInput = z.object({ task_id: z.string(), message: z.string().min(1) });
export const TaskIdInput = z.object({ task_id: z.string() });
export const UsageReportInput = z.object({
  scope: z.enum(["session", "project", "all"]),
  period: z.enum(["day", "week", "month", "all"]),
});
export const ArchitectModeInput = z.object({ mode: z.enum(["on", "off"]) });

/** Delegation tools (stage 1 FR-007). `usage_report` arrives in stage 3. */
export const DELEGATION_TOOLS = ["start", "wait", "status", "result", "cancel", "send"] as const;
export type DelegationTool = (typeof DELEGATION_TOOLS)[number];
export const ALWAYS_VISIBLE_TOOLS = ["architect_mode"] as const;

/** One-line descriptions: they are paid for in every senior session. */
export const TOOL_DESCRIPTIONS: Record<DelegationTool | "architect_mode", string> = {
  architect_mode: "Turn pi-hub delegation on/off for this session (only when the user asks).",
  start: "Delegate a coding task to a cheap Pi worker in its own git branch. Returns task_id.",
  wait: "Wait for a task to finish or ask a question (long poll). If still running, call wait again.",
  status: "List this session's tasks with status and cost.",
  result: "Final envelope of a task: summary, assumptions, branch, changed files, cost, warnings.",
  cancel: "Stop a task. Its worktree and branch are kept.",
  send: "Answer a worker question, or send a finished/failed/interrupted task back for more work.",
};
