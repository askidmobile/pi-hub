import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { loadSecrets } from "../config/load.js";
import { expandHome, type HubPaths, resolveHubPaths } from "../config/paths.js";
import { PINNED_PI_VERSION } from "../config/schema.js";
import { providerKeyEnv } from "../pi-rpc/provider-env.js";
import { findInPath } from "./doctor.js";

/**
 * `pi-hub init` (spec FR-030): creates ~/.pi-hub (config, `.env` 0600, Pi config dir for
 * workers), never overwrites what exists, connects the Claude Code plugin (plan PD-011).
 * The interactive layer only collects InitAnswers; everything else is testable as is.
 */
const run = promisify(execFile);

/** Providers offered first, with a cheap default model each. Any other Pi provider can be typed. */
export const PROVIDER_PRESETS = [
  { provider: "deepseek", model: "deepseek/deepseek-flash" },
  { provider: "zai", model: "zai/glm-5.2" },
  { provider: "moonshotai", model: "moonshotai/kimi-k3" },
  { provider: "openai", model: "openai/gpt-5.6-luna" },
  { provider: "openrouter", model: "openrouter/deepseek/deepseek-flash" },
] as const;

export interface InitAnswers {
  /** `<provider>/<model id>` for the `code` role, which is the default role. */
  model: string;
  /** Provider key; written to `.env` only when that variable is not set there yet. */
  apiKey?: string | undefined;
  allowedRepos: string[];
  piBin?: string | undefined;
}

export type InitAction = { file: string; action: "created" | "kept" | "updated" };

export interface InitResult {
  paths: HubPaths;
  actions: InitAction[];
}

/** Root of the pi-hub repository (the local Claude Code marketplace, PD-011). */
export function repoRoot(): string {
  // dist/cli/init.js -> packages/hub/dist/cli -> repo root is four levels up.
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
}

export function renderConfig(answers: InitAnswers): string {
  const config = {
    delegation_default: "off",
    allowed_repos: answers.allowedRepos,
    pi: { version: PINNED_PI_VERSION, bin: answers.piBin ?? "pi" },
    limits: { max_workers_hub: 2 },
    roles: { code: { model: answers.model } },
    default_role: "code",
    router: { smart: false },
  };
  return [
    "# pi-hub config, written by `pi-hub init`. Reference: config/hub.example.yaml.",
    "# model = <pi provider>/<model id> as in Pi's catalog. Provider keys live in .env.",
    "# The smart router (System One) is configured in stage 3.",
    "# Per-task ceilings are off: add limits.max_task_usd / max_task_minutes to stop runaway workers.",
    stringify(config),
  ].join("\n");
}

/** Applies answers to the hub home. Existing files are kept; `.env` only gains a missing key. */
export function applyInit(answers: InitAnswers, env: NodeJS.ProcessEnv = process.env): InitResult {
  const paths = resolveHubPaths(env);
  const actions: InitAction[] = [];
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  for (const dir of [
    paths.piAgentDir,
    paths.logsDir,
    paths.worktreesDir,
    paths.sessionsDir,
    paths.promptsDir,
  ]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      actions.push({ file: dir, action: "created" });
    }
  }

  if (existsSync(paths.config)) {
    actions.push({ file: paths.config, action: "kept" });
  } else {
    writeFileSync(paths.config, renderConfig(answers), { mode: 0o600 });
    actions.push({ file: paths.config, action: "created" });
  }

  const provider = answers.model.split("/")[0] ?? "";
  const keyVar = providerKeyEnv(provider);
  const line = keyVar && answers.apiKey ? `${keyVar}=${quoteEnv(answers.apiKey)}\n` : undefined;
  if (!existsSync(paths.env)) {
    writeFileSync(paths.env, `# pi-hub secrets. Never commit this file.\n${line ?? ""}`, {
      mode: 0o600,
    });
    chmodSync(paths.env, 0o600);
    actions.push({ file: paths.env, action: "created" });
  } else if (line && keyVar && !loadSecrets(paths.env).values[keyVar]) {
    appendFileSync(paths.env, line);
    actions.push({ file: paths.env, action: "updated" });
  } else {
    actions.push({ file: paths.env, action: "kept" });
  }
  return { paths, actions };
}

function quoteEnv(value: string): string {
  return /^[A-Za-z0-9_\-.:/+=]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

export const PLUGIN_COMMANDS = (root: string): string[][] => [
  ["claude", "plugin", "marketplace", "add", root],
  ["claude", "plugin", "install", "pi-hub@pi-hub-local", "--scope", "user"],
];

/**
 * Connects the Claude Code plugin from the local marketplace (PD-011). Without `claude`
 * in PATH (desktop app only) returns the commands for the user to run.
 */
export async function connectPlugin(
  root = repoRoot(),
): Promise<{ done: boolean; commands: string[]; error?: string }> {
  const cmds = PLUGIN_COMMANDS(root);
  const printable = cmds.map((c) => c.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
  if (!findInPath("claude")) return { done: false, commands: printable };
  for (const [bin, ...args] of cmds) {
    try {
      await run(bin as string, args, { timeout: 60_000 });
    } catch (e) {
      const msg = `${(e as { stderr?: string }).stderr ?? ""}${(e as Error).message}`;
      // Re-running init: the marketplace or the plugin is already there.
      if (/already/i.test(msg)) continue;
      return { done: false, commands: printable, error: msg.split("\n")[0] ?? msg };
    }
  }
  return { done: true, commands: printable };
}

/** Interactive questions (PD-003). Loaded lazily so non-interactive runs do not need a TTY. */
export async function askAnswers(env: NodeJS.ProcessEnv = process.env): Promise<InitAnswers> {
  const { input, password, select } = await import("@inquirer/prompts");
  const provider = await select({
    message: "Провайдер модели воркеров",
    choices: [
      ...PROVIDER_PRESETS.map((p) => ({ name: p.provider, value: p.provider as string })),
      { name: "другой провайдер Pi", value: "" },
    ],
  });
  const chosen = provider || (await input({ message: "Имя провайдера в Pi", required: true }));
  const preset = PROVIDER_PRESETS.find((p) => p.provider === chosen);
  const model = await input({
    message: "Модель по умолчанию (<провайдер>/<id модели>)",
    default: preset?.model ?? `${chosen}/`,
    validate: (v) => /^[^/\s]+\/\S+$/.test(v) || "формат: <провайдер>/<id модели>",
  });
  const keyVar = providerKeyEnv(model.split("/")[0] ?? "");
  const existing = keyVar ? loadSecrets(resolveHubPaths(env).env).values[keyVar] : undefined;
  let apiKey: string | undefined;
  if (keyVar && !existing) {
    apiKey =
      (await password({ message: `Ключ ${keyVar} (хранится в ~/.pi-hub/.env)`, mask: "*" })) ||
      undefined;
  }
  const repos = await input({
    message: "Разрешённые репозитории (пути через запятую)",
    default: process.cwd(),
  });
  return { model, apiKey, allowedRepos: splitRepos(repos) };
}

export function splitRepos(raw: string): string[] {
  return raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => resolve(expandHome(r)));
}

export function formatActions(actions: InitAction[]): string {
  const word = { created: "создан", kept: "оставлен как есть", updated: "дополнен" } as const;
  return actions.map((a) => `  ${a.file} — ${word[a.action]}`).join("\n");
}
