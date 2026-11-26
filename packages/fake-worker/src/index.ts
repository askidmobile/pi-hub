#!/usr/bin/env node
/**
 * Fake worker: speaks the subset of the Pi RPC protocol pi-hub uses, so the hub can be
 * tested without models or network (spec FR-033).
 *
 * The scenario is the model id: `--model fake/<scenario>`. Other Pi flags are accepted
 * and ignored, so the hub launches it exactly like `pi`.
 *
 * Single file, erasable TypeScript only: Node runs it directly (`node index.ts`) in tests.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const SCENARIOS = [
  "success",
  "no-summary",
  "no-commit",
  "empty-diff",
  "incomplete",
  "assumption",
  "ai-attribution",
  "expensive",
  "crash",
  "hang",
] as const;
export type Scenario = (typeof SCENARIOS)[number];

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const modelArg = argValue("--model") ?? "fake/success";
const scenario = (modelArg.split("/")[1]?.split(":")[0] ?? "success") as Scenario;
const sessionDir = argValue("--session-dir") ?? process.cwd();
const sessionName = argValue("--name") ?? "fake";
const sessionFile = join(sessionDir, `${sessionName}.jsonl`);

let lastText: string | null = null;
let running = false;
let aborted = false;
let resumedFrom: string | null = null;

function out(record: unknown): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function respond(id: string | undefined, command: string, data?: unknown, error?: string): void {
  out(
    error
      ? { id, type: "response", command, success: false, error }
      : { id, type: "response", command, success: true, data },
  );
}

function assistant(text: string, cost: number, input = 1200, output = 40): void {
  out({ type: "message_start", message: { role: "assistant", content: [] } });
  out({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "fake",
      model: scenario,
      stopReason: "stop",
      durationMs: 5,
      content: [{ type: "text", text }],
      usage: {
        input,
        output,
        cacheRead: 600,
        cacheWrite: 0,
        totalTokens: input + output + 600,
        cost: { total: cost, totalFromProvider: false },
      },
    },
  });
  lastText = text;
}

function git(args: string[]): void {
  execFileSync("git", args, { cwd: process.cwd(), stdio: "ignore" });
}

function writeHello(): void {
  writeFileSync(join(process.cwd(), "hello.txt"), "hello from pi-hub\n");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function settle(): void {
  running = false;
  out({ type: "agent_end", messages: [], willRetry: false });
  out({ type: "agent_settled", aborted });
}

async function runScenario(): Promise<void> {
  running = true;
  aborted = false;
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  await sleep(10);
  switch (scenario) {
    case "crash":
      process.stderr.write("fake worker: simulated crash\n");
      process.exit(1);
      return;
    case "hang":
      return; // never settles; only abort or stop ends it
    case "expensive":
      for (let i = 0; i < 20 && !aborted; i++) {
        assistant(`step ${i}`, 1.5);
        await sleep(30);
      }
      break;
    case "empty-diff":
      assistant("Nothing needed to change.\n\nSUMMARY:\n- No changes required.", 0.001);
      break;
    case "no-commit":
      writeHello();
      assistant("Created hello.txt.\n\nSUMMARY:\n- Added hello.txt (not committed).", 0.001);
      break;
    case "ai-attribution":
      writeHello();
      git(["add", "-A"]);
      git([
        "commit",
        "-q",
        "-m",
        "Add hello.txt\n\nCo-authored-by: Claude <noreply@anthropic.com>",
      ]);
      assistant("Done.\n\nSUMMARY:\n- Added hello.txt.", 0.001);
      break;
    case "assumption":
      out({
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "report_assumption",
        args: { text: "Password length is at least 10 characters" },
      });
      out({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "report_assumption",
        isError: false,
        result: { content: [{ type: "text", text: "recorded" }] },
      });
      writeHello();
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "Add hello.txt"]);
      assistant("Done.\n\nSUMMARY:\n- Added hello.txt.", 0.001);
      break;
    default: {
      // success, no-summary, incomplete
      writeHello();
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "Add hello.txt"]);
      const text =
        scenario === "no-summary"
          ? "Created hello.txt and committed it."
          : scenario === "incomplete"
            ? "Partially done, TODO: add tests.\n\nSUMMARY:\n- Added hello.txt, tests not written."
            : `Done${resumedFrom ? " (resumed)" : ""}.\n\nSUMMARY:\n- Added hello.txt and committed it.`;
      assistant(text, 0.001);
    }
  }
  if (running) settle();
}

async function handle(cmd: { id?: string; type?: string; [k: string]: unknown }): Promise<void> {
  const { id, type = "" } = cmd;
  switch (type) {
    case "get_state":
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(sessionFile, "", { flag: "a" });
      respond(id, type, { sessionFile, sessionId: sessionName, isStreaming: running });
      return;
    case "get_available_models":
      respond(id, type, { models: SCENARIOS.map((s) => ({ id: s, provider: "fake" })) });
      return;
    case "prompt":
      respond(id, type, { disposition: "started" });
      void runScenario();
      return;
    case "follow_up":
      respond(id, type, { disposition: "queued" });
      running = true;
      out({ type: "agent_start" });
      assistant("SUMMARY:\n- Added hello.txt and committed it.", 0.0005, 300, 20);
      settle();
      return;
    case "get_last_assistant_text":
      respond(id, type, { text: lastText });
      return;
    case "abort":
      aborted = true;
      if (running) settle();
      respond(id, type);
      return;
    case "switch_session":
      resumedFrom = String(cmd.sessionPath ?? "");
      respond(id, type, { cancelled: false });
      return;
    default:
      respond(id, type, undefined, `fake worker: unsupported command ${type}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      out({ type: "response", command: "parse", success: false, error: "bad json" });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
