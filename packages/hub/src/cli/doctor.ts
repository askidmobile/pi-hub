import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import net from "node:net";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { claudePluginDir, defaultExtensionPath } from "../assets.js";
import { loadHub, loadSecrets } from "../config/load.js";
import type { HubPaths } from "../config/paths.js";
import { PriceBook } from "../config/prices.js";
import type { HubConfig } from "../config/schema.js";
import { PINNED_PI_VERSION } from "../config/schema.js";
import { allowlistedEnv } from "../pi-rpc/launcher.js";
import { type PiModelInfo, PiRpcClient } from "../pi-rpc/pi-rpc-client.js";
import { providerKeyEnv } from "../pi-rpc/provider-env.js";
import { parseModelRef } from "../router/model-resolver.js";

/**
 * `pi-hub doctor` (spec FR-031): config, provider key, pinned Pi version, worker extension,
 * Pi sees the default model (RPC `get_available_models`, no model call), price source of the
 * role models and the Stop hook (stage 2 FR-128), git, shim, daemon.
 * The same checks are the last step of `pi-hub init`.
 */
const run = promisify(execFile);

export type CheckLevel = "ok" | "warn" | "fail";
export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
}

export interface DoctorOptions {
  /** Timeout for the Pi RPC probe. */
  probeTimeoutMs?: number;
}

const ok = (name: string, detail: string): Check => ({ name, level: "ok", detail });
const warn = (name: string, detail: string): Check => ({ name, level: "warn", detail });
const fail = (name: string, detail: string): Check => ({ name, level: "fail", detail });

export async function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
  opts: DoctorOptions = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  let paths: HubPaths;
  let config: HubConfig;
  try {
    ({ paths, config } = loadHub(env));
  } catch (e) {
    return [fail("конфиг", (e as Error).message)];
  }

  if (!existsSync(paths.config)) {
    checks.push(fail("конфиг", `${paths.config} не найден: запустите pi-hub init`));
  } else {
    checks.push(ok("конфиг", paths.config));
  }

  const defaultModel = config.roles[config.default_role]?.model;
  const ref = defaultModel ? parseModelRef(defaultModel) : undefined;
  if (!ref) {
    checks.push(fail("модель по умолчанию", `роль "${config.default_role}" не задана в roles`));
  } else {
    checks.push(ok("модель по умолчанию", `${config.default_role}: ${defaultModel}`));
  }

  const secrets = loadSecrets(paths.env);
  let keyVar: string | undefined;
  let keyValue: string | undefined;
  if (ref) {
    keyVar = providerKeyEnv(ref.provider);
    keyValue = keyVar ? secrets.values[keyVar] : undefined;
    if (!keyVar) checks.push(ok("ключ провайдера", `провайдеру ${ref.provider} ключ не нужен`));
    else if (!keyValue) checks.push(fail("ключ провайдера", `${keyVar} не задан в ${paths.env}`));
    else checks.push(ok("ключ провайдера", `${keyVar} задан`));
  }
  if (existsSync(paths.env) && statSync(paths.env).mode & 0o077) {
    checks.push(warn("права .env", `${paths.env} доступен группе или всем: chmod 600`));
  }

  const piVersion = await piVersionOf(config);
  if (piVersion.error) {
    checks.push(fail("Pi", `${config.pi.bin} не запускается: ${piVersion.error}`));
  } else if (piVersion.version !== config.pi.version) {
    checks.push(
      fail("Pi", `версия ${piVersion.version}, а закреплена ${config.pi.version} (pi.version)`),
    );
  } else {
    checks.push(ok("Pi", `версия ${piVersion.version}`));
  }
  if (config.pi.version !== PINNED_PI_VERSION) {
    checks.push(
      warn("Pi", `pi.version = ${config.pi.version}, хаб проверен с ${PINNED_PI_VERSION}`),
    );
  }

  for (const extension of [
    config.pi.extension_path ?? defaultExtensionPath(),
    ...config.pi.extensions,
  ]) {
    checks.push(
      existsSync(extension)
        ? ok("расширение воркера", extension)
        : fail("расширение воркера", `${extension} не найден`),
    );
  }

  if (ref && !piVersion.error && (!keyVar || keyValue)) {
    const probe = await probeModel(config, paths, ref, secrets.values, opts.probeTimeoutMs);
    checks.push(probe.check);
    if (probe.models) checks.push(...priceSourceChecks(config, probe.models, paths.prices));
  }

  try {
    const { stdout } = await run("git", ["--version"], { timeout: 5_000 });
    checks.push(ok("git", stdout.trim()));
  } catch (e) {
    checks.push(fail("git", (e as Error).message));
  }

  const shim = findInPath("pi-hub-shim", env.PATH);
  checks.push(
    shim
      ? ok("pi-hub-shim", shim)
      : warn("pi-hub-shim", "нет в PATH: выполните pnpm build && pnpm link:bins в репозитории pi-hub"),
  );
  checks.push(await hookCheck(env, shim));

  checks.push(
    (await socketAlive(paths.socket))
      ? ok("демон", `слушает ${paths.socket}`)
      : warn("демон", `не запущен (shim запустит его сам); лог: ${paths.hubLog}`),
  );
  return checks;
}

