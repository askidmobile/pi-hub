import { z } from "zod";
import type { ClientKind } from "./status.js";

/** First message from shim (or hook) to hub. */
export interface Hello {
  type: "hello";
  protocol_version: string;
  client: ClientKind;
  client_session_id?: string; // from client hooks (e.g. Claude Code session_id)
  parent_pid: number; // fallback key shared by shim and hooks of one session
  pid: number; // the shim process itself, for logs and doctor
  /** Working directory of the senior agent; the hub resolves the git root and remote itself. */
  cwd: string;
  token?: string;
}

export interface HelloAck {
  type: "hello_ack";
  protocol_version: string;
  senior_session_id: string;
  mode: "on" | "off";
}

export interface HelloReject {
  type: "hello_reject";
  reason: "incompatible_protocol" | "unauthorized" | "project_not_allowed";
  message: string;
}

/** Fast endpoint for turn-end hooks; must answer in < 100 ms. */
export interface PendingQuestionsQuery {
  type: "pending_questions";
  client_session_id?: string;
  parent_pid: number;
}

/** Runtime validation of the first line a shim sends. */
export const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol_version: z.string(),
  client: z.enum(["claude-code", "codex", "mcp"]),
  client_session_id: z.string().optional(),
  parent_pid: z.number().int(),
  pid: z.number().int(),
  cwd: z.string(),
  token: z.string().optional(),
});
