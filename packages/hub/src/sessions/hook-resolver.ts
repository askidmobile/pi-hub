import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClientKind } from "@pi-hub/protocol";
import { projectIdFor, type Repos, type SeniorSessionRow } from "../storage/repos.js";
import { gitTopLevel } from "../workspaces/repo.js";

const run = promisify(execFile);

/**
 * Finds the senior session of a hook process (stage 2 spec FR-108, FR-122; D-103, plan
 * PD-107/PD-110). The hook runs as `claude -> sh -> pi-hub-shim hook stop`, and the MCP shim
 * of the same session is a child of the same `claude`: the hub walks up from the hook's PID
 * until it meets the `parent_pid` of a known session. Fallback: the only connected session of
 * that client in the hook's project.
 */
export const MAX_ANCESTORS = 10;

/** pid -> ppid for every process, from one `ps` call (macOS and Linux). */
export async function processTable(): Promise<Map<number, number>> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid="], { timeout: 1_000 });
  const table = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid !== undefined && !Number.isNaN(ppid)) table.set(pid, ppid);
  }
  return table;
}

/** The PID itself and up to 10 ancestors, nearest first; stops at init. */
export function ancestors(pid: number, table: Map<number, number>, max = MAX_ANCESTORS): number[] {
  const out = [pid];
  let cur = pid;
  for (let i = 0; i < max; i++) {
    const parent = table.get(cur);
    if (!parent || parent <= 1 || out.includes(parent)) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

export type HookResolution =
  | { session: SeniorSessionRow; via: "ancestors" | "project" }
  | { session: null; reason: string };

export class HookResolver {
  constructor(
    private readonly repos: Repos,
    /** Sessions with a live shim connection. */
    private readonly isConnected: (sessionId: string) => boolean,
    private readonly table: () => Promise<Map<number, number>> = processTable,
  ) {}

  async resolve(q: { pid: number; cwd: string; client: ClientKind }): Promise<HookResolution> {
    const chain = ancestors(q.pid, await this.table());
    const byPid = this.repos
      .sessionsByParentPids(chain, q.client)
      .filter((s) => this.isConnected(s.id));
    // Nearest ancestor wins; among sessions of one agent process, the most recent.
    for (const pid of chain) {
      const s = byPid.find((x) => x.parent_pid === pid);
      if (s) return { session: s, via: "ancestors" };
    }
    const root = await gitTopLevel(q.cwd);
    if (!root) return { session: null, reason: "сессия хука не определена: cwd вне git" };
    const project = this.repos.getProject(projectIdFor(root));
    const live = project
      ? this.repos.sessionsForProject(project.id, q.client).filter((s) => this.isConnected(s.id))
      : [];
    if (live.length === 1 && live[0]) return { session: live[0], via: "project" };
    return {
      session: null,
      reason: `сессия хука не определена (${live.length} подключённых сессий проекта)`,
    };
  }
}