async function piVersionOf(config: HubConfig): Promise<{ version?: string; error?: string }> {
  try {
    const { stdout, stderr } = await run(config.pi.bin, [...config.pi.bin_args, "--version"], {
      timeout: 15_000,
      env: allowlistedEnv(),
    });
    const m = /\d+\.\d+\.\d+(?:-[\w.]+)?/.exec(`${stdout}\n${stderr}`);
    return m ? { version: m[0] } : { error: `не удалось разобрать версию: ${stdout.trim()}` };
  } catch (e) {
    return { error: (e as Error).message.split("\n")[0] ?? "error" };
  }
}

/** Starts Pi with the hub's isolated config (ADR-0011) and asks which models it can use. */
async function probeModel(
  config: HubConfig,
  paths: HubPaths,
  ref: { provider: string; modelId: string },
  secrets: Readonly<Record<string, string>>,
  timeoutMs = 30_000,
): Promise<{ check: Check; models?: PiModelInfo[] }> {
  const name = "Pi видит модель";
  const env = allowlistedEnv();
  env.PI_CODING_AGENT_DIR = paths.piAgentDir;
  env.PI_OFFLINE = "1";
  // Keys of every role provider, so the price check sees all role models.
  for (const role of Object.values(config.roles)) {
    const keyVar = providerKeyEnv(parseModelRef(role.model).provider);
    const value = keyVar ? secrets[keyVar] : undefined;
    if (keyVar && value) env[keyVar] = value;
  }
  const client = new PiRpcClient({
    command: config.pi.bin,
    args: [
      ...config.pi.bin_args,
      "--mode",
      "rpc",
      "--no-session",
      "-ne",
      ...config.pi.extensions.flatMap((e) => ["-e", e]),
      "-ns",
      "-np",
      "--no-mcp",
      "-na",
    ],
    cwd: paths.home,
    env,
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    client.start();
    const models = await Promise.race([
      client.getAvailableModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`нет ответа за ${timeoutMs} мс`)), timeoutMs);
      }),
    ]);
    const found = models.some((m) => m.provider === ref.provider && m.id === ref.modelId);
    return {
      check: found
        ? ok(name, `${ref.provider}/${ref.modelId}`)
        : fail(
            name,
            `${ref.provider}/${ref.modelId} нет среди доступных (${models.length} моделей); ` +
              "проверьте имя модели и ключ",
          ),
      models,
    };
  } catch (e) {
    return { check: fail(name, (e as Error).message) };
  } finally {
    clearTimeout(timer);
    if (client.pid !== undefined && !client.hasExited) await client.stop(4_000).catch(() => {});
  }
}

