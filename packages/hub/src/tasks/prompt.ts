import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workerPromptTemplatePath } from "../assets.js";

export interface PromptVars {
  branch: string;
  base_branch: string;
}

/** Replaces `{{name}}` placeholders; unknown placeholders are an error, not silent text. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new Error(`worker prompt: unknown placeholder {{${name}}}`);
    return v;
  });
}

/**
 * Renders the worker rules into `<promptsDir>/<taskId>.md`, passed to Pi with
 * `--append-system-prompt`. The task text itself is sent as the user prompt.
 */
export function writeWorkerPrompt(
  promptsDir: string,
  taskId: string,
  vars: PromptVars,
  templatePath: string = workerPromptTemplatePath(),
): string {
  const text = renderTemplate(readFileSync(templatePath, "utf8"), { ...vars });
  mkdirSync(promptsDir, { recursive: true });
  const file = join(promptsDir, `${taskId}.md`);
  writeFileSync(file, text);
  return file;
}

/**
 * First message of a `clarify` task (stage 2 FR-125, D-108). It lives in the user message,
 * not in the system prompt, because the same Pi session continues into the implementation
 * after the architect answers.
 */
export function planPhaseMessage(taskText: string): string {
  return [
    "PLAN PHASE. Before changing anything, study the code and plan the task below.",
    "Do not create, edit, delete or commit any files in this phase.",
    "Finish the phase with exactly one `ask` call whose question contains your plan",
    "(short numbered steps, files to change) and your open questions.",
    "After you get the answer, implement the task following the plan and the answer.",
    "",
    "TASK:",
    taskText,
  ].join("\n");
}
