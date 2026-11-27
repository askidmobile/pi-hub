#!/usr/bin/env node
/**
 * pi-hub-shim entry. `pi-hub-shim hook stop` is the Stop hook of the platform plugins
 * (stage 2 plan PD-102); anything else is the stdio MCP pipe to the hub. The hook path loads
 * neither the MCP SDK nor zod: it must answer within 100 ms.
 */
if (process.argv[2] === "hook") {
  const { runHook } = await import("./hook.js");
  await runHook(process.argv[3]);
} else {
  await import("./mcp.js");
}