/**
 * Where the cost of each role model will come from (stage 2 FR-128, FR-116). Whether the
 * provider reports cost is known only per response, so a catalog price covers both.
 */
export function priceSourceChecks(
  config: Pick<HubConfig, "roles">,
  models: PiModelInfo[],
  pricesFile: string,
): Check[] {
  const book = new PriceBook(pricesFile);
  const name = "цена модели";
  const refs = [...new Set(Object.values(config.roles).map((r) => r.model))];
  return refs.map((model) => {
    const { provider, modelId } = parseModelRef(model);
    if (book.lookup(provider, modelId)) return ok(name, `${model}: ручная цена (prices.yaml)`);
    const info = models.find((m) => m.provider === provider && m.id === modelId);
    if (info && ((info.cost?.input ?? 0) > 0 || (info.cost?.output ?? 0) > 0)) {
      return ok(name, `${model}: каталог Pi или стоимость от провайдера`);
    }
    return warn(
      name,
      `${model}: цена неизвестна, если провайдер не сообщит стоимость; ` +
        `задайте цену в ${pricesFile}`,
    );
  });
}

export const HOOK_BUDGET_MS = 100;

/**
 * The Stop hook of the plugin (stage 2 FR-128): its command is the shim, and the shim answers
 * an empty hook input within 100 ms with exit 0 and no output (best of 3 runs, cold start).
 */
export async function hookCheck(
  env: NodeJS.ProcessEnv,
  shim: string | undefined,
  hooksFile = join(claudePluginDir(), "hooks", "hooks.json"),
): Promise<Check> {
  const name = "хук Stop";
  let command: string | undefined;
  try {
    const cfg = JSON.parse(readFileSync(hooksFile, "utf8")) as {
      hooks?: { Stop?: { hooks?: { command?: string }[] }[] };
    };
    command = cfg.hooks?.Stop?.[0]?.hooks?.[0]?.command;
  } catch (e) {
    return fail(name, `${hooksFile}: ${(e as Error).message}`);
  }
  if (command !== "pi-hub-shim hook stop") {
    return fail(
      name,
      `в ${hooksFile} команда ${command ?? "не задана"}, нужна pi-hub-shim hook stop`,
    );
  }
  if (!shim) return warn(name, "pi-hub-shim нет в PATH: хук не сработает");
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const started = Date.now();
    // A linked bin is a wrapper script; a bare dist/index.js may lack the exec bit.
    const real = realpathSync(shim);
    const r = real.endsWith(".js")
      ? await runWithInput(process.execPath, [real, "hook", "stop"], "{}", env)
      : await runWithInput(shim, ["hook", "stop"], "{}", env);
    const ms = Date.now() - started;
    if (r.code !== 0 || r.stdout.trim()) {
      return fail(name, `pi-hub-shim hook stop: код ${r.code}, вывод ${r.stdout.trim() || "—"}`);
    }
    best = Math.min(best, ms);
  }
  return best <= HOOK_BUDGET_MS
    ? ok(name, `отвечает за ${best} мс`)
    : warn(name, `отвечает за ${best} мс, дольше ${HOOK_BUDGET_MS} мс`);
}

function runWithInput(
  bin: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.on("error", () => resolve({ code: null, stdout }));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout });
    });
    child.stdin.end(input);
  });
}

export function findInPath(bin: string, pathVar = process.env.PATH ?? ""): string | undefined {
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* not here */
    }
  }
  return undefined;
}

function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(path);
    const done = (alive: boolean) => {
      s.destroy();
      resolve(alive);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1_000, () => done(false));
  });
}

const MARK: Record<CheckLevel, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatChecks(checks: Check[]): string {
  return checks.map((c) => `${MARK[c.level]} ${c.name}: ${c.detail}`).join("\n");
}

export function hasFailures(checks: Check[]): boolean {
  return checks.some((c) => c.level === "fail");
}
