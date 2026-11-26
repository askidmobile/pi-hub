import type net from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/**
 * MCP server transport over an accepted unix socket. The SDK stdio transport works on any
 * Readable/Writable pair (verified in plan phase 0, PD-009); socket close is forwarded.
 */
export function socketTransport(socket: net.Socket): StdioServerTransport {
  const transport = new StdioServerTransport(socket, socket);
  socket.on("close", () => void transport.close());
  return transport;
}
