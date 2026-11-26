/**
 * Pi extension loaded into every worker via `pi -ne -e <this file>` (ADR-0011).
 * Pi loads it from source with jiti; `@earendil-works/pi-coding-agent` and `typebox`
 * are provided by Pi at runtime (types: ./pi-types.d.ts).
 *
 * Stage 1: `report_assumption` only. The hub reads assumptions from the
 * `tool_execution_start` events of this tool; the tool itself just acknowledges.
 * Stage 2 adds `ask` (ctx.ui.select / ctx.ui.input over Pi RPC, ADR-0005).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const REPORT_ASSUMPTION_TOOL = "report_assumption";

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
}
