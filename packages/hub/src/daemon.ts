import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type net from "node:net";
import type { Logger } from "pino";
import { Accounting } from "./accounting/accounting.js";
import { defaultExtensionPath } from "./assets.js";
import { loadHub, loadSecrets } from "./config/load.js";
import type { HubPaths } from "./config/paths.js";
import type { HubConfig } from "./config/schema.js";
import { createSessionServer } from "./facade/mcp-facade.js";
import { createLogger } from "./log.js";
import { SessionRegistry } from "./sessions/session-registry.js";
import { migrate, openDatabase } from "./storage/db.js";
import { Repos } from "./storage/repos.js";
import { pidAlive, TaskService } from "./tasks/task-service.js";
import { socketTransport } from "./transport/socket-transport.js";
import { listenUnix } from "./transport/unix-server.js";
import { GitLock } from "./workspaces/git.js";
import { WorkspaceManager } from "./workspaces/workspace-manager.js";

/**
 * Hub daemon (spec FR-001, FR-022): lock -> logger -> config/secrets -> DB + migrations ->
 * recovery -> socket. One process; Pi workers are children. Only this process writes the DB.
 */
export class AlreadyRunningError extends Error {
  constructor(public readonly pid: number) {
    super(`pi-hub is already running (pid ${pid})`);
    this.name = "AlreadyRunningError";
  }
}

export interface DaemonHandle {
  paths: HubPaths;
  config: HubConfig;
  service: TaskService;
  logger: Logger;
  close(): Promise<void>;
}

/** Exclusive lock file holding our PID; a stale lock of a dead process is taken over. */
export function acquireLock(file: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
        } catch {
          /* already removed */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
      if (Number.isFinite(pid) && pid !== process.pid && pidAlive(pid))
        throw new AlreadyRunningError(pid);
      unlinkSync(file);
    }
  }
  throw new Error(`could not acquire ${file}`);
}

export async function startDaemon(env: NodeJS.ProcessEnv = process.env): Promise<DaemonHandle> {
  const { paths, config } = loadHub(env);
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const releaseLock = acquireLock(paths.lock);
  let server: net.Server | undefined;
  try {
    const secrets = loadSecrets(paths.env);
    const logger = createLogger({ file: paths.hubLog, secrets: Object.values(secrets.values) });
    for (const w of secrets.warnings) logger.warn(w);
    logger.info({ home: paths.home, socket: paths.socket }, "pi-hub starting");

    const db = openDatabase(paths.db);
    const applied = migrate(db);
    if (applied.length) logger.info({ applied }, "migrations applied");
    const repos = new Repos(db);
    const service = new TaskService({
      repos,
      config,
      paths,
      secrets: secrets.values,
      wm: new WorkspaceManager(paths.worktreesDir, new GitLock()),
      accounting: new Accounting(repos),
      logger,
      pi: {
        bin: config.pi.bin,
        binArgs: config.pi.bin_args,
        extensionPath: config.pi.extension_path ?? defaultExtensionPath(),
      },
    });
    const sessions = new SessionRegistry(repos, config);
    service.recover();

    server = await listenUnix(
      paths.socket,
      async (hello) => {
        const { session } = await sessions.connect(hello);
        logger.info(
          {
            senior_session_id: session.id,
            client: hello.client,
            parent_pid: hello.parent_pid,
            shim_pid: hello.pid,
          },
          "senior session connected",
        );
        return {
          ok: true,
          ack: { senior_session_id: session.id, mode: session.mode },
          onReady: (socket) => {
            const mcp = createSessionServer(
              { service, sessions, config, logger },
              session.id,
              hello.client,
            );
            void mcp.connect(socketTransport(socket));
            socket.on("close", () =>
              logger.info({ senior_session_id: session.id }, "senior session disconnected"),
            );
          },
        };
      },
      logger,
    );
    logger.info("pi-hub listening");

    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= (async () => {
        logger.info("pi-hub stopping");
        await service.shutdown();
        await new Promise<void>((r) => server?.close(() => r()) ?? r());
        if (existsSync(paths.socket)) unlinkSync(paths.socket);
        db.close();
        releaseLock();
        logger.info("pi-hub stopped");
      })();
      return closing;
    };
    return { paths, config, service, logger, close };
  } catch (e) {
    server?.close();
    releaseLock();
    throw e;
  }
}
