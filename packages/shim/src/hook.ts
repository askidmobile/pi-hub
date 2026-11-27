/**
 * `pi-hub-shim hook stop` (stage 2 spec FR-109, FR-110; plan PD-102, PD-111).
 * Reads the hook JSON from stdin, asks the hub one `hook_query` over the socket and prints
 * `{"decision":"block","reason":…}` when the hub says so. Any failure (no hub, timeout,
 * bad input) prints nothing and exits 0: the senior is never blocked by a broken hook.
 * The whole run stays within ~80 ms; failures go to `<hub home>/logs/hooks.log`.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@pi-hub/protocol/version";
import { hubHome, socketPath } from "./paths.js";

const BUDGET_MS = 80;
const STDIN_MS = 30;

interface HookInput {
  cwd?: unknown;
  stop_hook_active?: unknown;
}

interface HookReply {
  type?: string;
  block?: boolean;
  reason?: string;
}

function readStdin(ms: number): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(done, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => {
      data += c;
    });
    process.stdin.once("end", done);
    process.stdin.once("error", done);
  });
}

function ask(query: Record<string, unknown>, ms: number): Promise<HookReply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath());
    let buf = "";
    const timer = setTimeout(
      () => {
        socket.destroy();
        reject(new Error(`хаб не ответил за ${ms} мс`));
      },
      Math.max(1, ms),
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(query)}\n`));
    socket.on("data", (c: string) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as HookReply);
      } catch {
        reject(new Error("хаб прислал неверный ответ"));
      }
    });
    socket.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function logFailure(error: string): void {
  try {
    const dir = join(hubHome(), "logs");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, "hooks.log"),
      `${JSON.stringify({ time: new Date().toISOString(), source: "shim", pid: process.pid, decision: "pass", why: error })}\n`,
    );
  } catch {
    // nothing else to do
  }
}

function finish(output: string): void {
  if (output) process.stdout.write(output, () => process.exit(0));
  else process.exit(0);
}

export async function runHook(event: string | undefined): Promise<void> {
  const deadline = Date.now() + BUDGET_MS;
  try {
    if (event !== "stop") throw new Error(`неизвестное событие хука: ${event ?? "—"}`);
    const raw = await readStdin(STDIN_MS);
    let input: HookInput = {};
    try {
      input = raw.trim() ? (JSON.parse(raw) as HookInput) : {};
    } catch {
      // keep defaults: the hub still finds the session by PID
    }
    const i = process.argv.indexOf("--client");
    const client = (i >= 0 ? process.argv[i + 1] : undefined) ?? "claude-code";
    const reply = await ask(
      {
        type: "hook_query",
        protocol_version: PROTOCOL_VERSION,
        event: "stop",
        client,
        pid: process.pid,
        cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
        ...(typeof input.stop_hook_active === "boolean"
          ? { stop_hook_active: input.stop_hook_active }
          : {}),
      },
      deadline - Date.now(),
    );
    if (reply.type === "hook_reply" && reply.block && reply.reason) {
      return finish(JSON.stringify({ decision: "block", reason: reply.reason }));
    }
  } catch (e) {
    logFailure((e as Error).message);
  }
  finish("");
}
