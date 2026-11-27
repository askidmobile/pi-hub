import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classify, type ExtensionUiRequest } from "../src/pi-rpc/events.js";
import { JsonlDecoder } from "../src/pi-rpc/jsonl.js";
import type { QuestionRow } from "../src/storage/repos.js";
import {
  ASK_MARKER,
  answerAsMessage,
  detectTextQuestion,
  parseAskDialog,
  toOpenQuestion,
} from "../src/tasks/questions.js";

const FIXTURE_ASK = fileURLToPath(new URL("./fixtures/pi-session-ask.jsonl", import.meta.url));

const req = (over: Partial<ExtensionUiRequest>): ExtensionUiRequest => ({
  type: "extension_ui_request",
  id: "d1",
  method: "input",
  ...over,
});

describe("ask dialog", () => {
  it("parses the marker and JSON; options are optional", () => {
    expect(
      parseAskDialog(req({ title: `${ASK_MARKER} {"question":"Q?","options":["a"," b ",""]}` })),
    ).toEqual({ question: "Q?", options: ["a", "b"] });
    expect(parseAskDialog(req({ title: `${ASK_MARKER} {"question":"Q?"}` }))).toEqual({
      question: "Q?",
    });
  });

  it("returns null for foreign dialogs and broken payloads", () => {
    expect(
      parseAskDialog(req({ method: "confirm", title: `${ASK_MARKER} {"question":"Q"}` })),
    ).toBe(null);
    expect(parseAskDialog(req({ title: "Allow network access?" }))).toBe(null);
    expect(parseAskDialog(req({ title: `${ASK_MARKER} not json` }))).toBe(null);
    expect(parseAskDialog(req({ title: `${ASK_MARKER} {"question":""}` }))).toBe(null);
  });
});

describe("text question (FR-120)", () => {
  it("is the last paragraph ending with ? when there is no SUMMARY", () => {
    expect(detectTextQuestion("Looked around.\n\nShould I use a.txt or b.txt?")).toBe(
      "Should I use a.txt or b.txt?",
    );
    expect(detectTextQuestion("Done?\n\nSUMMARY:\n- did it?")).toBe(null);
    expect(detectTextQuestion("Is this fine? Yes, it is.")).toBe(null);
    expect(detectTextQuestion(null)).toBe(null);
  });
});

describe("question messages", () => {
  const row = (kind: QuestionRow["kind"]): QuestionRow => ({
    id: "q_t_0001_1",
    task_id: "t_0001",
    round: 1,
    kind,
    text: "Redis or table?",
    options_json: '["Redis","table"]',
    critical: 0,
    answer: null,
    answered_by: null,
    asked_at: "",
    answered_at: null,
    pi_dialog_id: null,
    resume_status: "running",
    hook_delivered_at: null,
  });

  it("passes the question and answer as text after a restart; a text question gets the answer as is", () => {
    expect(answerAsMessage(row("question"), "table")).toContain("Redis or table?\n\nAnswer: table");
    expect(answerAsMessage(row("text"), "table")).toBe("table");
  });

  it("shows the senior the question with options", () => {
    expect(toOpenQuestion(row("plan"))).toEqual({
      task_id: "t_0001",
      round: 1,
      kind: "plan",
      question: "Redis or table?",
      options: ["Redis", "table"],
    });
  });
});

/** Contract on a real Pi 1.6.1 session with the ask tool (plan phase 0, PD-112). */
describe("Pi RPC contract: ask", () => {
  const records = new JsonlDecoder()
    .push(readFileSync(FIXTURE_ASK))
    .flatMap((r) => (r.ok ? [r.value] : []))
    // lines the recorder sent to Pi, kept in the fixture for reading
    .filter((v) => !(v && typeof v === "object" && "__sent" in v));
  const events = records.map(classify);

  it("the ask dialog is an input request the hub recognises", () => {
    const ui = events.flatMap((e) => (e.kind === "ui_request" ? [e.record] : []));
    expect(ui).toHaveLength(1);
    expect(parseAskDialog(ui[0] as ExtensionUiRequest)).toEqual({
      question: "What should I name the text file containing `hello`?",
      options: ["a.txt", "b.txt"],
    });
  });

  it("one process settles twice: after the answered ask and after a second prompt", () => {
    expect(events.filter((e) => e.kind === "agent_settled")).toHaveLength(2);
    const askEnd = records.find(
      (r) =>
        (r as { type?: string; toolName?: string }).type === "tool_execution_end" &&
        (r as { toolName?: string }).toolName === "ask",
    );
    expect(JSON.stringify(askEnd)).toContain("Answer: Name the file answer.txt");
  });
});
