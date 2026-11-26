import type { PiProcessSpec } from "./pi-rpc-client.js";
import { providerKeyEnv } from "./provider-env.js";

/**
 * Builds the worker process spec exactly as ADR-0011 prescribes. The environment is
 * rebuilt from an allowlist (spec FR-011): nothing else from the hub's own environment
 * reaches the worker, and only the selected provider's key is added.
 */

/** Variables a coding agent legitimately needs from the user's environment. */
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "LANG",
  "LANGUAGE",
] as const;
const ENV_ALLOW_PREFIXES = ["LC_"] as const;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export class MissingProviderKeyError extends Error {
  constructor(
    public readonly provider: string,
    public readonly envVar: string,
  ) {
    super(`no API key for provider "${provider}": set ${envVar} in ~/.pi-hub/.env`);
    this.name = "MissingProviderKeyError";
  }
}

export interface WorkerLaunchInput {
  /** `pi` binary; for tests a node executable with `binArgs` pointing at the fake worker. */
  bin: string;
  binArgs?: string[];
  provider: string;
  modelId: string;
  thinking?: ThinkingLevel;
  cwd: string;
  sessionDir: string;
  taskId: string;
  extensionPath: string;
  promptFile: string;
  piAgentDir: string;
  secrets: Readonly<Record<string, string>>;
  baseEnv?: NodeJS.ProcessEnv;
}

/** Allowlisted part of an environment: no secrets, no hub or client variables. */
export function allowlistedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (
      (ENV_ALLOWLIST as readonly string[]).includes(k) ||
      ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))
    ) {
      env[k] = v;
    }
  }
  return env;
}

export function workerEnv(input: WorkerLaunchInput): NodeJS.ProcessEnv {
  const env = allowlistedEnv(input.baseEnv ?? process.env);
  env.PI_CODING_AGENT_DIR = input.piAgentDir;
  env.PI_OFFLINE = "1";
  const keyVar = providerKeyEnv(input.provider);
  if (keyVar) {
    const key = input.secrets[keyVar];
    if (!key) throw new MissingProviderKeyError(input.provider, keyVar);
    env[keyVar] = key;
  }
  return env;
}

export function workerArgs(input: WorkerLaunchInput): string[] {
  const model = `${input.provider}/${input.modelId}${input.thinking ? `:${input.thinking}` : ""}`;
  return [
    ...(input.binArgs ?? []),
    "--mode",
    "rpc",
    "--model",
    model,
    "--session-dir",
    input.sessionDir,
    "--name",
    input.taskId,
    "-ne",
    "-e",
    input.extensionPath,
    "-ns",
    "-np",
    "--no-mcp",
    "-na",
    "--append-system-prompt",
    input.promptFile,
  ];
}

export function buildWorkerLaunch(input: WorkerLaunchInput): PiProcessSpec {
  return { command: input.bin, args: workerArgs(input), cwd: input.cwd, env: workerEnv(input) };
}
