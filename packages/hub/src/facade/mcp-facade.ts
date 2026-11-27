import type {
  McpServer as McpServerType,
  RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  ArchitectModeInput,
  type ClientKind,
  DELEGATION_TOOLS,
  type DelegationTool,
  SendInput,
  StartInput,
  TaskIdInput,
  TOOL_DESCRIPTIONS,
  WaitInput,
} from "@pi-hub/protocol";
import type { Logger } from "pino";
import type { z } from "zod";
import { CLIENT_DEFAULTS, type HubConfig } from "../config/schema.js";
import { HubError } from "../errors.js";
import type { SessionRegistry } from "../sessions/session-registry.js";
import { ACTIVE_STATUSES, type TaskService } from "../tasks/task-service.js";

/**
 * MCP facade (spec FR-005..FR-007, FR-019; ADR-0010): one McpServer per shim connection.
 * - dynamic tool list (Claude Code): while delegation is off only `architect_mode` is
 *   listed; turning it on enables the rest and the SDK sends notifications/tools/list_changed;
 * - static tool list (Codex, unknown clients): every tool is listed; calls are refused while off.
 * Either way the refusal is enforced here and in TaskService, never by the prompt.
 */
export interface FacadeDeps {
  service: TaskService;
  sessions: SessionRegistry;
  config: HubConfig;
  logger: Logger;
}

export const HUB_NAME = "pi-hub";

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export const MAX_PENDING_LINE_BYTES = 300;

/**
 * «ожидают ответа: t_0142 (1 вопрос) — ответьте через send» (stage 2 FR-107), at most 300 bytes;
 * null without open questions.
 */
export function pendingLine(pending: { task_id: string; count: number }[]): string | null {
  if (!pending.length) return null;
  const word = (n: number) =>
    n % 10 === 1 && n % 100 !== 11
      ? "вопрос"
      : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)
        ? "вопроса"
        : "вопросов";
  const head = "ожидают ответа: ";
  const tail = " — ответьте через send";
  const parts: string[] = [];
  for (const [i, p] of pending.entries()) {
    const part = `${p.task_id} (${p.count} ${word(p.count)})`;
    const more = pending.length - i - 1;
    const candidate = [...parts, part].join(", ");
    const suffix = more ? ` и ещё ${more}` : "";
    if (Buffer.byteLength(head + candidate + suffix + tail) > MAX_PENDING_LINE_BYTES) {
      return `${head}${parts.join(", ")} и ещё ${pending.length - i}${tail}`;
    }
    parts.push(part);
  }
  return head + parts.join(", ") + tail;
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function clientRule(config: HubConfig, client: ClientKind) {
  return { ...CLIENT_DEFAULTS[client], ...config.clients[client] };
}

