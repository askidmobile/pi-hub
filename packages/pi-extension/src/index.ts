/**
 * Pi extension loaded into every worker via `pi -ne -e <this file>` (ADR-0011).
 * Pi loads it from source with jiti; `@earendil-works/pi-coding-agent` and `typebox`
 * are provided by Pi at runtime (types: ./pi-types.d.ts).
 *
 * - `report_assumption`: the hub reads assumptions from the `tool_execution_start` events
 *   of this tool; the tool itself just acknowledges.
 * - `ask` (stage 2, ADR-0005): an Extension UI `input` dialog whose title carries the
 *   `pi-hub:ask` marker and the question as JSON. Over Pi RPC the hub receives it as
 *   `extension_ui_request`, keeps the task in `needs_input` and answers with
 *   `extension_ui_response`. No timeout: the architect may answer much later.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const REPORT_ASSUMPTION_TOOL = "report_assumption";
export const ASK_TOOL = "ask";
/** Must match ASK_MARKER in packages/hub/src/tasks/questions.ts. */
export const ASK_MARKER = "pi-hub:ask";

export const NO_ANSWER =
  "No answer from the architect. Decide yourself, record the decision with report_assumption and continue.";

export default function piHubExtension(pi: ExtensionAPI): void {
  pi.registerTool<{ text: string }>({
    name: REPORT_ASSUMPTION_TOOL,
    label: "Report assumption",
    description:
      "Record a non-critical decision you made on your own (e.g. a default value or naming choice) so the architect can review it. Then continue working.",
    parameters: Type.Object({
      text: Type.String({
        description: "The decision, in one sentence",
        minLength: 3,
        maxLength: 500,
      }),
    }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: "text", text: `Recorded: ${params.text}` }],
        details: {},
      };
    },
  });

  pi.registerTool<{ question: string; options?: string[] }>({
    name: ASK_TOOL,
    label: "Ask the architect",
    description:
      "Ask the architect a blocking question and wait for the answer. Only for data schema, public API, deleting data or files, choosing an external dependency, or contradictions in the task. One question at a time.",
    parameters: Type.Object({
      question: Type.String({
        description: "The question with the context needed to answer it",
        minLength: 3,
        maxLength: 4000,
      }),
      options: Type.Optional(
        Type.Array(Type.String({ maxLength: 200 }), {
          description: "Suggested answers; the architect may answer differently",
          maxItems: 6,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const payload = JSON.stringify({
        question: params.question,
        ...(params.options?.length ? { options: params.options } : {}),
      });
      const answer = await ctx.ui.input(`${ASK_MARKER} ${payload}`, "answer", { signal });
      const text = answer?.trim() ? `Answer: ${answer.trim()}` : NO_ANSWER;
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
