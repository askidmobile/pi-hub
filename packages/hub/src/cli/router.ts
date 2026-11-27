import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { loadHub, loadSecrets } from "../config/load.js";
import type { HubConfig } from "../config/schema.js";
import { type FetchLike, HttpSystemOne } from "../router/system-one/adapter.js";
import { SYSTEM_ONE_PRESETS } from "../router/system-one/presets.js";

/**
 * Smart router setup and checks (stage 3 FR-223, FR-224): `pi-hub router status | test | off`,
 * the router step of `pi-hub init`, the router checks of `doctor`.
 * The config is edited in place (`yaml` Document API keeps comments); the key is never
 * written here — only the name of its variable.
 */
export const RESTART_HINT =
  "изменения вступят в силу после перезапуска хаба: pkill -f 'pi-hub serve' " +
  "(shim поднимет его сам; идущие задачи станут interrupted, их продолжает send)";
export const FAILURES_WARN_AT = 3;

/** What `init` or `router off` writes to `router:` in config.yaml. */
export type RouterAnswers =
  | { smart: false }
  | { smart: true; preset: string; url?: string; model?: string; api_key_env?: string };

/** Presets the adapter speaks (dialect `systemone`), for `init`. */
export const ROUTER_PRESETS = SYSTEM_ONE_PRESETS.filter((p) => p.dialect === "systemone");

export function routerBlock(r: RouterAnswers): Record<string, unknown> {
  if (!r.smart) return { smart: false };
  const s1: Record<string, string> = { preset: r.preset };
  if (r.url) s1.url = r.url;
  if (r.model) s1.model = r.model;
  if (r.api_key_env) s1.api_key_env = r.api_key_env;
  return { smart: true, system_one: s1 };
}

/**
 * Writes the router answers into config.yaml. `off` keeps `system_one` (turning it back on
 * needs no questions); otherwise `router` is replaced. Returns whether the file changed.
 */
export function writeRouterConfig(file: string, r: RouterAnswers): boolean {
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const doc = parseDocument(before);
  if (r.smart) doc.set("router", doc.createNode(routerBlock(r)));
  else doc.setIn(["router", "smart"], false);
  const after = doc.toString();
  if (after === before) return false;
  writeFileSync(file, after, { mode: 0o600 });
  return true;
}

/** System One failures in a row at the end of `logs/router.log`. */
export function failuresInRow(logFile: string): number {
  if (!existsSync(logFile)) return 0;
  const lines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
  let n = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      if ((JSON.parse(lines[i] as string) as { ok?: boolean }).ok !== false) break;
      n++;
    } catch {
      break;
    }
  }
  return n;
}

export interface RouterState {
  on: boolean;
  config: HubConfig["router"];
  keyEnv?: string;
  keySet: boolean;
  roles: number;
  rolesWithoutDescription: string[];
  failuresInRow: number;
}

export function routerState(env: NodeJS.ProcessEnv = process.env): RouterState {
  const { paths, config } = loadHub(env);
  const s1 = config.router.system_one;
  const keyEnv = s1?.api_key_env;
  const roles = Object.entries(config.roles);
  return {
    on: config.router.smart && !!s1,
    config: config.router,
    ...(keyEnv ? { keyEnv } : {}),
    keySet: !keyEnv || !!loadSecrets(paths.env).values[keyEnv],
    roles: roles.length,
    rolesWithoutDescription: roles.filter(([, r]) => !r.description).map(([n]) => n),
    failuresInRow: failuresInRow(join(paths.logsDir, "router.log")),
  };
}

export function formatRouterStatus(s: RouterState): string {
  const s1 = s.config.system_one;
  if (!s1) return "умный роутер: не настроен (pi-hub init --router-preset 9router)";
  const lines = [
    `умный роутер: ${s.on ? "включён" : "выключен"}`,
    `  ${s1.preset} · ${s1.model} · ${s1.url}`,
    `  ключ: ${s.keyEnv ? `${s.keyEnv} ${s.keySet ? "задан" : "не задан в ~/.pi-hub/.env"}` : "не нужен"}`,
    `  порог уверенности ${s1.min_confidence}, таймаут ${s1.timeout_ms} мс`,
    `  роли: ${s.roles}${s.roles < 2 ? " (System One вызывается при двух и больше)" : ""}` +
      (s.rolesWithoutDescription.length
        ? `; без описания: ${s.rolesWithoutDescription.join(", ")}`
        : ""),
  ];
  if (s.failuresInRow) lines.push(`  сбоев подряд: ${s.failuresInRow} (logs/router.log)`);
  return lines.join("\n");
}

/** Sample roles when the table has fewer than two: the test still asks a real choice. */
const SAMPLE_ROLES: Record<string, string> = {
  code: "writing or changing code and its tests",
  docs: "documentation only",
};

export interface RouterTestResult {
  model: string;
  latencyMs: number;
  choice: string;
  confidence: number;
  costUsd?: number;
}

/** `pi-hub router test`: one choice question about a sample task (FR-224). */
export async function routerTest(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): Promise<RouterTestResult> {
  const { paths, config } = loadHub(env);
  const s1 = config.router.system_one;
  if (!s1) throw new Error("умный роутер не настроен: pi-hub init --router-preset 9router");
  const key = s1.api_key_env ? loadSecrets(paths.env).values[s1.api_key_env] : undefined;
  const roles = Object.entries(config.roles);
  const criteria =
    roles.length >= 2
      ? Object.fromEntries(roles.map(([n, r]) => [n, r.description ?? n]))
      : SAMPLE_ROLES;
  const r = await new HttpSystemOne(s1, key, fetchImpl).decide(
    "Task: Add a function `slugify(title)` to src/strings.ts with unit tests.",
    {
      role: {
        type: "choice",
        instructions: "Which role should handle this coding task?",
        criteria,
      },
    },
  );
  const a = r.answers.role;
  if (a?.type !== "choice") throw new Error("в ответе нет выбора роли");
  return {
    model: r.model,
    latencyMs: r.latencyMs,
    choice: a.choice,
    confidence: a.confidence,
    ...(r.usage.costUsd !== undefined ? { costUsd: r.usage.costUsd } : {}),
  };
}

export function formatRouterTest(r: RouterTestResult): string {
  const cost = r.costUsd !== undefined && r.costUsd > 0 ? `${r.costUsd} $` : "цена неизвестна";
  return `System One ${r.model}: ${r.choice} (уверенность ${r.confidence.toFixed(2)}) · ${r.latencyMs} мс · ${cost}`;
}
