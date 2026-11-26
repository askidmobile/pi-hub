import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { stepFromMessage } from "../src/accounting/accounting.js";
import { classify } from "../src/pi-rpc/events.js";
import { JsonlDecoder } from "../src/pi-rpc/jsonl.js";
import { FIXTURE_SUCCESS } from "./helpers.js";

/** Contract test on a real Pi 1.6.1 RPC session (plan phase 0). Fails if Pi changes the shapes we rely on. */
describe("Pi RPC contract (recorded session)", () => {
  const records = new JsonlDecoder().push(readFileSync(FIXTURE_SUCCESS));
  const events = records.map((r) => {
    expect(r.ok).toBe(true);
    return classify(r.ok ? r.value : null);
  });

  it("classifies the records the hub depends on", () => {
    const kinds = events.map((e) => e.kind);
    expect(kinds.filter((k) => k === "assistant_message")).toHaveLength(3);
    expect(kinds.filter((k) => k === "tool_start")).toHaveLength(2);
    expect(kinds.at(-1) === "agent_settled" || kinds.includes("agent_settled")).toBe(true);
    const prompt = events.find((e) => e.kind === "response" && e.record.command === "prompt");
    expect(prompt && prompt.kind === "response" && prompt.record.success).toBe(true);
  });

  it("assistant messages carry usage with cost, provider, model and duration", () => {
    const steps = events.flatMap((e) =>
      e.kind === "assistant_message" ? [stepFromMessage("t_0001", e.message)] : [],
    );
    expect(steps.every((s) => s !== null)).toBe(true);
    const total = steps.reduce((a, s) => a + (s?.cost ?? 0), 0);
    expect(total).toBeGreaterThan(0);
    expect(steps[0]).toMatchObject({
      provider: "openai-codex",
      model: "gpt-6-luna",
      cost_source: "pi_event",
    });
    expect(steps[0]?.input_tokens).toBeGreaterThan(0);
    expect(typeof steps[0]?.latency_ms).toBe("number");
  });

  it("settles without abort", () => {
    const settled = events.find((e) => e.kind === "agent_settled");
    expect(settled).toEqual({ kind: "agent_settled", aborted: false });
  });
});
