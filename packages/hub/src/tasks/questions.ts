import type { OpenQuestion } from "@pi-hub/protocol";
import { z } from "zod";
import type { ExtensionUiRequest } from "../pi-rpc/events.js";
import { parseJsonList, type QuestionRow } from "../storage/repos.js";

/**
 * Worker questions (stage 2 spec FR-101..FR-106, FR-120, plan PD-103/PD-104).
 * The `ask` tool of the pi-hub extension opens an Extension UI `input` dialog whose title is
 * `pi-hub:ask <json>`. Any other dialog is refused: the hub is the only "user" of the worker.
 */

/** Must match ASK_MARKER in packages/pi-extension/src/index.ts. */
export const ASK_MARKER = "pi-hub:ask";

/** Extension UI methods that wait for an `extension_ui_response`; the rest are fire-and-forget. */
export const DIALOG_METHODS: ReadonlySet<string> = new Set([
  "select",
  "confirm",
  "input",
  "editor",
]);

const MAX_QUESTION_CHARS = 4000;

const AskPayload = z.object({
  question: z.string().trim().min(1),
  options: z.array(z.string()).max(6).optional(),
});

export interface AskDialog {
  question: string;
  options?: string[];
}

/** The pi-hub question in a dialog request, or null for someone else's dialog. */
export function parseAskDialog(req: ExtensionUiRequest): AskDialog | null {
  if (req.method !== "input" || !req.title?.startsWith(`${ASK_MARKER} `)) return null;
  let json: unknown;
  try {
    json = JSON.parse(req.title.slice(ASK_MARKER.length + 1));
  } catch {
    return null;
  }
  const r = AskPayload.safeParse(json);
  if (!r.success) return null;
  const question = r.data.question.slice(0, MAX_QUESTION_CHARS);
  const options = r.data.options?.filter((o) => o.trim()).map((o) => o.trim());
  return options?.length ? { question, options } : { question };
}

/**
 * A question asked in plain text (FR-120): the final text has no SUMMARY block and its last
 * paragraph ends with "?". Returns that paragraph.
 */
export function detectTextQuestion(finalText: string | null): string | null {
  if (!finalText || /^\s*SUMMARY:/m.test(finalText)) return null;
  const paragraphs = finalText
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const last = paragraphs.at(-1);
  if (!last || !/[?？]\s*$/.test(last)) return null;
  return last.slice(-MAX_QUESTION_CHARS);
}

/**
 * The answer to a question whose Pi dialog no longer exists (hub restart, FR-106; text
 * question, FR-120): sent to the worker as a normal message in the same Pi session.
 */
export function answerAsMessage(question: QuestionRow, answer: string): string {
  if (question.kind === "text") return answer;
  return [
    "Earlier you asked the architect:",
    question.text,
    "",
    `Answer: ${answer}`,
    "",
    "Continue the task with this answer.",
  ].join("\n");
}

/** The question as the senior sees it in `wait`. */
export function toOpenQuestion(q: QuestionRow): OpenQuestion {
  const options = parseJsonList(q.options_json);
  return {
    task_id: q.task_id,
    round: q.round,
    kind: q.kind,
    question: q.text,
    ...(options.length ? { options } : {}),
  };
}
