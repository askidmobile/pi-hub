import type { HubConfig } from "./config/schema.js";

/**
 * Hub daemon entrypoint: opens storage (runs migrations), marks dead `running`
 * tasks as `interrupted`, starts transports (unix socket / HTTP) and the MCP facade.
 * Components live in one Node.js process; Pi workers are child processes.
 */
export async function startDaemon(_config: HubConfig): Promise<void> {
  throw new Error("not implemented: stage 1");
}
