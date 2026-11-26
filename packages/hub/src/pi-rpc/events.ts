import { z } from "zod";

/**
 * zod schemas for the subset of Pi RPC records the hub relies on (Pi 1.6.1,
 * verified against test/fixtures/pi-session-success.jsonl). Unknown fields pass
 * through; unknown record types are kept as `other`.
 */

export const PiUsage = z.looseObject({
  input: z.number().default(0),
  output: z.number().default(0),
  cacheRead: z.number().default(0),
  cacheWrite: z.number().default(0),
  totalTokens: z.number().optional(),
  cost: z
    .looseObject({
      total: z.number().default(0),
      totalFromProvider: z.boolean().optional(),
    })
    .optional(),
});
export type PiUsage = z.infer<typeof PiUsage>;

export const AssistantMessage = z.looseObject({
  role: z.literal("assistant"),
  provider: z.string().optional(),
  model: z.string().optional(),
  stopReason: z.string().optional(),
  durationMs: z.number().optional(),
  usage: PiUsage.optional(),
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const RpcResponse = z.looseObject({
  type: z.literal("response"),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type RpcResponse = z.infer<typeof RpcResponse>;

export const ToolExecutionStart = z.looseObject({
  type: z.literal("tool_execution_start"),
  toolCallId: z.string(),
  toolName: z.string(),
  args: z.unknown().optional(),
});

export const ToolExecutionEnd = z.looseObject({
  type: z.literal("tool_execution_end"),
  toolCallId: z.string(),
  toolName: z.string(),
  isError: z.boolean().optional(),
  durationMs: z.number().optional(),
});

export const AgentSettled = z.looseObject({
  type: z.literal("agent_settled"),
  aborted: z.boolean().optional(),
});

export const ExtensionUiRequest = z.looseObject({
  type: z.literal("extension_ui_request"),
  id: z.string(),
  method: z.string(),
  title: z.string().optional(),
  message: z.string().optional(),
  options: z.array(z.string()).optional(),
});
export type ExtensionUiRequest = z.infer<typeof ExtensionUiRequest>;

export type PiEvent =
  | { kind: "response"; record: RpcResponse }
  | { kind: "assistant_message"; message: AssistantMessage }
  | { kind: "tool_start"; record: z.infer<typeof ToolExecutionStart> }
  | { kind: "tool_end"; record: z.infer<typeof ToolExecutionEnd> }
  | { kind: "agent_settled"; aborted: boolean }
  | { kind: "ui_request"; record: ExtensionUiRequest }
  | { kind: "other"; type: string };

/** Classify one decoded record. Records that fail a schema degrade to `other`, never throw. */
export function classify(record: unknown): PiEvent {
  const type =
    record && typeof record === "object" && "type" in record
      ? String((record as { type: unknown }).type)
      : "";
  switch (type) {
    case "response": {
      const r = RpcResponse.safeParse(record);
      return r.success ? { kind: "response", record: r.data } : { kind: "other", type };
    }
    case "message_end": {
      const msg = (record as { message?: unknown }).message;
      const r = AssistantMessage.safeParse(msg);
      return r.success ? { kind: "assistant_message", message: r.data } : { kind: "other", type };
    }
    case "tool_execution_start": {
      const r = ToolExecutionStart.safeParse(record);
      return r.success ? { kind: "tool_start", record: r.data } : { kind: "other", type };
    }
    case "tool_execution_end": {
      const r = ToolExecutionEnd.safeParse(record);
      return r.success ? { kind: "tool_end", record: r.data } : { kind: "other", type };
    }
    case "agent_settled": {
      const r = AgentSettled.safeParse(record);
      return { kind: "agent_settled", aborted: r.success ? r.data.aborted === true : false };
    }
    case "extension_ui_request": {
      const r = ExtensionUiRequest.safeParse(record);
      return r.success ? { kind: "ui_request", record: r.data } : { kind: "other", type };
    }
    default:
      return { kind: "other", type };
  }
}
