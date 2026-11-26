import { z } from "zod";

/** MCP tools visible to the senior agent. Descriptions are kept short on purpose: they cost tokens every session. */
export const StartInput = z.object({
  task: z.string().min(1),
  role: z.string().optional(),
  model: z.string().optional(),
  repo: z.string(),
  base_branch: z.string(),
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

export const DELEGATION_TOOLS = [
  "start",
  "wait",
  "status",
  "send",
  "result",
  "cancel",
  "usage_report",
] as const;
export const ALWAYS_VISIBLE_TOOLS = ["architect_mode"] as const;
