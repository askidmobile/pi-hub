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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  "ask",
  "ask-twice",
  "clarify",
  "clarify-edit",
  "text-question",
  "foreign-dialog",
  "quality-fix",
  "quality-broken",
  "skip-test",
  "zero-cost",
  "markdown-summary",
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
let turn = 0;
let lastPrompt = "";
let dialogSeq = 0;
const dialogs = new Map<string, (value: string | undefined) => void>();

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

/** The `ask` tool of the pi-hub extension as Pi RPC shows it: tool start, dialog, tool end. */
async function ask(question: string, options?: string[]): Promise<string | undefined> {
  const id = `dlg-${++dialogSeq}`;
  const callId = `ask-${dialogSeq}`;
  out({ type: "tool_execution_start", toolCallId: callId, toolName: "ask", args: { question } });
  const payload = JSON.stringify(options ? { question, options } : { question });
  const answer = new Promise<string | undefined>((resolve) => dialogs.set(id, resolve));
  out({
    type: "extension_ui_request",
    id,
    method: "input",
    title: `pi-hub:ask ${payload}`,
    placeholder: "answer",
  });
  const value = await answer;
  out({
    type: "tool_execution_end",
    toolCallId: callId,
    toolName: "ask",
    isError: false,
    result: { content: [{ type: "text", text: value ? `Answer: ${value}` : "No answer" }] },
  });
  return value;
}

function commitFile(name: string, content: string, message: string): void {
  writeFileSync(join(process.cwd(), name), content);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", message]);
}

function settle(): void {
  running = false;
  out({ type: "agent_end", messages: [], willRetry: false });
  out({ type: "agent_settled", aborted });
}

async function runScenario(): Promise<void> {
  running = true;
  aborted = false;
  turn++;
  out({ type: "agent_start" });
  out({ type: "turn_start" });
  await sleep(10);
  switch (scenario) {
    case "ask": {
      const a = await ask("Which storage should sessions use?", ["A: Redis", "B: database table"]);
      if (aborted) return;
      commitFile("answer.txt", `${a ?? "none"}\n`, "Add answer.txt");
      assistant(`Done.\n\nSUMMARY:\n- Stored the answer: ${a ?? "none"}.`, 0.001);
      break;
    }
    case "ask-twice": {
      const a = await ask("First question?");
      if (aborted) return;
      const b = await ask("Second question?", ["yes", "no"]);
      if (aborted) return;
      commitFile("answer.txt", `${a}\n${b}\n`, "Add answer.txt");
      assistant(`Done.\n\nSUMMARY:\n- Answers: ${a}, ${b}.`, 0.001);
      break;
    }
    case "clarify":
    case "clarify-edit": {
      if (!lastPrompt.startsWith("PLAN PHASE")) {
        assistant("Not in plan phase.\n\nSUMMARY:\n- Nothing.", 0.001);
        break;
      }
      if (scenario === "clarify-edit") writeFileSync(join(process.cwd(), "draft.txt"), "draft\n");
      const a = await ask("Plan:\n1. Create hello.txt\n2. Commit\nQuestions: which greeting?");
      if (aborted) return;
      commitFile("hello.txt", `${a}\n`, "Add hello.txt");
      assistant(`Done.\n\nSUMMARY:\n- Added hello.txt with: ${a}.`, 0.001);
      break;
    }
    case "foreign-dialog": {
      const id = `dlg-${++dialogSeq}`;
      const reply = new Promise<string | undefined>((resolve) => dialogs.set(id, resolve));
      out({ type: "extension_ui_request", id, method: "confirm", title: "Allow?", message: "x" });
      const v = await reply;
      commitFile("dialog.txt", `${v === undefined ? "refused" : v}\n`, "Add dialog.txt");
      assistant("Done.\n\nSUMMARY:\n- Dialog handled.", 0.001);
      break;
    }
    // Quality scenarios: the project check fails while `broken.txt` exists. An escalation
    // message (stage 3) is handled like the fix round: quality-fix repairs, quality-broken not.
    case "quality-fix":
    case "quality-broken":
      if (
        !lastPrompt.startsWith("The quality check failed") &&
        !lastPrompt.startsWith("ESCALATION:")
      ) {
        writeHello();
        commitFile("broken.txt", "breaks the check\n", "Add hello.txt and broken.txt");
        assistant("Done.\n\nSUMMARY:\n- Added hello.txt.", 0.001);
      } else if (scenario === "quality-fix") {
        if (existsSync(join(process.cwd(), "broken.txt"))) git(["rm", "-q", "broken.txt"]);
        git(["commit", "-q", "-m", "Remove broken.txt"]);
        assistant("Fixed.\n\nSUMMARY:\n- Removed broken.txt, the check passes.", 0.001);
      } else {
        assistant("I could not fix it.\n\nSUMMARY:\n- The check still fails.", 0.001);
      }
      break;
    case "markdown-summary":
      // gpt-oss style: the summary line is bold markdown (plan PD-209)
      writeHello();
      commitFile("md.txt", "md\n", "Add hello.txt and md.txt");
      assistant("All done.\n\n**SUMMARY:**\n- Added hello.txt and md.txt.", 0.001);
      break;
    case "zero-cost":
      // a provider without prices: Pi reports cost 0 (stage 2 FR-116)
      writeHello();
      commitFile("zero.txt", "zero\n", "Add hello.txt and zero.txt");
      assistant("Done.\n\nSUMMARY:\n- Added files.", 0, 1_000_000, 100_000);
      break;
    case "skip-test":
      mkdirSync(join(process.cwd(), "src"), { recursive: true });
      commitFile("src/math.test.ts", 'it.skip("adds", () => {});\n', "Skip the failing math test");
      assistant("Done.\n\nSUMMARY:\n- Skipped a test.", 0.001);
      break;
    case "text-question":
      if (turn === 1) {
        assistant("I looked at the repo.\n\nShould the file be named a.txt or b.txt?", 0.001);
        break;
      }
      commitFile("named.txt", `${lastPrompt}\n`, "Add named.txt");
      assistant(`Done.\n\nSUMMARY:\n- Created the file after the answer: ${lastPrompt}.`, 0.001);
      break;
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
      respond(id, type, {
        // a catalog price, like Pi's models.json (doctor shows the price source)
        models: SCENARIOS.map((s) => ({ id: s, provider: "fake", cost: { input: 1, output: 2 } })),
      });
      return;
    case "prompt":
      lastPrompt = String(cmd.message ?? "");
      respond(id, type, { disposition: "started" });
      if (lastPrompt.startsWith("Write your final summary now")) {
        running = true;
        out({ type: "agent_start" });
        assistant("SUMMARY:\n- Added hello.txt and committed it.", 0.0005, 300, 20);
        settle();
        return;
      }
      void runScenario();
      return;
    case "follow_up":
      // like Pi: after agent_settled a follow-up is only queued and never runs on its own
      respond(id, type, { disposition: "queued" });
      return;
    case "get_last_assistant_text":
      respond(id, type, { text: lastText });
      return;
    case "abort":
      aborted = true;
      for (const resolve of dialogs.values()) resolve(undefined);
      dialogs.clear();
      if (running) settle();
      respond(id, type);
      return;
    case "extension_ui_response": {
      // no command response, like Pi
      const resolve = dialogs.get(String(id));
      dialogs.delete(String(id));
      resolve?.(cmd.cancelled ? undefined : String(cmd.value ?? ""));
      return;
    }
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
