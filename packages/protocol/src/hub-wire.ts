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

/**
 * One-shot request of a client hook (`pi-hub-shim hook stop`), sent instead of `Hello` as the
 * first line; the hub answers one `HookReply` line and closes the connection (stage 2 FR-108).
 * The hub maps `pid` to a senior session through the process ancestry (plan PD-107, PD-110).
 */
export const HookQuerySchema = z.object({
  type: z.literal("hook_query"),
  protocol_version: z.string(),
  event: z.literal("stop"),
  client: z.enum(["claude-code", "codex", "mcp"]),
  pid: z.number().int(),
  cwd: z.string(),
  stop_hook_active: z.boolean().optional(),
});
export type HookQuery = z.infer<typeof HookQuerySchema>;

/** `reason` is shown to the senior when `block` is true. */
export const HookReplySchema = z.object({
  type: z.literal("hook_reply"),
  block: z.boolean(),
  reason: z.string().max(1024).optional(),
});
export type HookReply = z.infer<typeof HookReplySchema>;

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
