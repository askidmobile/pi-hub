import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HookQuery } from "@pi-hub/protocol";
import { parseJsonList, type QuestionRow, type Repos } from "../storage/repos.js";
import type { HookResolver } from "./hook-resolver.js";

/**
 * The Stop hook decision (stage 2 spec FR-109, FR-110; D-110, plan PD-111):
 * block once per open question of the hook's session while delegation is on; never when
 * Claude Code already continues because of a Stop hook (`stop_hook_active`). Every decision
 * is a line in `logs/hooks.log`.
 */
export const MAX_REASON_CHARS = 1000;

export interface HookDecision {
  block: boolean;
  reason?: string;
}

export class HookService {
  constructor(
    private readonly repos: Repos,
    private readonly resolver: HookResolver,
    private readonly logFile: string,
  ) {}

  async decide(q: HookQuery): Promise<HookDecision> {
    const started = Date.now();
    const res = await this.resolver.resolve(q).catch((e: Error) => ({
      session: null,
      reason: `ошибка поиска сессии: ${e.message}`,
    }));
    const log = (decision: string, extra: Record<string, unknown> = {}) =>
      this.log({
        pid: q.pid,
        cwd: q.cwd,
        client: q.client,
        senior_session_id: res.session?.id,
        decision,
        ms: Date.now() - started,
        ...extra,
      });
    if (!res.session) {
      log("pass", { why: "reason" in res ? res.reason : "" });
      return { block: false };
    }
    if (res.session.mode !== "on") {
      log("pass", { why: "режим выключен" });
      return { block: false };
    }
    if (q.stop_hook_active) {
      log("pass", { why: "stop_hook_active" });
      return { block: false };
    }
    const open = this.repos
      .openQuestionsForSession(res.session.id)
      .filter((x) => !x.hook_delivered_at);
    if (!open.length) {
      log("pass", { why: "нет новых вопросов" });
      return { block: false };
    }
    for (const x of open) this.repos.markHookDelivered(x.id);
    log("block", { questions: open.map((x) => x.id), via: res.via });
    return { block: true, reason: hookReason(open) };
  }

  private log(record: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      appendFileSync(
        this.logFile,
        `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`,
      );
    } catch {
      // logging must never break the hook
    }
  }
}

/** Text for the senior: task, question, options, how to answer; at most 1000 chars. */
export function hookReason(questions: QuestionRow[]): string {
  const parts = questions.map((q) => {
    const options = parseJsonList(q.options_json);
    const text = q.text.replace(/\s+/g, " ").trim();
    return `${q.task_id}: ${text}${options.length ? ` Варианты: ${options.join("; ")}.` : ""}`;
  });
  const head = "Воркер pi-hub ждёт ответа. ";
  const tail = " Ответьте через send(task_id, ответ) или спросите пользователя.";
  let body = parts.join(" | ");
  const room = MAX_REASON_CHARS - head.length - tail.length;
  if (body.length > room) body = `${body.slice(0, room - 1)}…`;
  return head + body + tail;
}
