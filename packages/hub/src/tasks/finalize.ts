import type { PiRpcClient } from "../pi-rpc/pi-rpc-client.js";
import type { WorkspaceManager } from "../workspaces/workspace-manager.js";

/**
 * Finalization after `agent_settled` (spec FR-016, FR-026, FR-027):
 * one follow-up if the worker did not write a SUMMARY block, auto-commit of leftovers,
 * AI attribution check, empty-diff and incompleteness warnings.
 */

export const SUMMARY_MAX_CHARS = 500;
export const SUMMARY_FOLLOW_UP =
  "Write your final summary now. Reply with a block that starts with the line `SUMMARY:` " +
  "followed by at most 5 short bullet points: what changed, which tests were added, open risks. " +
  "Do not change any files.";

const INCOMPLETE_RE =
  /\b(TODO|FIXME|partially|not finished|could not|couldn't|unable to)\b|не успел|частично|не удалось/i;

export function hasSummaryBlock(text: string | null): boolean {
  return !!text && /^\s*SUMMARY:/m.test(text);
}

/** Text from the SUMMARY line on (or the whole text), collapsed and cut to 500 chars. */
export function extractSummary(text: string | null): string {
  if (!text) return "";
  const m = /^\s*SUMMARY:\s*([\s\S]*)$/m.exec(text);
  const body = (m ? (m[1] ?? "") : text).trim();
  const compact = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
  return compact.length > SUMMARY_MAX_CHARS
    ? `${compact.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`
    : compact;
}

export function firstLine(text: string, max = 72): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/^[-*•]\s*/, "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function looksIncomplete(text: string | null): boolean {
  return !!text && INCOMPLETE_RE.test(text);
}

/** Asks the worker for a summary once; returns the final assistant text. */
export async function ensureSummary(
  client: PiRpcClient,
  timeoutMs = 120_000,
): Promise<string | null> {
  let text = await client.getLastAssistantText();
  if (hasSummaryBlock(text)) return text;
  const settled = client.waitSettled();
  await client.followUp(SUMMARY_FOLLOW_UP);
  await Promise.race([
    settled,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("summary follow-up timed out")), timeoutMs),
    ),
  ]);
  text = await client.getLastAssistantText();
  return text;
}

export interface FinalizeResult {
  summary: string;
  warnings: string[];
  changedFiles: string[];
}

export async function finalizeWorkspace(input: {
  wm: WorkspaceManager;
  taskId: string;
  repoRoot: string;
  worktree: string;
  baseCommit: string;
  finalText: string | null;
}): Promise<FinalizeResult> {
  const warnings: string[] = [];
  const summary = extractSummary(input.finalText);
  const sha = await input.wm.autoCommit(
    input.repoRoot,
    input.worktree,
    firstLine(summary) || `Task ${input.taskId}`,
  );
  if (sha) {
    warnings.push(`хаб закоммитил незакоммиченные правки воркера (${sha.slice(0, 7)})`);
  }
  for (const v of await input.wm.attributionViolations(input.worktree, input.baseCommit)) {
    warnings.push(`коммит ${v.sha.slice(0, 7)} содержит подпись ИИ: ${v.lines[0]}`);
  }
  const changedFiles = await input.wm.changedFiles(input.worktree, input.baseCommit);
  if (changedFiles.length === 0) warnings.push("изменений нет");
  if (looksIncomplete(input.finalText)) {
    warnings.push("в итоге воркера есть признаки незавершённой работы");
  }
  if (!summary) warnings.push("воркер не написал итог");
  return { summary, warnings, changedFiles };
}
