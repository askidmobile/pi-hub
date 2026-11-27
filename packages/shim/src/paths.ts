import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.pi-hub` or `PI_HUB_HOME` (same rules as the hub's config/paths.ts). */
export function hubHome(): string {
  return process.env.PI_HUB_HOME?.replace(/^~(?=\/|$)/, homedir()) ?? join(homedir(), ".pi-hub");
}

export function socketPath(): string {
  return process.env.PI_HUB_SOCKET || join(hubHome(), "hub.sock");
}