export function createSessionServer(
  deps: FacadeDeps,
  sessionId: string,
  client: ClientKind,
): McpServerType {
  const rule = clientRule(deps.config, client);
  const log = deps.logger.child({ senior_session_id: sessionId });
  const server = new McpServer(
    { name: HUB_NAME, version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  const delegation = new Map<DelegationTool, RegisteredTool>();

  const mode = () => deps.sessions.get(sessionId)?.mode ?? "off";

  /** Wraps a delegation handler: mode check, HubError -> short tool error, unexpected -> logged. */
  const guarded =
    <A>(name: string, fn: (args: A, extra: ToolExtra) => Promise<unknown>) =>
    async (args: A, extra: ToolExtra): Promise<CallToolResult> => {
      deps.sessions.touch(sessionId);
      if (mode() !== "on") {
        return fail(
          "режим архитектора выключен: попросите пользователя включить его (/architect on)",
        );
      }
      try {
        return withPending(ok(await fn(args, extra)));
      } catch (e) {
        if (e instanceof HubError) return fail(e.message);
        log.error({ err: e, tool: name }, "tool failed");
        return fail(`внутренняя ошибка pi-hub: ${(e as Error).message}`);
      }
    };

  /** Every tool response of the session carries the open questions line (FR-107). */
  const withPending = (r: CallToolResult): CallToolResult => {
    const line = pendingLine(deps.service.pendingQuestions(sessionId));
    return line ? { ...r, content: [...r.content, { type: "text", text: line }] } : r;
  };

  const applyMode = (m: "on" | "off") => {
    if (rule.tool_list !== "dynamic") return;
    for (const tool of delegation.values()) {
      if (m === "on" && !tool.enabled) tool.enable();
      if (m === "off" && tool.enabled) tool.disable();
    }
  };

  server.registerTool(
    "architect_mode",
    { description: TOOL_DESCRIPTIONS.architect_mode, inputSchema: ArchitectModeInput.shape },
    async ({ mode: m }) => {
      deps.sessions.setMode(sessionId, m);
      applyMode(m);
      const running = deps.service
        .status(sessionId)
        .filter((t) => ACTIVE_STATUSES.has(t.status))
        .map((t) => t.task_id);
      log.info({ mode: m }, "architect mode changed");
      return withPending(
        ok(
          m === "off" && running.length
            ? {
                mode: m,
                running_tasks: running,
                note: "new tasks are refused; running tasks continue (cancel to stop)",
              }
            : { mode: m, running_tasks: running },
        ),
      );
    },
  );

  const reg = <S extends Record<string, unknown>>(
    name: DelegationTool,
    shape: S,
    fn: (args: never, extra: ToolExtra) => Promise<unknown>,
  ) => {
    const tool = server.registerTool(
      name,
      { description: TOOL_DESCRIPTIONS[name], inputSchema: shape as never },
      guarded(name, fn) as never,
    );
    delegation.set(name, tool);
  };

  reg("start", StartInput.shape, (args: StartArgs) => deps.service.start(sessionId, args));
  reg("wait", WaitInput.shape, (args: WaitArgs, extra) =>
    waitWithProgress(deps.service, sessionId, args, rule, extra),
  );
  reg("status", {}, async () => ({ tasks: deps.service.status(sessionId) }));
  reg("result", TaskIdInput.shape, (args: TaskIdArgs) =>
    deps.service.result(sessionId, args.task_id),
  );
  reg("cancel", TaskIdInput.shape, (args: TaskIdArgs) =>
    deps.service.cancel(sessionId, args.task_id),
  );
  reg("send", SendInput.shape, async (args: SendArgs) =>
    deps.service.send(sessionId, args.task_id, args.message),
  );

  // Initial visibility before connect: no notifications are sent for it.
  if (rule.tool_list === "dynamic" && mode() !== "on") {
    for (const tool of delegation.values()) tool.disable();
  }
  return server;
}

type StartArgs = z.infer<typeof StartInput>;
type WaitArgs = z.infer<typeof WaitInput>;
type TaskIdArgs = z.infer<typeof TaskIdInput>;
type SendArgs = z.infer<typeof SendInput>;

export interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: "notifications/progress";
    params: Record<string, unknown>;
  }) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * `wait` (ADR-0006): long poll capped by the client's tool timeout; progress notifications
 * keep idle timeouts alive while the task runs (Claude Code: every 60 s).
 */
export async function waitWithProgress(
  service: TaskService,
  sessionId: string,
  args: { task_id: string; timeout: number },
  rule: { max_wait_sec: number; progress_every_sec?: number | undefined },
  extra: ToolExtra,
) {
  const capSec = Math.min(args.timeout, rule.max_wait_sec);
  const token = extra._meta?.progressToken;
  let ticker: NodeJS.Timeout | undefined;
  if (token !== undefined && rule.progress_every_sec) {
    const started = Date.now();
    ticker = setInterval(() => {
      const status = service.waitResult(sessionId, args.task_id).status;
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: Math.round((Date.now() - started) / 1000),
            total: capSec,
            message: `${args.task_id}: ${status}`,
          },
        })
        .catch(() => undefined);
    }, rule.progress_every_sec * 1000);
  }
  try {
    const res = await service.waitFor(sessionId, args.task_id, capSec * 1000);
    if (ACTIVE_STATUSES.has(res.status)) return { ...res, hint: "still running: call wait again" };
    if (res.status === "needs_input") {
      return { ...res, hint: "the worker waits: answer with send(task_id, answer)" };
    }
    return res;
  } finally {
    clearInterval(ticker);
  }
}

export { DELEGATION_TOOLS };
