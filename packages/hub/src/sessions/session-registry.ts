import type { ClientKind, DelegationMode } from "@pi-hub/protocol";
import { loadProjectConfig } from "../config/load.js";
import { CLIENT_DEFAULTS, type HubConfig } from "../config/schema.js";
import type { ProjectRow, Repos, SeniorSessionRow } from "../storage/repos.js";
import { gitTopLevel, remoteUrl } from "../workspaces/repo.js";

/**
 * Senior sessions (spec FR-004, FR-006): one per shim connection, keyed by the agent's PID
 * (ADR-0007; no client_session_id in stage 1). Mode precedence, narrowest wins:
 * project `.pi-hub.toml` > client default (`delegation_on_connect`) > global default.
 */
export class SessionRegistry {
  constructor(
    private readonly repos: Repos,
    private readonly config: HubConfig,
  ) {}

  async connect(hello: {
    client: ClientKind;
    parent_pid: number;
    cwd: string;
  }): Promise<{ session: SeniorSessionRow; project: ProjectRow | null }> {
    const root = await gitTopLevel(hello.cwd);
    const project = root ? this.repos.upsertProject(root, await remoteUrl(root)) : null;
    const mode = this.initialMode(hello.client, root);
    const session = this.repos.createSession({
      client: hello.client,
      parent_pid: hello.parent_pid,
      project_id: project?.id ?? null,
      mode,
    });
    return { session, project };
  }

  initialMode(client: ClientKind, repoRoot: string | null): DelegationMode {
    if (repoRoot) {
      const project = loadProjectConfig(repoRoot);
      if (project.delegation) return project.delegation;
    }
    const clientRule = { ...CLIENT_DEFAULTS[client], ...this.config.clients[client] };
    if (clientRule.delegation_on_connect) return "on";
    return this.config.delegation_default;
  }

  get(sessionId: string): SeniorSessionRow | undefined {
    return this.repos.getSession(sessionId);
  }

  setMode(sessionId: string, mode: DelegationMode): void {
    this.repos.setSessionMode(sessionId, mode);
  }

  touch(sessionId: string): void {
    this.repos.touchSession(sessionId);
  }
}
