/**
 * MCP mode of pi-hub-shim (ADR-0002, spec FR-002): one tiny process per senior session.
 * stdio MCP <-> hub unix socket. Sends a Hello line, then copies bytes both ways.
 * If the hub is not running it starts `pi-hub serve` detached and retries for up to 3 s.
 * If the hub stays unreachable it serves a stub MCP server with `architect_mode` that
 * explains the problem, so the senior's session is never blocked.
 * No business logic and no keys here.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { type ClientKind, PROTOCOL_VERSION } from "@pi-hub/protocol";
import { socketPath } from "./paths.js";

const CONNECT_BUDGET_MS = 3_000;
const ACK_TIMEOUT_MS = 3_000;
const RETRY_MS = 100;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function serveCommand(): string[] {
  const raw = process.env.PI_HUB_SERVE_COMMAND;
  if (raw) {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string") && parsed.length)
      return parsed;
  }
  return ["pi-hub", "serve"];
}

function tryConnect(path: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const s = net.connect(path);
    s.once("connect", () => resolve(s));
    s.once("error", () => resolve(null));
  });
}

function startDaemon(): void {
  const [cmd, ...args] = serveCommand();
  try {
    const child = spawn(cmd as string, args, {
      detached: true,
      stdio: "ignore",
      cwd: homedir(),
      env: process.env,
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* reported by the stub */
  }
}

async function connectWithAutostart(path: string): Promise<net.Socket | null> {
  const deadline = Date.now() + CONNECT_BUDGET_MS;
  let started = false;
  for (;;) {
    const s = await tryConnect(path);
    if (s) return s;
    if (!started) {
      startDaemon();
      started = true;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

/** Sends Hello and reads one line. Resolves the ack (plus bytes that followed it) or a reject reason. */
function handshake(
  socket: net.Socket,
  client: ClientKind,
): Promise<{ ok: true; rest: Buffer } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, message: "pi-hub did not answer the handshake" });
    }, ACK_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      cleanup();
      socket.pause();
      try {
        const msg = JSON.parse(buf.subarray(0, nl).toString("utf8")) as {
          type?: string;
          message?: string;
        };
        if (msg.type === "hello_ack") resolve({ ok: true, rest: buf.subarray(nl + 1) });
        else resolve({ ok: false, message: msg.message ?? "pi-hub rejected the connection" });
      } catch {
        resolve({ ok: false, message: "pi-hub sent an invalid handshake" });
      }
    };
    const onClose = () => {
      cleanup();
      resolve({ ok: false, message: "pi-hub closed the connection" });
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.on("close", onClose);
    socket.write(
      `${JSON.stringify({
        type: "hello",
        protocol_version: PROTOCOL_VERSION,
        client,
        parent_pid: process.ppid,
        pid: process.pid,
        cwd: process.env.PI_HUB_PROJECT_DIR || process.cwd(),
      })}\n`,
    );
  });
}

/** Stub server: keeps the senior's session healthy and tells it what is wrong. */
async function serveStub(reason: string): Promise<void> {
  const server = new McpServer({ name: "pi-hub", version: "0.1.0" });
  server.registerTool(
    "architect_mode",
    { description: "Turn pi-hub delegation on/off for this session (only when the user asks)." },
    async () => ({
      isError: true,
      content: [
        { type: "text", text: `pi-hub недоступен: ${reason}. Запустите \`pi-hub doctor\`.` },
      ],
    }),
  );
  await server.connect(new StdioServerTransport());
  // main() paused stdin while connecting; a 'data' listener does not undo an explicit pause.
  process.stdin.resume();
}

async function main(): Promise<void> {
  const client = (argValue("--client") ?? "mcp") as ClientKind;
  process.stdin.pause();
  const socket = await connectWithAutostart(socketPath());
  if (!socket) return serveStub("хаб не запущен и не стартовал за 3 с");
  const hs = await handshake(socket, client);
  if (!hs.ok) {
    socket.destroy();
    return serveStub(hs.message);
  }
  if (hs.rest.length) process.stdout.write(hs.rest);
  socket.pipe(process.stdout);
  process.stdin.pipe(socket);
  process.stdin.resume();
  socket.resume();
  socket.on("close", () => process.exit(0));
  socket.on("error", () => process.exit(0));
  process.stdin.on("end", () => socket.end());
}

void main();
