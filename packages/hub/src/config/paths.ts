import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** macOS `sun_path` is 104 bytes including the terminator; keep a margin. */
export const MAX_SOCKET_PATH_BYTES = 100;

/** Every filesystem location the hub uses, derived from one home directory. */
export interface HubPaths {
  home: string;
  config: string;
  env: string;
  db: string;
  socket: string;
  lock: string;
  logsDir: string;
  hubLog: string;
  worktreesDir: string;
  sessionsDir: string;
  promptsDir: string;
  /** Manual model prices, USD per 1M tokens (stage 2 FR-116, plan PD-109). */
  prices: string;
  /** PI_CODING_AGENT_DIR for workers (ADR-0011): hub-owned Pi config, never ~/.pi/agent. */
  piAgentDir: string;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve hub paths. `PI_HUB_HOME` overrides the default `~/.pi-hub` (tests, e2e, several hubs).
 * `socketOverride` comes from config `transport.unix_socket`.
 */
export function resolveHubPaths(
  env: NodeJS.ProcessEnv = process.env,
  socketOverride?: string,
): HubPaths {
  const rawHome = env.PI_HUB_HOME ? expandHome(env.PI_HUB_HOME) : join(homedir(), ".pi-hub");
  const home = isAbsolute(rawHome) ? rawHome : resolve(rawHome);
  const socket = socketOverride ? expandHome(socketOverride) : join(home, "hub.sock");
  assertSocketPath(socket);
  const logsDir = join(home, "logs");
  return {
    home,
    config: join(home, "config.yaml"),
    env: join(home, ".env"),
    db: join(home, "hub.db"),
    socket,
    lock: join(home, "hub.lock"),
    logsDir,
    hubLog: join(logsDir, "hub.log"),
    worktreesDir: join(home, "worktrees"),
    sessionsDir: join(home, "sessions"),
    promptsDir: join(home, "prompts"),
    prices: join(home, "prices.yaml"),
    piAgentDir: join(home, "pi-agent"),
  };
}

export class SocketPathTooLongError extends Error {
  constructor(public readonly path: string) {
    super(
      `unix socket path is ${Buffer.byteLength(path)} bytes, limit is ${MAX_SOCKET_PATH_BYTES}: ${path}. ` +
        "Set a shorter PI_HUB_HOME or transport.unix_socket.",
    );
    this.name = "SocketPathTooLongError";
  }
}

export function assertSocketPath(path: string): void {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) throw new SocketPathTooLongError(path);
}
