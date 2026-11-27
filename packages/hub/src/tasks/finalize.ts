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

/**
 * The SUMMARY line, plain or in markdown (plan PD-209): `SUMMARY:`, `**SUMMARY:**`,
 * `**SUMMARY**:`, `SUMMARY**:`, `## SUMMARY`, `## Summary`.
 */
const SUMMARY_LINE_RE =
  /^[ \t]*(?:(?:\*\*|__)?SUMMARY(?:\*\*|__)?[ \t]*:(?:\*\*|__)?|#{1,6}[ \t]*(?:\*\*)?summary(?:\*\*)?[ \t]*:?[ \t]*$)/im;
const PLAIN_SUMMARY_RE = /^[ \t]*(?:\*\*|__)?SUMMARY(?:\*\*|__)?[ \t]*:(?:\*\*|__)?/m;

function summaryMatch(text: string): RegExpExecArray | null {
  return PLAIN_SUMMARY_RE.exec(text) ?? SUMMARY_LINE_RE.exec(text);
}

export function hasSummaryBlock(text: string | null): boolean {
  return !!text && summaryMatch(text) !== null;
}

/** Text from the SUMMARY line on (or the whole text), collapsed and cut to 500 chars. */
export function extractSummary(text: string | null): string {
  if (!text) return "";
  const m = summaryMatch(text);
  const body = (m ? text.slice(m.index + m[0].length) : text).trim();
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

/**
 * Asks the worker for a summary once; returns the final assistant text. The agent is idle
 * here, so this is a new `prompt`: Pi only queues a `follow_up` sent after `agent_settled`
 * and never runs it (plan PD-209).
 */
export async function ensureSummary(
  client: PiRpcClient,
  timeoutMs = 120_000,
): Promise<string | null> {
  let text = await client.getLastAssistantText();
  if (hasSummaryBlock(text)) return text;
  const settled = client.waitSettled();
  await client.prompt(SUMMARY_FOLLOW_UP);
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

// --- test tampering (stage 2 FR-121) ---

const TEST_FILE_RE =
  /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]+\.py$/;
const SKIP_MARK_RE =
  /\b(describe|it|test|context)\.(skip|only)\b|\bx(it|describe|test)\s*\(|@pytest\.mark\.(skip|xfail)\b|@unittest\.skip|\bt\.Skip(Now|f)?\(|@Disabled\b/;

export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path);
}

/**
 * Files where tests were deleted or skip/only markers were added. The verdict does not
 * change: the warning goes to the architect (D-114).
 */
export function detectTestTampering(
  diff: { status: string; file: string }[],
  added: Map<string, string[]>,
): string[] {
  const files = new Set<string>();
  for (const d of diff) if (d.status === "D" && isTestFile(d.file)) files.add(d.file);
  for (const [file, lines] of added) if (lines.some((l) => SKIP_MARK_RE.test(l))) files.add(file);
  return [...files].sort();
}

export function tamperingWarning(files: string[]): string | null {
  if (!files.length) return null;
  const list = files.slice(0, 5).join(", ") + (files.length > 5 ? ", …" : "");
  return `изменены или отключены тесты: ${list}`;
}

/** The message of the automatic fix round (FR-113). */
export function qualityFixMessage(issues: string[], logPath: string | null): string {
  return [
    "The quality check failed after your work. Fix these problems in the same branch:",
    ...issues.map((i) => `- ${i}`),
    ...(logPath ? [`Full output: ${logPath}`] : []),
    "Do not delete, skip or weaken tests. Commit the fix and end with a `SUMMARY:` block.",
  ].join("\n");
}
