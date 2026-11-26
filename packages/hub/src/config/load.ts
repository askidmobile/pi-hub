import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { ZodError } from "zod";
import { expandHome, type HubPaths, resolveHubPaths } from "./paths.js";
import { HubConfig, ProjectConfig } from "./schema.js";

export class ConfigError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "ConfigError";
  }
}

function formatZod(err: ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

export interface LoadedHub {
  paths: HubPaths;
  config: HubConfig;
}

/** Read ~/.pi-hub/config.yaml (missing file = all defaults), then resolve paths with the socket override. */
export function loadHub(env: NodeJS.ProcessEnv = process.env): LoadedHub {
  const basePaths = resolveHubPaths(env);
  const config = loadHubConfig(basePaths.config);
  const paths = config.transport.unix_socket
    ? resolveHubPaths(env, config.transport.unix_socket)
    : basePaths;
  return { paths, config };
}

export function loadHubConfig(file: string): HubConfig {
  let raw: unknown = {};
  if (existsSync(file)) {
    try {
      raw = parseYaml(readFileSync(file, "utf8")) ?? {};
    } catch (e) {
      throw new ConfigError(file, `invalid YAML: ${(e as Error).message}`);
    }
  }
  const parsed = HubConfig.safeParse(raw);
  if (!parsed.success) throw new ConfigError(file, formatZod(parsed.error));
  const config = parsed.data;
  config.allowed_repos = config.allowed_repos.map((r) => resolve(expandHome(r)));
  if (config.pi.extension_path)
    config.pi.extension_path = resolve(expandHome(config.pi.extension_path));
  return config;
}

/** `.pi-hub.toml` in the repository root; missing file = empty config. */
export function loadProjectConfig(repoRoot: string): ProjectConfig {
  const file = join(repoRoot, ".pi-hub.toml");
  if (!existsSync(file)) return {};
  let raw: unknown;
  try {
    raw = parseToml(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(file, `invalid TOML: ${(e as Error).message}`);
  }
  const parsed = ProjectConfig.safeParse(raw);
  if (!parsed.success) throw new ConfigError(file, formatZod(parsed.error));
  return parsed.data;
}

export interface Secrets {
  /** Provider keys and other secrets. Never copied into process.env (spec FR-011). */
  values: Readonly<Record<string, string>>;
  warnings: string[];
}

/**
 * Minimal dotenv: `KEY=VALUE`, `export KEY=VALUE`, `#` comments, single/double quotes.
 * Empty values are skipped. Warns when the file is readable by group or others.
 */
export function loadSecrets(file: string): Secrets {
  const warnings: string[] = [];
  if (!existsSync(file)) return { values: {}, warnings };
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) {
    warnings.push(`${file} has permissions ${mode.toString(8)}; expected 600`);
  }
  const values: Record<string, string> = {};
  for (const [n, rawLine] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      warnings.push(`${file}:${n + 1}: ignored malformed line`);
      continue;
    }
    const key = m[1] as string;
    let value = (m[2] as string).trim();
    const quoted = /^(['"])(.*?)\1(?:\s+#.*)?$/.exec(value);
    if (quoted) value = quoted[2] as string;
    else value = value.replace(/\s+#.*$/, "");
    if (value) values[key] = value;
  }
  return { values, warnings };
}
