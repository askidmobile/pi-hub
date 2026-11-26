import { chmodSync, existsSync, unlinkSync } from "node:fs";
import net from "node:net";
import { HelloSchema, isCompatible, PROTOCOL_VERSION } from "@pi-hub/protocol";
import type { z } from "zod";

export type HelloMessage = z.infer<typeof HelloSchema>;

import type { Logger } from "pino";

/**
 * Local transport (ADR-0002, FR-001): unix socket with mode 0600. The first line of every
 * connection is a `Hello`; the hub answers `hello_ack` or `hello_reject`. After that the
 * socket carries MCP JSON-RPC lines unchanged (plan PD-006, PD-009).
 */
export type AcceptResult =
  | { ok: true; ack: Record<string, unknown>; onReady: (socket: net.Socket) => void }
  | { ok: false; reason: string; message: string };

export type HelloHandler = (hello: HelloMessage) => Promise<AcceptResult>;

const MAX_HELLO_BYTES = 64 * 1024;
const HELLO_TIMEOUT_MS = 5_000;

export function listenUnix(
  socketPath: string,
  onHello: HelloHandler,
  logger: Logger,
): Promise<net.Server> {
  if (existsSync(socketPath)) unlinkSync(socketPath); // caller holds the daemon lock
  const server = net.createServer((socket) => handle(socket, onHello, logger));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      chmodSync(socketPath, 0o600);
      server.off("error", reject);
      resolve(server);
    });
  });
}

function writeLine(socket: net.Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

function handle(socket: net.Socket, onHello: HelloHandler, logger: Logger): void {
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl < 0) {
      if (buf.length > MAX_HELLO_BYTES) socket.destroy();
      return;
    }
    socket.off("data", onData);
    socket.pause();
    clearTimeout(timer);
    const line = buf.subarray(0, nl).toString("utf8");
    const rest = buf.subarray(nl + 1);
    void accept(line, rest);
  };
  const accept = async (line: string, rest: Buffer) => {
    let hello: HelloMessage;
    try {
      const parsed = HelloSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
      hello = parsed.data;
    } catch (e) {
      writeLine(socket, {
        type: "hello_reject",
        reason: "bad_hello",
        message: (e as Error).message,
      });
      socket.end();
      return;
    }
    if (!isCompatible(hello.protocol_version, PROTOCOL_VERSION)) {
      const major = (v: string) => Number.parseInt(v.split(".")[0] ?? "0", 10);
      const older = major(hello.protocol_version) < major(PROTOCOL_VERSION);
      writeLine(socket, {
        type: "hello_reject",
        reason: "incompatible_protocol",
        message: `protocol ${hello.protocol_version} is not compatible with hub ${PROTOCOL_VERSION}: ${older ? "update the plugin" : "update the hub"}`,
      });
      socket.end();
      return;
    }
    try {
      const res = await onHello(hello);
      if (!res.ok) {
        writeLine(socket, { type: "hello_reject", reason: res.reason, message: res.message });
        socket.end();
        return;
      }
      writeLine(socket, { type: "hello_ack", protocol_version: PROTOCOL_VERSION, ...res.ack });
      res.onReady(socket);
      if (rest.length) socket.unshift(rest);
      socket.resume();
    } catch (e) {
      logger.error({ err: e }, "hello handling failed");
      writeLine(socket, {
        type: "hello_reject",
        reason: "internal",
        message: (e as Error).message,
      });
      socket.end();
    }
  };
  socket.on("data", onData);
  socket.on("error", (err) => logger.debug({ err }, "socket error"));
}
