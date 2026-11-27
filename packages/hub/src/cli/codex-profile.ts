import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

/**
 * Codex architect profile (stage 3 FR-207, FR-208, FR-210; D-208, D-216; plan PD-201, PD-211).
 * pi-hub owns only the lines between `# >>> pi-hub` and `# <<< pi-hub` in
 * `~/.codex/pi-hub.config.toml`. Codex writes hook trust (`[hooks.state…]`) and trusted
 * folders (`[projects…]`) into the same file, so the rest is never touched; a changed file
 * gets a `.bak` copy first and the result must parse as TOML.
 */
export const BEGIN = "# >>> pi-hub";
export const END = "# <<< pi-hub";
export const PROFILE_NAME = "pi-hub";
export const SHIM_ARGS = ["--client", "codex"] as const;
export const HOOK_COMMAND = "pi-hub-shim hook stop --client codex";

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
}

export function profilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), `${PROFILE_NAME}.config.toml`);
}

/**
 * The pi-hub block: MCP server (wait long-polls up to 870 s, calls approved without asking)
 * and the Stop hook. No SessionStart hook: the hub finds the session by process ancestry.
 */
export function renderBlock(): string {
  return [
    `${BEGIN} (managed by pi-hub init up to the closing marker; edit outside the block)`,
    `[mcp_servers.${PROFILE_NAME}]`,
    'command = "pi-hub-shim"',
    `args = [${SHIM_ARGS.map((a) => `"${a}"`).join(", ")}]`,
    "tool_timeout_sec = 900",
    'default_tools_approval_mode = "approve"',
    "",
    "[[hooks.Stop]]",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = "${HOOK_COMMAND}"`,
    "timeout = 2",
    END,
  ].join("\n");
}

/**
 * Puts the block into the profile text: replaces the existing one, else appends it (tables
 * only, so keys Codex or the user put at the top stay top-level). Refuses a profile that
 * defines pi-hub without markers, broken markers, or a result that does not parse.
 */
export function upsertBlock(text: string | null, block = renderBlock()): string {
  const src = text ?? "";
  const begin = src.indexOf(BEGIN);
  const end = src.indexOf(END, Math.max(begin, 0));
  let out: string;
  if (begin >= 0 || end >= 0) {
    if (begin < 0 || end < begin || src.indexOf(BEGIN, begin + 1) >= 0) {
      throw new ProfileError(`метки ${BEGIN} / ${END} повреждены: поправьте файл вручную`);
    }
    out = src.slice(0, begin) + block + src.slice(end + END.length);
  } else {
    if (src.trim()) {
      const parsed = parseProfile(src);
      if (parsed.mcp_servers && (parsed.mcp_servers as Record<string, unknown>)[PROFILE_NAME]) {
        throw new ProfileError(
          `в профиле уже есть [mcp_servers.${PROFILE_NAME}] без меток: удалите pi-hub из файла и запустите init снова`,
        );
      }
    }
    const sep = !src ? "" : src.endsWith("\n\n") ? "" : src.endsWith("\n") ? "\n" : "\n\n";
    out = `${src}${sep}${block}\n`;
  }
  parseProfile(out);
  return out;
}

function parseProfile(text: string): Record<string, unknown> {
  try {
    return parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ProfileError(
      `профиль не разбирается как TOML: ${(e as Error).message.split("\n")[0]}`,
    );
  }
}

export interface InstallResult {
  path: string;
  action: "created" | "updated" | "kept";
  backup?: string;
}

/** `pi-hub init`: creates the profile or rewrites only the pi-hub block (`.bak` first). */
export function installProfile(env: NodeJS.ProcessEnv = process.env): InstallResult {
  const path = profilePath(env);
  const before = existsSync(path) ? readFileSync(path, "utf8") : null;
  const after = upsertBlock(before);
  if (before === after) return { path, action: "kept" };
  if (before === null) {
    mkdirSync(codexHome(env), { recursive: true, mode: 0o700 });
    writeFileSync(path, after, { mode: 0o600 });
    return { path, action: "created" };
  }
  const backup = `${path}.bak`;
  copyFileSync(path, backup);
  writeFileSync(path, after);
  return { path, action: "updated", backup };
}

export interface ProfileState {
  path: string;
  exists: boolean;
  error?: string;
  /** The MCP server runs `pi-hub-shim --client codex` with the long tool timeout. */
  mcpOk: boolean;
  /** Index of the pi-hub Stop hook as Codex counts it (`stop:<group>:<hook>`). */
  hook?: { group: number; index: number; command: string };
  /** A `trusted_hash` exists for the pi-hub Stop hook. */
  trusted: boolean;
}

type HookGroup = { hooks?: { command?: unknown }[] };

/** `doctor`: what the profile defines and whether Codex trusted the pi-hub hook. */
export function inspectProfile(env: NodeJS.ProcessEnv = process.env): ProfileState {
  const path = profilePath(env);
  const state: ProfileState = { path, exists: existsSync(path), mcpOk: false, trusted: false };
  if (!state.exists) return state;
  let doc: Record<string, unknown>;
  try {
    doc = parseProfile(readFileSync(path, "utf8"));
  } catch (e) {
    return { ...state, error: (e as Error).message };
  }
  const mcp = (doc.mcp_servers as Record<string, Record<string, unknown>> | undefined)?.[
    PROFILE_NAME
  ];
  state.mcpOk =
    !!mcp &&
    typeof mcp.command === "string" &&
    /(^|\/)pi-hub-shim$/.test(mcp.command) &&
    JSON.stringify(mcp.args) === JSON.stringify(SHIM_ARGS) &&
    Number(mcp.tool_timeout_sec) >= 900;
  const hooks = doc.hooks as { Stop?: HookGroup[]; state?: Record<string, unknown> } | undefined;
  (hooks?.Stop ?? []).forEach((g, gi) => {
    (g.hooks ?? []).forEach((h, hi) => {
      if (
        !state.hook &&
        typeof h.command === "string" &&
        h.command.includes("pi-hub-shim hook stop")
      ) {
        state.hook = { group: gi, index: hi, command: h.command };
      }
    });
  });
  if (state.hook) {
    const suffix = `:stop:${state.hook.group}:${state.hook.index}`;
    const paths = new Set([path]);
    try {
      paths.add(realpathSync(path));
    } catch {
      // keep the plain path
    }
    for (const [key, value] of Object.entries(hooks?.state ?? {})) {
      const file = key.slice(0, key.length - suffix.length);
      if (!key.endsWith(suffix) || !paths.has(file)) continue;
      if ((value as { trusted_hash?: unknown }).trusted_hash) state.trusted = true;
    }
  }
  return state;
}
